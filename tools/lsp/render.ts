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
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  TOOL_RESULT_FOLD_LINES,
  foldToolText,
  renderKeyHint,
  renderToolTextResult,
} from "../../utils/tool-output.js";
import { type ChangeRow, type LocationRow, type SymbolRow, identifierAt, symbolKindName } from "./format.js";

function textComponent(context: any): Text {
  return context?.lastComponent ?? new Text("", 0, 0);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// ─── Call rows ─────────────────────────────────────────────────────────────

/** What a call row says. `title` is the tool's own name — the identifier the
 *  model called and the one a reader can look up — followed by the subject it
 *  acts on (the symbol at the position, or the file) and whatever the tool adds
 *  (`→ plus`, `preview`). */
export interface CallSpec {
  title: string;
  /** `symbol` reads the identifier at the position; `path` titles the file. */
  subject: "symbol" | "path";
  /** The name being written, shown as `→ plus` after the symbol (rename). */
  newName?: (args: any) => string | undefined;
  flags?: (args: any) => string[];
}

/** Files bigger than this are not read to title a row: no real source file is
 *  this large, and a row must not read one that is. */
const SUBJECT_MAX_BYTES = 1 << 20;

/** Resolved subjects, keyed by `path:line:character`. An empty string records
 *  "read it, and no identifier sits there", so a position that holds none is
 *  not re-read on every render. */
const subjectCache = new Map<string, string>();

/** Keys with a read in flight, so ten renders of one row issue one read. */
const subjectPending = new Set<string>();

const SUBJECT_CACHE_MAX = 512;

function rememberSubject(key: string, value: string): void {
  subjectCache.set(key, value);
  if (subjectCache.size > SUBJECT_CACHE_MAX) {
    const oldest = subjectCache.keys().next().value;
    if (oldest !== undefined) subjectCache.delete(oldest);
  }
}

/**
 * Read the identifier for a row that is already on screen, then repaint it.
 *
 * `stat` runs first because the size guard alone is not enough: `/dev/zero`, a
 * FIFO and a directory all report a small or zero size, and reading one blocks
 * the read until something else happens to it. Only a regular file is read.
 */
async function loadSubject(
  key: string,
  file: string,
  line: number,
  character: number,
  repaint: () => void,
): Promise<void> {
  if (subjectPending.has(key)) return;
  subjectPending.add(key);
  let value = "";
  try {
    const info = await stat(file);
    if (info.isFile() && info.size <= SUBJECT_MAX_BYTES) {
      const text = (await readFile(file, "utf-8")).split("\n")[line - 1];
      if (text !== undefined) value = identifierAt(text, character - 1)?.name ?? "";
    }
  } catch {
    // Unreadable: cache the empty answer so the row stops asking.
  } finally {
    subjectPending.delete(key);
    rememberSubject(key, value);
    repaint();
  }
}

/**
 * The identifier a position call acts on, from the cache only.
 *
 * The call row is drawn before the tool runs, so the server has not named the
 * symbol yet — and `math.ts:2:17` alone does not say what is being asked about.
 * A renderer cannot wait for a disk read without stalling the TUI, so the first
 * frame shows the position, the read lands asynchronously, and `invalidate()`
 * repaints the row with the symbol.
 */
function callSubject(args: any, context: any): string | undefined {
  const line = args?.line;
  const character = args?.character;
  if (typeof args?.path !== "string" || !Number.isInteger(line) || !Number.isInteger(character)) {
    return undefined;
  }
  const key = `${args.path}:${line}:${character}`;
  const cached = subjectCache.get(key);
  if (cached !== undefined) return cached === "" ? undefined : cached;
  const file = isAbsolute(args.path) ? args.path : resolve(context?.cwd ?? process.cwd(), args.path);
  void loadSubject(key, file, line, character, () => {
    try {
      context?.invalidate?.();
    } catch {
      // The row is gone (scrolled away, session switched) — nothing to repaint.
    }
  });
  return undefined;
}

/**
 * `lsp_references add · math.ts:2:17`
 *
 * The tool name leads, the symbol it acts on follows in the accent color, and
 * the position it was derived from sits at the end in the muted color: the
 * reader needs the first two, the third only when the symbol came out wrong.
 */
export function makeCallRenderer(spec: CallSpec): (args: any, theme: any, context: any) => Component {
  return (args: any, theme: any, context: any) => {
    const component = textComponent(context);
    let text = theme.bold(theme.fg("toolTitle", spec.title));
    const path = typeof args?.path === "string" ? args.path : undefined;
    const symbol = spec.subject === "symbol" ? callSubject(args, context) : undefined;

    if (symbol !== undefined) text += ` ${theme.fg("accent", symbol)}`;
    else if (path !== undefined) text += ` ${theme.fg("accent", path)}`;

    const newName = spec.newName?.(args);
    if (newName !== undefined && newName !== "") text += ` ${theme.fg("muted", "→")} ${theme.fg("accent", newName)}`;

    // A position only earns its place when it adds something the symbol does
    // not already say.
    if (symbol !== undefined && path !== undefined) {
      text += theme.fg("muted", ` · ${path}${args.line === undefined ? "" : `:${args.line}:${args.character ?? "?"}`}`);
    } else if (symbol === undefined && path !== undefined && args?.line !== undefined) {
      text += theme.fg("muted", `:${args.line}:${args.character ?? "?"}`);
    }

    const list = spec.flags?.(args) ?? [];
    if (list.length > 0) {
      text += context?.expanded
        ? list.map((flag) => `\n${theme.fg("muted", `  ${flag}`)}`).join("")
        : theme.fg("muted", ` · ${list.join(" · ")}`);
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
