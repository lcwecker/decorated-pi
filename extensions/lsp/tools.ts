import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { list_supported_languages } from "./servers.js";
import {
  filter_diagnostics,
  find_symbol_matches,
  format_diagnostics,
  format_document_symbols,
  format_hover,
  format_locations,
  format_symbol_matches,
  format_tool_error,
  SYMBOL_KIND_NAMES,
  to_lsp_tool_error,
  type SeverityFilter,
} from "./format.js";
import type { LspServerManager } from "./server-manager.js";

const SYMBOL_KIND_SCHEMA = Type.Union(
  SYMBOL_KIND_NAMES.map((name) => Type.Literal(name))
);

const DIAGNOSTICS_MANY_CONCURRENCY = 8;

function make_tool_result(
  text: string,
  details: Record<string, unknown> = {}
) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function make_tool_error(details: any) {
  return make_tool_result(format_tool_error(details), {
    ok: false,
    error: details,
  });
}

async function map_with_concurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let next_index = 0;
  const worker_count = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: worker_count }, async () => {
      while (true) {
        const index = next_index;
        next_index += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index]!, index);
      }
    })
  );
  return results;
}

async function with_file_state(
  manager: LspServerManager,
  file: string,
  ctx: any,
  run: (result: { abs: string; uri: string; state: any }) => Promise<string>
) {
  const resolved = await manager.resolve_file_state(file, ctx);
  if (!resolved.ok) {
    return make_tool_error(resolved.error);
  }
  const { result } = resolved;
  try {
    const text = await run(result);
    return make_tool_result(text, {
      ok: true,
      language: result.state.language,
      command: result.state.command,
      workspace_root: result.state.workspace_root,
    });
  } catch (error) {
    return make_tool_error(
      to_lsp_tool_error(
        result.abs,
        result.state.language,
        result.state.workspace_root,
        result.state.command,
        result.state.install_hint,
        error
      )
    );
  }
}

