/**
 * LSP Tool Definitions — definition, references, document symbols, rename.
 *
 * These are the questions a language server answers better than the model can:
 * which definition an import actually resolves to, everything that references a
 * symbol, what a file contains, and the exact edits a rename needs across the
 * workspace. Diagnostics is deliberately absent — the model writes code the
 * compiler accepts; when it does not, `lsp_definition` and friends point at the
 * symbol rather than grading the file.
 *
 * Positions are one-based in the parameters (the number the `read` tool shows)
 * and zero-based on the wire. A value below one is rejected rather than clamped:
 * clamping `line: 0` would silently act on the previous line.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile, writeFile } from "node:fs/promises";
import { LspServerManager, formatToolError } from "./manager.js";
import {
  applyTextEdits,
  flattenDocumentSymbols,
  formatChangeGroups,
  formatDocumentSymbols,
  formatLocationRows,
  limitNotice,
  textInRange,
  type ChangeRow,
} from "./format.js";
import { readLocationRows, symbolAtPosition } from "./locations.js";
import { makeCallRenderer, makeLocationResultRenderer, renderRenameResult, renderSymbolsResult } from "./render.js";
import { isLocalFilePath } from "./uri.js";
import type { LspDocumentSymbol, LspLocation, LspTextEdit } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

// ─── Helpers ───────────────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text" as const, text }], details };
}

function err(details: any): ToolResult {
  return ok(formatToolError(details), { ok: false, error: details });
}

/** Locations → rows → the tool reply.
 *
 * The rows carry the source line and the identifier under the position, so the
 * model can tell a call site from a comment without a second `read`, and the
 * renderer gets the same rows instead of re-reading the files.
 */
async function locationResult(
  locations: readonly LspLocation[],
  options: { cwd?: string; empty: string; symbol?: string; limit?: number },
): Promise<ToolResult> {
  const found = await readLocationRows(locations, { cwd: options.cwd, limit: options.limit });
  let text = formatLocationRows(found.rows, options.empty);
  if (found.omitted > 0) text += `\n\n${limitNotice(found.rows.length, found.total)}`;
  return ok(text, {
    ok: true,
    count: found.rows.length,
    total: found.total,
    files: found.files,
    omitted: found.omitted,
    locations: found.rows,
    ...(options.symbol === undefined ? {} : { symbol: options.symbol }),
  });
}

/** One edit as a row: the text it replaces, the text it writes. */
function changeRow(file: string, text: string, edit: LspTextEdit): ChangeRow {
  return {
    file,
    line: edit.range.start.line + 1,
    character: edit.range.start.character + 1,
    before: textInRange(text, edit.range),
    after: edit.newText,
  };
}

function abortError(signal?: AbortSignal | null): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException("This operation was aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError");
}

function withTimeout(promise: Promise<ToolResult>, ms: number, label: string, signal?: AbortSignal): Promise<ToolResult> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise<ToolResult>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(err({ kind: "tool_timeout", message: `${label} timed out after ${ms}ms` }));
    }, ms);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Run `body`, letting cancellation through and turning anything else into a
 *  tool error. MCP parity: an abort must reject so pi marks the call cancelled. */
async function attempt(file: string, signal: AbortSignal | undefined, body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    return err({ kind: "tool_execution_failed", file, message: error instanceof Error ? error.message : String(error) });
  }
}

/** A one-based line/character is required; anything else is a caller mistake
 *  worth naming, not a value to clamp. */
function positionError(params: { line: number; character: number }): string | undefined {
  for (const field of ["line", "character"] as const) {
    const value = params[field];
    if (!Number.isInteger(value) || value < 1) {
      return `${field} must be a one-based integer, got ${value}. These parameters are one-based; LSP's own positions are not.`;
    }
  }
  return undefined;
}

/** One-based parameters → the zero-based `{ line, character }` LSP wants. */
function toLspPosition(params: { line: number; character: number }) {
  return { line: params.line - 1, character: params.character - 1 };
}

function countSymbols(symbols: LspDocumentSymbol[]): number {
  return symbols.reduce((total, symbol) => total + 1 + countSymbols(symbol.children ?? []), 0);
}

const pathParam = Type.String({ description: "File to query, relative to cwd or absolute." });
const lineParam = Type.Number({ minimum: 1, description: "One-based line of the symbol, the number the read tool shows." });
const characterParam = Type.Number({ minimum: 1, description: "One-based character column on that line." });
const timeoutParam = Type.Number({ description: `Overall max ms including server startup. Default ${DEFAULT_TIMEOUT_MS}.` });
const limitParam = Type.Optional(
  Type.Number({ minimum: 1, description: "Maximum locations to return. Default 100." }),
);

// ─── Register tools ───────────────────────────────────────────────────────

