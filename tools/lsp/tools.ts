/**
 * LSP Tool Definitions — 2 tools for Pi.
 */
import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { LspServerManager, LspToolError, formatToolError } from "./manager.js";

// ─── TUI rendering ─────────────────────────────────────────────────────────

const LSP_RESULT_FOLD_LINES = 45;

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return lines.slice(0, end);
}

function collapseText(text: string, maxLines = LSP_RESULT_FOLD_LINES) {
  const lines = trimTrailingEmptyLines(text.split("\n"));
  const totalLines = lines.length;
  const displayLines = lines.slice(0, maxLines);
  const remainingLines = Math.max(0, totalLines - maxLines);
  return { totalLines, displayLines, remainingLines };
}

function getTextContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? []).filter((c): c is { type: "text"; text?: string } => c.type === "text").map((c) => c.text ?? "").join("\n");
}

function formatResultText(text: string, expanded: boolean, theme: any): string {
  const { totalLines, displayLines, remainingLines } = collapseText(text, expanded ? Number.MAX_SAFE_INTEGER : LSP_RESULT_FOLD_LINES);
  let rendered = displayLines.join("\n") ? theme.fg("toolOutput", displayLines.join("\n")) : "";
  if (!expanded && remainingLines > 0) rendered += `${theme.fg("muted", `\n... (${remainingLines} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")})`;
  return rendered;
}

function renderLspResult(result: any, options: { expanded: boolean }, theme: any, context: any) {
  const component = context.lastComponent ?? new Text("", 0, 0);
  component.setText(formatResultText(getTextContent(result), options.expanded, theme));
  return component;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text" as const, text }], details };
}

function err(details: any): ToolResult {
  return ok(formatToolError(details), { ok: false, error: details });
}

async function withFile(
  manager: LspServerManager,
  file: string,
  fn: (s: { abs: string; uri: string; state: any }) => Promise<string>,
  options: { timeoutMs?: number } = {},
): Promise<ToolResult> {
  const resolved = await manager.resolveFileState(file, { timeoutMs: options.timeoutMs });
  if (!resolved.ok) return err(resolved.error);
  const { result } = resolved;
  try {
    const text = await fn(result);
    return ok(text, { ok: true, language: result.state.language, workspace_root: result.state.workspaceRoot });
  } catch (error) {
    if (error instanceof LspToolError) return err(error.details);
    return err({ kind: "tool_execution_failed", file: result.abs, language: result.state.language, workspace_root: result.state.workspaceRoot, command: result.state.command, install_hint: result.state.installHint, message: error instanceof Error ? error.message : String(error) });
  }
}

function withTimeout(promise: Promise<ToolResult>, ms: number, label: string): Promise<ToolResult> {
  return Promise.race([
    promise,
    new Promise<ToolResult>((resolve) =>
      setTimeout(() => resolve(err({ kind: "tool_timeout", message: `${label} timed out after ${ms}ms` })), ms)
    ),
  ]);
}

function severityLabel(s: number): string {
  return s === 1 ? "error" : s === 2 ? "warning" : s === 3 ? "info" : "hint";
}

function symbolKindLabel(kind: number): string {
  const labels: Record<number, string> = { 2:"module",3:"namespace",5:"class",6:"method",7:"property",8:"field",9:"constructor",11:"interface",12:"function",13:"variable",14:"constant",23:"struct",24:"event" };
  return labels[kind] ?? "symbol";
}

function formatDocumentSymbols(file: string, symbols: any[]): string {
  if (symbols.length === 0) return `${file}: no symbols`;
  const lines = [`${file}: ${symbols.length} top-level symbol(s)`];
  const append = (syms: any[], depth: number) => {
    for (const s of syms) {
      const detail = s.detail ? ` — ${s.detail}` : "";
      lines.push(`${"  ".repeat(depth)}${symbolKindLabel(s.kind)} ${s.name}${detail} @ ${s.range.start.line + 1}:${s.range.start.character + 1}`);
      if (s.children?.length) append(s.children, depth + 1);
    }
  };
  append(symbols, 1);
  return lines.join("\n");
}

// ─── Register tools ───────────────────────────────────────────────────────

export function registerLspTools(pi: ExtensionAPI, manager: LspServerManager) {

  // ── lsp_diagnostics ────────────────────────────────────────────────────
  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP: diagnostics",
    description: "Get language server diagnostics for one or more files. Default filter: error. Supports optional severity filtering.",
    promptSnippet: "Get language server diagnostics for one or more files",
    promptGuidelines: [
      "Use lsp_diagnostics to validate focused code changes after editing or writing before reporting completion.",
      "Supported languages: typescript, c, cpp, python, rust, go, ruby, java, lua, svelte, json.",
    ],
    renderResult: renderLspResult,
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { minItems: 1, maxItems: 100, description: "Paths to check. One or more file paths (relative to cwd or absolute)." }),
      severity: Type.Optional(Type.Array(Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("info"), Type.Literal("hint")]), { description: "Filter to specific severity levels. Default: error." })),
      wait_ms: Type.Optional(Type.Number({ description: "Max ms to wait for diagnostics. Default 1500." })),
      timeout_ms: Type.Optional(Type.Number({ description: "Overall max ms including server startup. Default 30000." })),
    }),
    execute: async (_id, params, _signal, _update, _ctx): Promise<ToolResult> => {
      const waitMs = params.wait_ms ?? 1500;
      const totalTimeout = params.timeout_ms ?? 30_000;
      const severities: ("error"|"warning"|"info"|"hint")[] = params.severity ?? ["error"];
      const minSeverity = Math.min(...severities.map(s => ({ error: 1, warning: 2, info: 3, hint: 4 }[s])));

      return withTimeout((async () => {
        const results = await Promise.all(params.paths.map(async (file) => {
          const resolved = await manager.resolveFileState(file, { timeoutMs: totalTimeout });
          if (!resolved.ok) return { line: formatToolError(resolved.error), diagnostics: 0, errors: 0, warnings: 0, isError: true };
          try {
            const diagnostics = await resolved.result.state.client.waitForDiagnostics(resolved.result.uri, waitMs);
            const filtered = diagnostics.filter((d: any) => (d.severity ?? 1) <= minSeverity);
            let errors = 0, warnings = 0;
            for (const d of filtered) { if (d.severity === 1) errors++; else if (d.severity === 2) warnings++; }
            return { line: formatDiagnostics(resolved.result.abs, filtered), diagnostics: filtered.length, errors, warnings, isError: false };
          } catch { return { line: formatToolError({ kind: "tool_execution_failed", file, message: "diagnostics request failed" }), diagnostics: 0, errors: 0, warnings: 0, isError: true }; }
        }));

        let totalDiag = 0, totalErr = 0, totalWarn = 0, cleanCount = 0, failCount = 0;
        const lines: string[] = [];
        for (const r of results) {
          lines.push(r.line);
          if (r.isError) { failCount++; } else { totalDiag += r.diagnostics; totalErr += r.errors; totalWarn += r.warnings; if (r.diagnostics === 0) cleanCount++; }
        }
        const summary = totalErr > 0 || totalWarn > 0
          ? `Checked ${params.paths.length} file(s): ${totalErr} error(s), ${totalWarn} warning(s), ${totalDiag - totalErr - totalWarn} info/hint(s), ${cleanCount} clean, ${failCount} failed`
          : `Checked ${params.paths.length} file(s): ${totalDiag} diagnostic(s), ${cleanCount} clean, ${failCount} failed`;
        return ok([summary, ...lines].join("\n\n"), { ok: failCount === 0 && totalErr === 0, checked: params.paths.length, diagnostic_count: totalDiag, error_count: totalErr, warning_count: totalWarn });
      })(), totalTimeout, "LSP diagnostics");
    },
  });

  // ── lsp_document_symbols ───────────────────────────────────────────────
  pi.registerTool({
    name: "lsp_document_symbols",
    label: "LSP: document symbols",
    description: "List symbols in a file (functions, classes, variables) using the language server.",
    promptSnippet: "List functions, classes, and variables in a file",
    promptGuidelines: [
      "Prefer lsp_document_symbols to find functions, classes, or variables in code instead of grep.",
      "Supported languages: typescript, c, cpp, python, rust, go, ruby, java, lua, svelte.",
    ],
    renderResult: renderLspResult,
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file (relative or absolute)." }),
      timeout_ms: Type.Optional(Type.Number({ description: "Overall max ms including server startup. Default 10000." })),
    }),
    execute: async (_id, params, _signal, _update, _ctx): Promise<ToolResult> => {
      const timeoutMs = params.timeout_ms ?? 10_000;
      return withTimeout(
        withFile(manager, params.path, async (result) => {
          const symbols = await result.state.client.documentSymbols(result.uri, timeoutMs);
          return formatDocumentSymbols(result.abs, symbols);
        }, { timeoutMs }),
        timeoutMs,
        "LSP document symbols",
      );
    },
  });
}

// ─── Formatting ────────────────────────────────────────────────────────────

function formatDiagnostics(file: string, diagnostics: any[]): string {
  if (diagnostics.length === 0) return `${file}: no diagnostics`;
  const lines = [`${file}: ${diagnostics.length} diagnostic(s)`];
  for (const d of diagnostics) {
    const pos = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
    const source = d.source ? ` [${d.source}]` : "";
    const code = d.code != null ? ` (${d.code})` : "";
    lines.push(`  ${pos} ${severityLabel(d.severity ?? 1)}${source}${code}: ${d.message}`);
  }
  return lines.join("\n");
}

export const __lspToolsTest = { collapse_lsp_text: collapseText };
