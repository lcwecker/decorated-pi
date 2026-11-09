/**
 * TUI rendering for the LSP tools.
 *
 * The model-facing text already carries every row the user needs; these
 * renderers add the two things a flat text block cannot: what was asked about
 * (the position in the call row, the symbol name and the counts in the result
 * header) and which part of each row is the path, the position and the hit.
 *
 * Every renderer falls back to `renderToolTextResult` when `details` carries no
 * structured rows — an error reply, or a transcript recorded before these
 * renderers existed. Folding, the expand key hint and the "N more lines" footer
 * come from utils/tool-output, so these rows behave like every other long
 * result.
 */
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import {
  TOOL_RESULT_FOLD_LINES,
  foldToolText,
  renderKeyHint,
  renderToolTextResult,
} from "../../utils/tool-output.js";
import { type ChangeRow, type LocationRow, type SymbolRow, symbolKindName } from "./format.js";

function textComponent(context: any): Text {
  return context?.lastComponent ?? new Text("", 0, 0);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// ─── Call rows ─────────────────────────────────────────────────────────────

/** `LSP: references hooks/tps.ts:96:11` — the position the call acts on, with
 *  the tool's own flags after it (`· no declaration`) and on their own lines
 *  when expanded. */
export function makeCallRenderer(
  label: string,
  flags: (args: any) => string[] = () => [],
): (args: any, theme: any, context: any) => Component {
  return (args: any, theme: any, context: any) => {
    const component = textComponent(context);
    let text = theme.bold(theme.fg("toolTitle", label));
    if (typeof args?.path === "string") {
      text += ` ${theme.fg("accent", args.path)}`;
      if (args.line !== undefined) {
        text += theme.fg("muted", `:${args.line}:${args.character ?? "?"}`);
      }
    }
    const list = flags(args);
    if (list.length > 0) {
      text += context?.expanded
        ? list.map((flag) => `\n${theme.fg("muted", `  ${flag}`)}`).join("")
        : ` ${theme.fg("muted", list.join(" · "))}`;
    }
    component.setText(text);
    return component;
  };
}

// ─── Result rows ───────────────────────────────────────────────────────────

function styleLocationRow(row: LocationRow, theme: any): string {
  const position = theme.fg("accent", row.file) + theme.fg("muted", `:${row.line}:${row.character}`);
  if (!row.source) return position;
  const start = row.symbolStart;
  const symbol = row.symbol;
  if (symbol !== undefined && start !== undefined) {
    const before = row.source.slice(0, start);
    const after = row.source.slice(start + symbol.length);
    return `${position} ${before}${theme.fg("toolDiffAdded", symbol)}${after}`;
  }
  return `${position} ${row.source}`;
}

function locationHeader(details: any, noun: string, theme: any): string {
  const total = typeof details?.total === "number" ? details.total : (details?.locations?.length ?? 0);
  const files = typeof details?.files === "number" ? details.files : undefined;
  const parts = [plural(total, noun)];
  if (files !== undefined) parts.push(plural(files, "file"));
  let header = theme.fg("muted", parts.join(" · "));
  if (typeof details?.symbol === "string") header += ` · ${theme.fg("accent", details.symbol)}`;
  if (details?.omitted > 0) header += theme.fg("warning", ` · ${details.omitted} omitted`);
  return header;
}

/** Header line plus one styled row per location. */
export function makeLocationResultRenderer(
  noun: string,
): (result: any, options: { expanded: boolean }, theme: any, context: any) => Component {
  return (result: any, options: { expanded: boolean }, theme: any, context: any) => {
    const details = result?.details;
    const rows: LocationRow[] = Array.isArray(details?.locations) ? details.locations : [];
    if (rows.length === 0) return renderToolTextResult(result, options, theme, context);
    const component = textComponent(context);
    const body = foldToolText(
      rows.map((row) => styleLocationRow(row, theme)).join("\n"),
      options.expanded,
      theme,
      renderKeyHint(context),
      TOOL_RESULT_FOLD_LINES,
    );
    component.setText(`${locationHeader(details, noun, theme)}\n${body}`);
    return component;
  };
}

/** Indented outline: name, kind, position, one row per symbol. */
export function renderSymbolsResult(
  result: any,
  options: { expanded: boolean },
  theme: any,
  context: any,
): Component {
  const details = result?.details;
  const rows: SymbolRow[] = Array.isArray(details?.symbols) ? details.symbols : [];
  if (rows.length === 0) return renderToolTextResult(result, options, theme, context);
  const component = textComponent(context);
  const body = foldToolText(
    rows
      .map(
        (row) =>
          `${"  ".repeat(row.depth)}${row.name} ${theme.fg("muted", `(${symbolKindName(row.kind)})`)} ${theme.fg("accent", `${row.line}:${row.character}`)}`,
      )
      .join("\n"),
    options.expanded,
    theme,
    renderKeyHint(context),
    TOOL_RESULT_FOLD_LINES,
  );
  component.setText(`${theme.fg("muted", plural(rows.length, "symbol"))}\n${body}`);
  return component;
}

function styleChange(row: ChangeRow, theme: any): string {
  const position = theme.fg("accent", row.file) + theme.fg("muted", `:${row.line}:${row.character}`);
  const before = row.before.replace(/\s+/g, " ").trim();
  const after = row.after.replace(/\s+/g, " ").trim();
  return `${position} ${theme.fg("toolDiffRemoved", before || "(nothing)")} ${theme.fg("muted", "→")} ${theme.fg("toolDiffAdded", after)}`;
}

/** Pending or applied edits as a red/green row per change. */
export function renderRenameResult(
  result: any,
  options: { expanded: boolean },
  theme: any,
  context: any,
): Component {
  const details = result?.details;
  const changes: ChangeRow[] = Array.isArray(details?.changes) ? details.changes : [];
  if (changes.length === 0) return renderToolTextResult(result, options, theme, context);
  const component = textComponent(context);
  const files = details?.files ?? new Set(changes.map((row) => row.file)).size;
  const counts = `${plural(changes.length, "edit")} · ${plural(files, "file")}`;
  // A preview has not touched the disk; an applied rename says so, with the
  // name it wrote.
  const header = details?.preview
    ? theme.fg("muted", `preview · ${counts}`)
    : `${theme.fg("muted", "renamed to")} ${theme.fg("accent", `\"${details?.newName ?? "?"}\"`)} ${theme.fg("muted", `· ${counts}`)}`;
  const body = foldToolText(
    changes.map((row) => styleChange(row, theme)).join("\n"),
    options.expanded,
    theme,
    renderKeyHint(context),
    TOOL_RESULT_FOLD_LINES,
  );
  component.setText(`${header}\n${body}`);
  return component;
}