export function registerLspTools(pi: ExtensionAPI, manager: LspServerManager): void {
  const resolve = (path: string, timeoutMs: number, signal?: AbortSignal) =>
    manager.resolveFileState(path, { timeoutMs, signal });

  // ── lsp_definition ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "lsp_definition",
    label: "LSP: definition",
    description: "Find where a symbol is defined, resolved by the language server. Pass a one-based line and character from the file.",
    promptSnippet: "Resolve a symbol's definition through the language server",
    promptGuidelines: [
      "Prefer lsp_definition over grepping for a definition: the server follows imports, re-exports and overloads that a text search misses.",
    ],
    renderCall: makeCallRenderer("LSP: definition"),
    renderResult: makeLocationResultRenderer("definition"),
    parameters: Type.Object({
      path: pathParam,
      line: lineParam,
      character: characterParam,
      timeout_ms: Type.Optional(timeoutParam),
    }),
    execute: async (_id, params, signal, _onUpdate, ctx): Promise<ToolResult> => {
      const bad = positionError(params);
      if (bad) return err({ kind: "invalid_position", file: params.path, message: bad });
      const totalTimeout = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      return withTimeout(attempt(params.path, signal, async () => {
        const resolved = await resolve(params.path, totalTimeout, signal);
        if (!resolved.ok) return err(resolved.error);
        const locations = await resolved.result.state.client.definition(
          resolved.result.uri, toLspPosition(params), totalTimeout, signal,
        );
        return locationResult(locations, {
          cwd: ctx?.cwd,
          empty: `${params.path}: no definition found at ${params.line}:${params.character}`,
          symbol: await symbolAtPosition(resolved.result.abs, params),
        });
      }), totalTimeout, "LSP definition", signal);
    },
  });

  // ── lsp_references ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "lsp_references",
    label: "LSP: references",
    description: "List every reference to a symbol, resolved by the language server. Pass a one-based line and character from the file.",
    promptSnippet: "Find all references to a symbol through the language server",
    promptGuidelines: [
      "Call lsp_references before changing a symbol's signature or meaning: it finds every call site the language server can see, including ones in files you have not opened.",
    ],
    renderCall: makeCallRenderer("LSP: references", (args) => [
      ...(args?.include_declaration === false ? ["no declaration"] : []),
      ...(args?.limit === undefined ? [] : [`limit ${args.limit}`]),
    ]),
    renderResult: makeLocationResultRenderer("reference"),
    parameters: Type.Object({
      path: pathParam,
      line: lineParam,
      character: characterParam,
      include_declaration: Type.Optional(Type.Boolean({ description: "Include the symbol's own declaration. Default true." })),
      limit: limitParam,
      timeout_ms: Type.Optional(timeoutParam),
    }),
    execute: async (_id, params, signal, _onUpdate, ctx): Promise<ToolResult> => {
      const bad = positionError(params);
      if (bad) return err({ kind: "invalid_position", file: params.path, message: bad });
      const totalTimeout = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      return withTimeout(attempt(params.path, signal, async () => {
        const resolved = await resolve(params.path, totalTimeout, signal);
        if (!resolved.ok) return err(resolved.error);
        const locations = await resolved.result.state.client.references(
          resolved.result.uri,
          toLspPosition(params),
          params.include_declaration ?? true,
          totalTimeout,
          signal,
        );
        return locationResult(locations, {
          cwd: ctx?.cwd,
          limit: params.limit,
          empty: `${params.path}: no references found at ${params.line}:${params.character}`,
          symbol: await symbolAtPosition(resolved.result.abs, params),
        });
      }), totalTimeout, "LSP references", signal);
    },
  });

  // ── lsp_document_symbols ───────────────────────────────────────────────
  pi.registerTool({
    name: "lsp_document_symbols",
    label: "LSP: document symbols",
    description: "Outline a file's symbols (classes, functions, properties) with their positions, as the language server sees them.",
    promptSnippet: "Outline a file's symbols through the language server",
    promptGuidelines: [
      "Use lsp_document_symbols to find the line of a symbol before calling lsp_definition, lsp_references or lsp_rename, which need a position.",
    ],
    renderCall: makeCallRenderer("LSP: document symbols"),
    renderResult: renderSymbolsResult,
    parameters: Type.Object({
      path: pathParam,
      timeout_ms: Type.Optional(timeoutParam),
    }),
    execute: async (_id, params, signal, _onUpdate, ctx): Promise<ToolResult> => {
      const totalTimeout = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      return withTimeout(attempt(params.path, signal, async () => {
        const resolved = await resolve(params.path, totalTimeout, signal);
        if (!resolved.ok) return err(resolved.error);
        const symbols = await resolved.result.state.client.documentSymbols(
          resolved.result.uri, totalTimeout, signal,
        );
        return ok(
          formatDocumentSymbols(params.path, symbols),
          {
            ok: true,
            count: countSymbols(symbols),
            top_level: symbols.length,
            symbols: flattenDocumentSymbols(symbols),
          },
        );
      }), totalTimeout, "LSP document symbols", signal);
    },
  });

  // ── lsp_rename ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "lsp_rename",
    label: "LSP: rename",
    description: [
      "Rename a symbol across the workspace using the language server, then write the result to disk.",
      "Pass a one-based line and character of the symbol and the new name.",
      "Set preview to true to get the exact edits without writing anything.",
    ].join(" "),
    promptSnippet: "Rename a symbol everywhere via the language server",
    promptGuidelines: [
      "Prefer lsp_rename over hand-editing a name: the server produces the exact edits across every file that references the symbol.",
      "After an applied rename, read a renamed file again before patching it: the rename changed it on disk.",
      "Get the position from lsp_document_symbols or lsp_references first; a position that holds no symbol returns no edits.",
    ],
    renderCall: makeCallRenderer("LSP: rename", (args) => [
      `→ ${args?.new_name ?? "?"}`,
      ...(args?.preview ? ["preview"] : []),
    ]),
    renderResult: renderRenameResult,
    parameters: Type.Object({
      path: pathParam,
      line: lineParam,
      character: characterParam,
      new_name: Type.String({ minLength: 1, description: "The new symbol name." }),
      preview: Type.Optional(Type.Boolean({ description: "Return the edits without writing them. Default false." })),
      timeout_ms: Type.Optional(timeoutParam),
    }),
    execute: async (_id, params, signal, _onUpdate, ctx): Promise<ToolResult> => {
      const bad = positionError(params) ?? (params.new_name.trim() === "" ? "new_name must not be blank" : undefined);
      if (bad) return err({ kind: "invalid_position", file: params.path, message: bad });
      const totalTimeout = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;

      return withTimeout(attempt(params.path, signal, async () => {
        const resolved = await resolve(params.path, totalTimeout, signal);
        if (!resolved.ok) return err(resolved.error);

        const edits = await resolved.result.state.client.rename(
          resolved.result.uri, toLspPosition(params), params.new_name, totalTimeout, signal,
        );
        const files = Object.keys(edits);
        if (files.length === 0) {
          return ok(
            `${params.path}: no rename edits at ${params.line}:${params.character} — that position holds no renamable symbol.`,
            { ok: true, files: 0, edits: 0 },
          );
        }

        // A `untitled:` or `jdt://` target has no file to write. Refuse the whole
        // rename rather than apply half of it.
        const foreign = files.filter((file) => !isLocalFilePath(file));
        if (foreign.length > 0) {
          return ok(
            `Rename to "${params.new_name}" was not applied: ${foreign.length} target(s) are not local files.\n${foreign.join("\n")}`,
            { ok: false, files: 0, edits: 0, foreign },
          );
        }

        signal?.throwIfAborted?.();

        // Read and compute every file before writing any of them, so a missing
        // file or an out-of-range edit stops the rename with the workspace
        // intact — and so a preview shows the same rows an apply would write.
        const planned: Array<{ file: string; before: string; after: string; rows: ChangeRow[] }> = [];
        try {
          for (const file of files) {
            const before = await readFile(file, "utf-8");
            planned.push({
              file,
              before,
              after: applyTextEdits(before, edits[file]),
              rows: edits[file].map((edit) => changeRow(file, before, edit)),
            });
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return ok(
            `Rename to "${params.new_name}" was not applied: ${reason}\nNo file was written.`,
            { ok: false, files: 0, edits: 0 },
          );
        }

        const flattenRows = (list: Array<{ rows: ChangeRow[] }>) => list.flatMap((plan) => plan.rows);

        if (params.preview) {
          const rows = flattenRows(planned);
          return ok(
            formatChangeGroups(planned.map((plan) => ({ file: plan.file, rows: plan.rows }))),
            {
              ok: true,
              preview: true,
              files: files.length,
              edits: rows.length,
              changes: rows,
              newName: params.new_name,
            },
          );
        }

        // Writing is the only step that can leave a partial result, so the
        // written list goes into the error the model sees.
        const written: Array<{ file: string; rows: ChangeRow[] }> = [];
        const unchanged: string[] = [];
        let applied = 0;
        try {
          for (const plan of planned) {
            if (plan.after === plan.before) {
              unchanged.push(plan.file);
              continue;
            }
            await writeFile(plan.file, plan.after, "utf-8");
            written.push({ file: plan.file, rows: plan.rows });
            applied += plan.rows.length;
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return ok(
            `Rename to "${params.new_name}" stopped after writing ${written.length} file(s): ${reason}\nAlready renamed:\n${written.map((entry) => entry.file).join("\n")}`,
            { ok: false, files: written.length, edits: applied, changes: flattenRows(written), newName: params.new_name },
          );
        }

        const lines = written.map((entry) => `${entry.file} (${entry.rows.length} edit(s))`);
        if (unchanged.length > 0) lines.push(`Unchanged: ${unchanged.join(", ")}`);
        return ok(
          `Renamed to "${params.new_name}": ${applied} edit(s) in ${written.length} file(s).\n${lines.join("\n")}`,
          { ok: true, files: written.length, edits: applied, changes: flattenRows(written), newName: params.new_name },
        );
      }), totalTimeout, "LSP rename", signal);
    },
  });
}

export const __lspToolsTest = { withTimeout };
