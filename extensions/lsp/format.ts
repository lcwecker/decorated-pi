/**
 * LSP Output Formatting — diagnostics, hover, locations, symbols
 *
 * Based on @spences10/pi-lsp by Scott Spence
 * https://github.com/spences10/my-pi/tree/main/packages/pi-lsp (MIT License)
 */
import { fileURLToPath } from "node:url";
import type { LspDiagnostic, LspHover, LspLocation, LspDocumentSymbol } from "./client.js";
import { LspClientStartError } from "./client.js";
import { get_server_config, list_supported_languages } from "./servers.js";

export interface LspToolErrorDetail {
  kind: string;
  file?: string;
  language?: string;
  workspace_root?: string;
  command?: string;
  install_hint?: string;
  message: string;
  code?: string;
}

export class LspToolError extends Error {
  details: LspToolErrorDetail;
  constructor(details: LspToolErrorDetail) {
    super(details.message);
    this.name = "LspToolError";
    this.details = details;
  }
}

const SYMBOL_KIND_LABELS: Record<number, string> = {
  2: "module",
  3: "namespace",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  23: "struct",
  24: "event",
};

export const SYMBOL_KIND_NAMES = Object.values(SYMBOL_KIND_LABELS);

export function format_status_lines(
  cwd: string,
  clients_by_server: Map<string, any>,
  failed_servers: Map<string, any>
): string[] {
  const lines: string[] = [];
  const active_languages = new Set<string>();

  const running_states = Array.from(clients_by_server.values()).sort(
    (a: any, b: any) =>
      a.language.localeCompare(b.language) ||
      a.workspace_root.localeCompare(b.workspace_root)
  );
  for (const running of running_states) {
    active_languages.add(running.language);
    lines.push(
      `${running.language}: running (ready=${running.client.is_ready()}) — ${running.command} [workspace ${running.workspace_root}]`
    );
  }

  const failures = Array.from(failed_servers.values()).sort(
    (a: any, b: any) =>
      (a.language ?? "").localeCompare(b.language ?? "") ||
      (a.workspace_root ?? "").localeCompare(b.workspace_root ?? "")
  );
  for (const failure of failures) {
    if (failure.language) active_languages.add(failure.language);
    const workspace = failure.workspace_root
      ? ` [workspace ${failure.workspace_root}]`
      : "";
    const language = failure.language ?? "unknown";
    lines.push(`${language}: failed — ${failure.message}${workspace}`);
  }

  for (const language of list_supported_languages()) {
    if (active_languages.has(language)) continue;
    const config = get_server_config(language, cwd);
    if (config) {
      lines.push(`${language}: idle — ${config.command}`);
    }
  }

  return lines.length > 0 ? lines : ["No language servers configured for this project."];
}

export function to_lsp_tool_error(
  file: string,
  language: string,
  workspace_root: string | undefined,
  command: string,
  install_hint: string | undefined,
  error: unknown
): LspToolErrorDetail {
  if (error instanceof LspToolError) {
    return error.details;
  }
  if (error instanceof LspClientStartError) {
    const missing_binary = error.code === "ENOENT";
    return {
      kind: "server_start_failed",
      file,
      language,
      workspace_root,
      command,
      install_hint,
      code: error.code,
      message: missing_binary
        ? `command "${command}" not found`
        : error.message,
    };
  }
  const err = error as Record<string, unknown> | undefined;
  return {
    kind: "tool_execution_failed",
    file,
    language,
    workspace_root,
    command,
    install_hint,
    message: error instanceof Error ? error.message : String(error),
    code:
      err && typeof err.code === "string" ? err.code : undefined,
  };
}

export function format_tool_error(details: LspToolErrorDetail): string {
  if (details.kind === "unsupported_language") {
    return details.message;
  }
  const lines = [
    details.language
      ? `${details.language} LSP unavailable for ${details.file}`
      : `LSP request failed for ${details.file}`,
    `Reason: ${details.message}`,
  ];
  if (details.command) lines.push(`Command: ${details.command}`);
  if (details.workspace_root) lines.push(`Workspace: ${details.workspace_root}`);
  if (details.install_hint) lines.push(`Hint: ${details.install_hint}`);
  return lines.join("\n");
}

function severity_label(severity: number): string {
  switch (severity) {
    case 1: return "error";
    case 2: return "warning";
    case 3: return "info";
    case 4: return "hint";
    default: return "info";
  }
}

export type SeverityFilter = "error" | "warning" | "info" | "hint";

const SEVERITY_MAP: Record<SeverityFilter, number> = {
  error: 1,
  warning: 2,
  info: 3,
  hint: 4,
};

export function filter_diagnostics(
  diagnostics: LspDiagnostic[],
  severities?: SeverityFilter[]
): LspDiagnostic[] {
  if (!severities || severities.length === 0) return diagnostics;
  // 取最小的 severity 值（error=1 < warning=2 < info=3 < hint=4）
  const minSeverity = Math.min(...severities.map((s) => SEVERITY_MAP[s]));
  // 显示 severity <= minSeverity（更严重 + 自身）
  return diagnostics.filter((d) => (d.severity ?? 1) <= minSeverity);
}

