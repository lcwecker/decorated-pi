/**
 * LSP result formatting — the one implementation, imported by tools.ts and
 * locations.ts.
 *
 * Pure functions over LSP payloads and text: no client, no manager, no I/O, so
 * the tests exercise exactly the code the tools run.
 *
 * Everything here is written for two readers at once. The text it produces goes
 * to the model and is also what the TUI renderer falls back to, so a row carries
 * the path, the one-based position and the source line: the model can judge a
 * hit without a second `read`, and the user can see which reference it is.
 */
import type { LspDocumentSymbol, LspRange, LspTextEdit } from "./types.js";

const SYMBOL_KINDS: Record<number, string> = {
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class",
  6: "method", 7: "property", 8: "field", 9: "constructor", 10: "enum",
  11: "interface", 12: "function", 13: "variable", 14: "constant", 15: "string",
  16: "number", 17: "boolean", 18: "array", 19: "object", 20: "key",
  21: "null", 22: "enum member", 23: "struct", 24: "event", 25: "operator",
  26: "type parameter",
};

export function symbolKindName(kind: number): string {
  return SYMBOL_KINDS[kind] ?? `kind ${kind}`;
}

// ─── Locations ─────────────────────────────────────────────────────────────

/** One resolved location, ready to print. `line` and `character` are one-based,
 *  the convention every tool in this pack reports. */
export interface LocationRow {
  /** Printed path: relative to the caller's cwd when it lives under it. */
  file: string;
  line: number;
  character: number;
  /** Trimmed, tab-expanded source line; empty when the file could not be read. */
  source: string;
  /** Identifier covering the position — the symbol named by this hit. */
  symbol?: string;
  /** Offset of `symbol` inside `source`; absent when it no longer lines up. */
  symbolStart?: number;
}

/** Room for a call site without letting one line fill the terminal. */
export const SOURCE_MAX_CHARS = 160;

const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u;

/** The identifier covering `character` (zero-based, the LSP convention) and
 *  where it starts. Undefined when the column sits on whitespace or punctuation
 *  — a position that holds no symbol. */
export function identifierAt(
  lineText: string,
  character: number,
): { name: string; start: number } | undefined {
  const isIdentifier = (index: number) =>
    index >= 0 && index < lineText.length && IDENTIFIER_CHAR.test(lineText[index]);
  if (!isIdentifier(character)) return undefined;
  let start = character;
  while (isIdentifier(start - 1)) start -= 1;
  let end = character;
  while (isIdentifier(end)) end += 1;
  return { name: lineText.slice(start, end), start };
}

/** Path relative to `cwd` when it lives under it, unchanged otherwise. A
 *  reference outside the workspace keeps its absolute path: the shortened form
 *  would be a chain of `../` that says less. */
export function relativeToCwd(file: string, cwd: string | undefined): string {
  if (!cwd) return file;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return file.startsWith(base) ? file.slice(base.length) : file;
}

/** One display row of source: tabs expanded, indentation dropped, long lines
 *  cut — the path and position stay first, so a cut row is still navigable. */