export function register_lsp_tools(pi: ExtensionAPI, manager: LspServerManager) {
  pi.registerTool(
    defineTool({
      name: "lsp_diagnostics",
      label: "LSP: diagnostics",
      description:
        "Get language server diagnostics for one or more files. Default filter: error. Supports optional severity filtering.",
      promptSnippet: "Get language server diagnostics for one or more files",
      promptGuidelines: [
        "Use lsp_diagnostics to validate focused code changes after editing or writing before reporting completion.",
      ],
      parameters: Type.Object({
        files: Type.Array(Type.String(), {
          minItems: 1,
          maxItems: 100,
          description: "Files to check. Single file or list (relative to cwd or absolute).",
        }),
        severity: Type.Optional(
          Type.Array(
            Type.Union([
              Type.Literal("error"),
              Type.Literal("warning"),
              Type.Literal("info"),
              Type.Literal("hint"),
            ]),
            {
              description:
                "Filter to specific severity levels. Default: error. Values: error, warning, info, hint. Picking a level shows it and all more severe levels (e.g. warning → error + warning).",
            }
          )
        ),
        wait_ms: Type.Optional(
          Type.Number({
            description:
              "Max ms to wait for diagnostics after opening each file. Default 1500.",
          })
        ),
      }),
      execute: async (_id, params, _signal, _on_update, ctx) => {
        const wait_ms = params.wait_ms ?? 1500;
        const severities: SeverityFilter[] = params.severity ?? ["error"];

        const lines_with_stats = await map_with_concurrency(
          params.files,
          DIAGNOSTICS_MANY_CONCURRENCY,
          async (file) => {
            const resolved = await manager.resolve_file_state(file, ctx);
            if (!resolved.ok) {
              return {
                line: format_tool_error(resolved.error),
                diagnostics: 0,
                error: true,
              };
            }
            try {
              const diagnostics =
                await resolved.result.state.client.wait_for_diagnostics(
                  resolved.result.uri,
                  wait_ms
                );
              const filtered = filter_diagnostics(diagnostics, severities);
              let errors = 0, warnings = 0, infos = 0;
              for (const d of filtered) {
                if (d.severity === 1) errors++;
                else if (d.severity === 2) warnings++;
                else infos++;
              }
              return {
                line: format_diagnostics(resolved.result.abs, diagnostics, severities),
                diagnostics: filtered.length,
                errors,
                warnings,
                error: false,
              };
            } catch (error) {
              return {
                line: format_tool_error(
                  to_lsp_tool_error(
                    resolved.result.abs,
                    resolved.result.state.language,
                    resolved.result.state.workspace_root,
                    resolved.result.state.command,
                    resolved.result.state.install_hint,
                    error
                  )
                ),
                diagnostics: 0,
                error: true,
              };
            }
          }
        );

        let total_diag = 0;
        let total_err = 0;
        let total_warn = 0;
        let clean_count = 0;
        let fail_count = 0;
        const lines: string[] = [];
        for (const entry of lines_with_stats) {
          lines.push(entry.line);
          if (entry.error) {
            fail_count += 1;
          } else {
            total_diag += entry.diagnostics;
            total_err += (entry as any).errors ?? 0;
            total_warn += (entry as any).warnings ?? 0;
            if (entry.diagnostics === 0) clean_count += 1;
          }
        }
        const summary = total_err > 0 || total_warn > 0
          ? `Checked ${params.files.length} file(s): ${total_err} error(s), ${total_warn} warning(s), ${total_diag - total_err - total_warn} info/hint(s), ${clean_count} clean, ${fail_count} failed to check`
          : `Checked ${params.files.length} file(s): ${total_diag} diagnostic(s), ${clean_count} clean, ${fail_count} failed to check`;
        return make_tool_result(
          [summary, ...lines].join("\n\n"),
          {
            ok: fail_count === 0 && total_err === 0,
            checked: params.files.length,
            diagnostic_count: total_diag,
            error_count: total_err,
            warning_count: total_warn,
            clean_count,
            fail_count,
          }
        );
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "lsp_find_symbol",
      label: "LSP: find symbol",
      description:
        "Find symbols in a file by name or detail text using document symbols. Supports exact matching, kind filters, and top-level-only mode.",
      promptSnippet: "Find symbols in a file by name, kind, or match mode",
      promptGuidelines: [
        "Use lsp_find_symbol to locate named symbols in a file when symbol structure matters more than broad text search.",
      ],
      parameters: Type.Object({
        file: Type.String({
          description: "Path to the file whose symbols should be searched.",
        }),
        query: Type.String({
          description: "Substring to match against symbol names/details.",
        }),
        max_results: Type.Optional(
          Type.Number({
            description: "Max number of matches to return. Default 20.",
          })
        ),
        top_level_only: Type.Optional(
          Type.Boolean({
            description: "Only match top-level symbols. Default false.",
          })
        ),
        exact_match: Type.Optional(
          Type.Boolean({
            description:
              "Match whole symbol names/details exactly instead of substring matching. Default false.",
          })
        ),
        kinds: Type.Optional(
          Type.Array(SYMBOL_KIND_SCHEMA, {
            minItems: 1,
            maxItems: SYMBOL_KIND_NAMES.length,
            description: "Restrict matches to these symbol kinds.",
          })
        ),
      }),
      execute: async (
        _id,
        params,
        _signal,
        _on_update,
        ctx
      ) =>
        with_file_state(
          manager,
          params.file,
          ctx,
          async (result) => {
            const symbols =
              await result.state.client.document_symbols(result.uri);
            return format_symbol_matches(
              result.abs,
              params.query,
              find_symbol_matches(symbols, params.query, {
                max_results: params.max_results ?? 20,
                top_level_only: params.top_level_only ?? false,
                exact_match: params.exact_match ?? false,
                kinds: new Set(params.kinds ?? []),
                language: result.state.language,
              })
            );
          }
        ),
    })
  );

  pi.registerTool(
    defineTool({
      name: "lsp_hover",
      label: "LSP: hover",
      description:
        "Get hover info (types, docs) at a position in a file. Positions are zero-based.",
      promptSnippet: "Get types and documentation at a symbol position",
      promptGuidelines: [
        "Use lsp_hover to inspect the type, signature, or documentation of the symbol at a specific zero-based position.",
      ],
      parameters: Type.Object({
        file: Type.String({
          description: "Path to the file containing the symbol.",
        }),
        line: Type.Number({
          description: "Zero-based line number of the symbol.",
        }),
        character: Type.Number({
          description: "Zero-based character offset of the symbol.",
        }),
      }),
      execute: async (
        _id,
        params,
        _signal,
        _on_update,
        ctx
      ) =>
        with_file_state(
          manager,
          params.file,
          ctx,
          async (result) => {
            const hover = await result.state.client.hover(result.uri, {
              line: params.line,
              character: params.character,
            });
            return format_hover(hover);
          }
        ),
    })
  );

  pi.registerTool(
    defineTool({
      name: "lsp_definition",
      label: "LSP: go to definition",
      description:
        "Find definition locations for the symbol at a position. Positions are zero-based.",
      promptSnippet: "Find definition locations for a symbol at a position",
      promptGuidelines: [
        "Use lsp_definition to find the canonical definition location for the symbol at a specific zero-based position.",
      ],
      parameters: Type.Object({
        file: Type.String({
          description: "Path to the file containing the symbol.",
        }),
        line: Type.Number({
          description: "Zero-based line number of the symbol.",
        }),
        character: Type.Number({
          description: "Zero-based character offset of the symbol.",
        }),
      }),
      execute: async (
        _id,
        params,
        _signal,
        _on_update,
        ctx
      ) =>
        with_file_state(
          manager,
          params.file,
          ctx,
          async (result) => {
            const locations = await result.state.client.definition(
              result.uri,
              {
                line: params.line,
                character: params.character,
              }
            );
            return format_locations(locations, "No definition found.");
          }
        ),
    })
  );

  pi.registerTool(
    defineTool({
      name: "lsp_references",
      label: "LSP: find references",
      description:
        "Find references to the symbol at a position. Positions are zero-based.",
      promptSnippet: "Find references to a symbol at a position",
      promptGuidelines: [
        "Use lsp_references to find usages of a symbol more precisely than text search, optionally including the declaration site.",
      ],
      parameters: Type.Object({
        file: Type.String({
          description: "Path to the file containing the symbol.",
        }),
        line: Type.Number({
          description: "Zero-based line number of the symbol.",
        }),
        character: Type.Number({
          description: "Zero-based character offset of the symbol.",
        }),
        include_declaration: Type.Optional(
          Type.Boolean({
            description:
              "Whether to include the symbol declaration in reference results. Default true.",
          })
        ),
      }),
      execute: async (
        _id,
        params,
        _signal,
        _on_update,
        ctx
      ) =>
        with_file_state(
          manager,
          params.file,
          ctx,
          async (result) => {
            const locations = await result.state.client.references(
              result.uri,
              { line: params.line, character: params.character },
              params.include_declaration ?? true
            );
            return format_locations(locations, "No references found.");
          }
        ),
    })
  );

  pi.registerTool(
    defineTool({
      name: "lsp_document_symbols",
      label: "LSP: document symbols",
      description:
        "List symbols in a file (functions, classes, variables) using the language server.",
      promptSnippet: "List functions, classes, and variables in a file",
      promptGuidelines: [
        "Use lsp_document_symbols to inspect a file's structural outline before making focused edits or searching for symbols.",
      ],
      parameters: Type.Object({
        file: Type.String({
          description: "Path to the file to inspect.",
        }),
      }),
      execute: async (
        _id,
        params,
        _signal,
        _on_update,
        ctx
      ) =>
        with_file_state(
          manager,
          params.file,
          ctx,
          async (result) => {
            const symbols =
              await result.state.client.document_symbols(result.uri);
            return format_document_symbols(result.abs, symbols);
          }
        ),
    })
  );

  pi.registerTool(
    defineTool({
      name: "lsp_rename",
      label: "LSP: rename symbol",
      description:
        "Rename a symbol at a position. Returns all locations that need to be updated with the new name. Use the edit tool to apply the changes.",
      promptSnippet: "Compute symbol rename updates across affected files",
      promptGuidelines: [
        "Use lsp_rename to compute coordinated symbol rename updates across affected files instead of manual search-and-replace.",
      ],
      parameters: Type.Object({
        file: Type.String({
          description: "Path to the file containing the symbol.",
        }),
        line: Type.Number({
          description: "Zero-based line number of the symbol.",
        }),
        character: Type.Number({
          description: "Zero-based character offset of the symbol.",
        }),
        newName: Type.String({
          description: "New name for the symbol.",
        }),
      }),
      execute: async (
        _id,
        params,
        _signal,
        _on_update,
        ctx
      ) =>
        with_file_state(
          manager,
          params.file,
          ctx,
          async (result) => {
            const edits = await result.state.client.rename(
              result.uri,
              { line: params.line, character: params.character },
              params.newName
            );

            // Format rename output as a clear list of files to edit
            const locations = Object.keys(edits);
            if (locations.length === 0) {
              return `No rename locations found for "${params.newName}"`;
            }

            let output = `Rename to "${params.newName}": ${locations.length} file(s) need update\n\n`;
            for (const path of locations) {
              const info = edits[path]!;
              output += `${path}: change to "${info.newText}"\n`;
            }
            output += "\nUse the edit tool to apply these changes.";

            return output;
          }
        ),
    })
  );
}
