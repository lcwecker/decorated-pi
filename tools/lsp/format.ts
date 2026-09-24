/**
 * LSP result formatting — the one implementation, imported by tools.ts.
 *
 * Pure functions over LSP payloads: no client, no manager, no I/O, so the
 * tests exercise exactly the code the tools run.
 */
import type { LspDocumentSymbol, LspLocation, LspTextEdit } from "./types.js";
import { uriToFilePath } from "./uri.js";

const SYMBOL_KINDS: Record<number, string> = {
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class",
  6: "method", 7: "property", 8: "field", 9: "constructor", 10: "enum",
  11: "interface", 12: "function", 13: "variable", 14: "constant", 15: "string",
  16: "number", 17: "boolean", 18: "array", 19: "object", 20: "key",
  21: "null", 22: "enum member", 23: "struct", 24: "event", 25: "operator",
  26: "type parameter",
};

/** One `path:line:character` per location, one-based like a reader sees it. */
export function formatLocations(locations: LspLocation[], emptyMessage: string): string {
  if (locations.length === 0) return emptyMessage;
  return locations
    .map((loc) => `${uriToFilePath(loc.uri)}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`)
    .join("\n");
}

/** Indented outline. `children` from a hierarchical reply become nesting; a
 *  flat reply is a single level. */
export function formatDocumentSymbols(file: string, symbols: LspDocumentSymbol[]): string {
  if (symbols.length === 0) return `${file}: no symbols`;
  const lines: string[] = [];
  const walk = (list: LspDocumentSymbol[], depth: number) => {
    for (const symbol of list) {
      const kind = SYMBOL_KINDS[symbol.kind] ?? `kind ${symbol.kind}`;
      const pos = `${symbol.selectionRange.start.line + 1}:${symbol.selectionRange.start.character + 1}`;
      lines.push(`${"  ".repeat(depth)}${symbol.name} (${kind}) ${pos}`);
      if (symbol.children?.length) walk(symbol.children, depth + 1);
    }
  };
  walk(symbols, 0);
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
export function applyTextEdits(text: string, edits: LspTextEdit[]): string {
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

/** Every pending edit, grouped by file — the `preview: true` reply. */
export function formatEditList(edits: Record<string, LspTextEdit[]>): string {
  const lines: string[] = [];
  for (const [file, list] of Object.entries(edits)) {
    lines.push(`${file}: ${list.length} edit(s)`);
    for (const edit of list) {
      const pos = `${edit.range.start.line + 1}:${edit.range.start.character + 1}`;
      lines.push(`  ${pos} → ${JSON.stringify(edit.newText)}`);
    }
  }
  return lines.join("\n");
}