export function format_diagnostics(
  file: string,
  diagnostics: LspDiagnostic[],
  severities?: SeverityFilter[]
): string {
  const filtered = filter_diagnostics(diagnostics, severities);
  if (filtered.length === 0) return `${file}: no diagnostics`;
  const lines = [`${file}: ${filtered.length} diagnostic(s)`];
  for (const d of filtered) {
    const position = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
    const source = d.source ? ` [${d.source}]` : "";
    const code = d.code != null ? ` (${d.code})` : "";
    lines.push(
      `  ${position} ${severity_label(d.severity ?? 1)}${source}${code}: ${d.message}`
    );
  }
  return lines.join("\n");
}

export function format_hover(hover: LspHover | null): string {
  if (!hover) return "No hover info.";
  const contents = hover.contents;
  const extract = (item: unknown): string =>
    typeof item === "string" ? item : ((item as { value?: string })?.value ?? "");
  if (Array.isArray(contents)) {
    return contents.map(extract).join("\n\n").trim() || "No hover info.";
  }
  return extract(contents).trim() || "No hover info.";
}

export function format_locations(
  locations: LspLocation[],
  empty_message: string
): string {
  if (locations.length === 0) return empty_message;
  return locations
    .map((loc) => {
      const path = file_url_to_path_or_value(loc.uri);
      return `${path}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
    })
    .join("\n");
}

export function format_document_symbols(
  file: string,
  symbols: LspDocumentSymbol[]
): string {
  if (symbols.length === 0) return `${file}: no symbols`;
  const lines = [`${file}: ${symbols.length} top-level symbol(s)`];
  append_symbol_lines(lines, symbols, 1);
  return lines.join("\n");
}

export interface SymbolMatchOptions {
  max_results: number;
  top_level_only: boolean;
  exact_match: boolean;
  kinds: Set<string>;
  language: string;
}

export interface SymbolMatch {
  symbol: LspDocumentSymbol;
  depth: number;
}

export function find_symbol_matches(
  symbols: LspDocumentSymbol[],
  query: string,
  options: SymbolMatchOptions
): SymbolMatch[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  const matches: SymbolMatch[] = [];

  const expand_exact_name_values = (name: string): string[] => {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) return [];
    const expanded = new Set([trimmed]);
    if (options.language === "cpp" && trimmed.includes("::")) {
      const parts = trimmed
        .split("::")
        .map((part) => part.trim())
        .filter(Boolean);
      if (parts.length > 0) expanded.add(parts[parts.length - 1]!);
    }
    return Array.from(expanded);
  };

  const matches_query = (symbol: LspDocumentSymbol): boolean => {
    const raw_name = symbol.name.trim().toLowerCase();
    const raw_detail = (symbol.detail ?? "").trim().toLowerCase();
    if (options.exact_match) {
      const exact_values = [
        ...expand_exact_name_values(symbol.name),
        ...(raw_detail ? [raw_detail] : []),
      ];
      return exact_values.some((value) => value === normalized);
    }
    const fuzzy_values = [raw_name, raw_detail].filter(Boolean);
    return fuzzy_values.some((value) => value.includes(normalized));
  };

  const matches_kind = (symbol: LspDocumentSymbol): boolean => {
    if (options.kinds.size === 0) return true;
    return options.kinds.has(symbol_kind_label(symbol.kind));
  };

  const visit = (entries: LspDocumentSymbol[], depth: number): void => {
    for (const symbol of entries) {
      if (matches_kind(symbol) && matches_query(symbol)) {
        matches.push({ symbol, depth });
        if (matches.length >= options.max_results) return;
      }
      if (!options.top_level_only && symbol.children?.length) {
        visit(symbol.children, depth + 1);
        if (matches.length >= options.max_results) return;
      }
    }
  };

  visit(symbols, 1);
  return matches;
}

export function format_symbol_matches(
  file: string,
  query: string,
  matches: SymbolMatch[]
): string {
  if (matches.length === 0) {
    return `${file}: no symbols matching "${query}"`;
  }
  const lines = [`${file}: ${matches.length} symbol match(es) for "${query}"`];
  for (const { symbol, depth } of matches) {
    const indent = "  ".repeat(depth);
    const detail = symbol.detail ? ` — ${symbol.detail}` : "";
    const range = `${symbol.range.start.line + 1}:${symbol.range.start.character + 1}`;
    lines.push(
      `${indent}${symbol_kind_label(symbol.kind)} ${symbol.name}${detail} @ ${range}`
    );
  }
  return lines.join("\n");
}

function append_symbol_lines(
  lines: string[],
  symbols: LspDocumentSymbol[],
  depth: number
): void {
  for (const symbol of symbols) {
    const indent = "  ".repeat(depth);
    const detail = symbol.detail ? ` — ${symbol.detail}` : "";
    const range = `${symbol.range.start.line + 1}:${symbol.range.start.character + 1}`;
    lines.push(
      `${indent}${symbol_kind_label(symbol.kind)} ${symbol.name}${detail} @ ${range}`
    );
    if (symbol.children?.length) {
      append_symbol_lines(lines, symbol.children, depth + 1);
    }
  }
}

export function symbol_kind_label(kind: number): string {
  return SYMBOL_KIND_LABELS[kind] ?? "symbol";
}

function file_url_to_path_or_value(uri: string): string {
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : uri;
  } catch {
    return uri;
  }
}
