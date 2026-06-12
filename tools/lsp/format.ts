/**
 * LSP Output Formatting — test-compatible standalone module.
 *
 * Core formatting logic duplicated here so tests can import directly.
 * Runtime tools.ts has its own inline copies.
 */
import { fileURLToPath } from "node:url";
import type { LspDiagnostic, LspHover, LspLocation } from "./types.js";
import { LspClientStartError } from "./client.js";

export type { LspDiagnostic, LspHover, LspLocation } from "./types.js";
export { LspClientStartError } from "./client.js";

// ─── Error formatting ────────────────────────────────────────────────────

export class LspToolError extends Error {
  constructor(public readonly details: LspToolErrorDetail) {
    super(details.message);
    this.name = "LspToolError";
  }
}

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

export function to_lsp_tool_error(
  file: string, language: string, workspaceRoot: string | undefined,
  command: string, installHint: string | undefined, error: unknown,
): LspToolErrorDetail {
  if (error instanceof LspToolError) return error.details;
  if (error instanceof LspClientStartError) {
    return {
      kind: "server_start_failed", file, language, workspace_root: workspaceRoot,
      command, install_hint: installHint, code: error.code,
      message: error.code === "ENOENT" ? `command "${command}" not found` : error.message,
    };
  }
  const err = error as Record<string, unknown> | undefined;
  return {
    kind: "tool_execution_failed", file, language, workspace_root: workspaceRoot,
    command, install_hint: installHint,
    message: error instanceof Error ? error.message : String(error),
    code: err?.code as string | undefined,
  };
}

export function format_tool_error(details: LspToolErrorDetail): string {
  if (details.kind === "unsupported_language") return details.message;
  const lines = [
    details.language ? `${details.language} LSP unavailable for ${details.file}` : `LSP request failed for ${details.file}`,
    `Reason: ${details.message}`,
  ];
  if (details.command) lines.push(`Command: ${details.command}`);
  if (details.workspace_root) lines.push(`Workspace: ${details.workspace_root}`);
  if (details.install_hint) lines.push(`Hint: ${details.install_hint}`);
  return lines.join("\n");
}

// ─── Severity ─────────────────────────────────────────────────────────────

export type SeverityFilter = "error" | "warning" | "info" | "hint";
const SEVERITY_MAP: Record<SeverityFilter, number> = { error: 1, warning: 2, info: 3, hint: 4 };

function severityLabel(s: number): string {
  return s === 1 ? "error" : s === 2 ? "warning" : s === 3 ? "info" : "hint";
}

export function filter_diagnostics(diagnostics: LspDiagnostic[], severities?: SeverityFilter[]): LspDiagnostic[] {
  if (!severities?.length) return diagnostics;
  const min = Math.min(...severities.map((s) => SEVERITY_MAP[s]));
  return diagnostics.filter((d) => (d.severity ?? 1) <= min);
}

export function format_diagnostics(file: string, diagnostics: LspDiagnostic[], severities?: SeverityFilter[]): string {
  const filtered = filter_diagnostics(diagnostics, severities);
  if (filtered.length === 0) return `${file}: no diagnostics`;
  const lines = [`${file}: ${filtered.length} diagnostic(s)`];
  for (const d of filtered) {
    const pos = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
    const source = d.source ? ` [${d.source}]` : "";
    const code = d.code != null ? ` (${d.code})` : "";
    lines.push(`  ${pos} ${severityLabel(d.severity ?? 1)}${source}${code}: ${d.message}`);
  }
  return lines.join("\n");
}

// ─── Hover ────────────────────────────────────────────────────────────────

export function format_hover(hover: LspHover | null): string {
  if (!hover) return "No hover info.";
  const extract = (item: unknown): string => typeof item === "string" ? item : ((item as any)?.value ?? "");
  if (Array.isArray(hover.contents)) return hover.contents.map(extract).join("\n\n").trim() || "No hover info.";
  return extract(hover.contents).trim() || "No hover info.";
}

// ─── Locations ────────────────────────────────────────────────────────────

export function format_locations(locations: LspLocation[], emptyMessage: string): string {
  if (locations.length === 0) return emptyMessage;
  return locations.map((loc) => `${fileUrlToPath(loc.uri)}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`).join("\n");
}

function fileUrlToPath(uri: string): string {
  try { return uri.startsWith("file:") ? fileURLToPath(uri) : uri; } catch { return uri; }
}

// ─── Collapse (for tools test) ────────────────────────────────────────────

export function collapse_lsp_text(text: string, maxLines = 20) {
  const lines = text.split("\n").reverse().reduce((acc, l) => l === "" && acc.length === 0 ? acc : [l, ...acc], [] as string[]);
  const totalLines = lines.length;
  return { totalLines, displayLines: lines.slice(0, maxLines), remainingLines: Math.max(0, totalLines - maxLines) };
}

export const __lspFormatTest = { collapse_lsp_text: collapse_lsp_text };