export function truncateSource(text: string): string {
  const collapsed = text.replace(/\t/g, "   ").trim();
  if (collapsed.length <= SOURCE_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, SOURCE_MAX_CHARS - 3)}...`;
}

/** `path:line:character: source`, one per row — the shape the builtin grep
 *  prints, so a list of references reads without opening the files. */
export function formatLocationRows(rows: readonly LocationRow[], emptyMessage: string): string {
  if (rows.length === 0) return emptyMessage;
  return rows
    .map((row) => {
      const position = `${row.file}:${row.line}:${row.character}`;
      return row.source ? `${position}: ${row.source}` : position;
    })
    .join("\n");
}

/** Notice for a reply that returned fewer locations than the server knew about. */
export function limitNotice(shown: number, total: number): string {
  return `[Showing ${shown} of ${total} locations. Pass a higher limit for more, or narrow the query.]`;
}

// ─── Document symbols ──────────────────────────────────────────────────────

/** One outline row: the `documentSymbols` tree flattened, so the text reply and
 *  the renderer walk the same shape. */
export interface SymbolRow {
  depth: number;
  name: string;
  kind: number;
  line: number;
  character: number;
}

export function flattenDocumentSymbols(symbols: readonly LspDocumentSymbol[]): SymbolRow[] {
  const rows: SymbolRow[] = [];
  const walk = (list: readonly LspDocumentSymbol[], depth: number) => {
    for (const symbol of list) {
      rows.push({
        depth,
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.selectionRange.start.line + 1,
        character: symbol.selectionRange.start.character + 1,
      });
      if (symbol.children?.length) walk(symbol.children, depth + 1);
    }
  };
  walk(symbols, 0);
  return rows;
}

/** Indented outline. `children` from a hierarchical reply become nesting; a
 *  flat reply is a single level. */
export function formatDocumentSymbols(file: string, symbols: readonly LspDocumentSymbol[]): string {
  if (symbols.length === 0) return `${file}: no symbols`;
  return flattenDocumentSymbols(symbols)
    .map((row) => `${"  ".repeat(row.depth)}${row.name} (${symbolKindName(row.kind)}) ${row.line}:${row.character}`)
    .join("\n");
}

// ─── Edits ─────────────────────────────────────────────────────────────────

/** One edit, flattened for the text reply and the renderer. `before` and
 *  `after` are collapsed to one line: a preview is read, not applied. */
export interface ChangeRow {
  file: string;
  line: number;
  character: number;
  before: string;
  after: string;
}

/** The text one edit replaces. `character` is a UTF-16 offset, which is exactly
 *  a JS string index. */
export function textInRange(text: string, range: LspRange): string {
  const lines = text.split("\n");
  const first = lines[range.start.line] ?? "";
  if (range.start.line === range.end.line) {
    return first.slice(range.start.character, range.end.character);
  }
  const parts = [first.slice(range.start.character)];
  for (let line = range.start.line + 1; line < range.end.line; line++) parts.push(lines[line] ?? "");
  parts.push((lines[range.end.line] ?? "").slice(0, range.end.character));
  return parts.join("\n");
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `path:line:character: before → after`, one row per edit. */
export function formatChangeRows(rows: readonly ChangeRow[]): string {
  return rows
    .map((row) => `${row.file}:${row.line}:${row.character}: ${singleLine(row.before) || "(nothing)"} → ${singleLine(row.after)}`)
    .join("\n");
}

/** Every pending edit, grouped by file — the `preview: true` reply. */
export function formatChangeGroups(groups: ReadonlyArray<{ file: string; rows: ChangeRow[] }>): string {
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(`${group.file}: ${group.rows.length} edit(s)`);
    for (const row of group.rows) {
      lines.push(`  ${row.line}:${row.character}: ${singleLine(row.before) || "(nothing)"} → ${singleLine(row.after)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Apply LSP text edits to one file's contents.
 *
 * Edits are applied from the last position backwards: every offset before an
 * edit stays valid, so several edits in one file land where the server meant
 * them to. `character` is a UTF-16 offset, which is exactly a JS string index.
 *
 * A range outside the file throws instead of being dropped: a rename is written
 * to disk, so a range the server derived from a different snapshot must stop the
 * write rather than leave one edit silently unapplied. CRLF documents are
 * normalized for the edit and converted back, so a multi-line replacement does
 * not introduce mixed terminators.
 */
export function applyTextEdits(text: string, edits: readonly LspTextEdit[]): string {
  const crlf = text.includes("\r\n");
  const source = crlf ? text.replace(/\r\n/g, "\n") : text;
  let lines = source.split("\n");
  const ordered = [...edits].sort(
    (a, b) =>
      b.range.start.line - a.range.start.line ||
      b.range.start.character - a.range.start.character,
  );
  for (const edit of ordered) {
    const { start, end } = edit.range;
    const startLine = lines[start.line];
    const endLine = lines[end.line];
    const inRange =
      startLine !== undefined &&
      endLine !== undefined &&
      start.line >= 0 &&
      end.line >= start.line &&
      start.character >= 0 &&
      start.character <= startLine.length &&
      end.character >= 0 &&
      end.character <= endLine.length;
    if (!inRange) {
      const at = (p: { line: number; character: number }) => `${p.line + 1}:${p.character + 1}`;
      throw new RangeError(`edit range ${at(start)}–${at(end)} is outside ${source.split("\n").length} line(s)`);
    }
    const before = lines.slice(0, start.line);
    const after = lines.slice(end.line + 1);
    const head = startLine.slice(0, start.character);
    const tail = endLine.slice(end.character);
    const newText = crlf ? edit.newText.replace(/\r?\n/g, "\n") : edit.newText;
    lines = [...before, ...(head + newText + tail).split("\n"), ...after];
  }
  const result = lines.join("\n");
  return crlf ? result.replace(/\n/g, "\r\n") : result;
}
