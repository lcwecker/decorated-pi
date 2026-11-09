/**
 * LSP locations → printable rows.
 *
 * The server answers with URIs and zero-based positions. Three things the tools
 * need are not in that reply: a path relative to the workspace, the source line
 * under each position, and the identifier the position names. Reading the files
 * is the only way to get the last two, and it is what makes a reference list
 * readable — a call site, a type annotation and a comment are the same
 * `path:line:col` without their text.
 *
 * One read per file, not per location, and a file that cannot be read still
 * produces a row: the position stays useful without its text.
 */
import { readFile } from "node:fs/promises";
import { identifierAt, relativeToCwd, truncateSource, type LocationRow } from "./format.js";
import type { LspLocation } from "./types.js";
import { isLocalFilePath, uriToFilePath } from "./uri.js";

/** Locations one reply may carry. A workspace-wide list of a common name runs
 *  to thousands, and the transcript pays for every row. */
export const MAX_LOCATIONS = 100;

export interface LocationRows {
  rows: LocationRow[];
  /** Locations the server returned, before the limit. */
  total: number;
  /** Distinct files across every location, including the omitted ones. */
  files: number;
  /** Rows the limit hid. */
  omitted: number;
}

export async function readLocationRows(
  locations: readonly LspLocation[],
  options: { cwd?: string; limit?: number } = {},
): Promise<LocationRows> {
  const limit = Math.max(1, options.limit ?? MAX_LOCATIONS);
  const files = new Set(locations.map((location) => uriToFilePath(location.uri)));
  const shown = locations.slice(0, limit);
  const cache = new Map<string, string[] | undefined>();
  const rows: LocationRow[] = [];
  for (const location of shown) {
    const file = uriToFilePath(location.uri);
    const start = location.range.start;
    const row: LocationRow = {
      file: relativeToCwd(file, options.cwd),
      line: start.line + 1,
      character: start.character + 1,
      source: "",
    };
    if (isLocalFilePath(file)) {
      const raw = (await sourceLines(file, cache))?.[start.line];
      if (raw !== undefined) {
        row.source = truncateSource(raw);
        const identifier = identifierAt(raw, start.character);
        if (identifier) {
          row.symbol = identifier.name;
          // The printed source is trimmed and tab-expanded, so the highlight
          // only lands when the offset still points at the same text.
          const indent = raw.length - raw.trimStart().length;
          const offset = identifier.start - indent;
          if (offset >= 0 && row.source.slice(offset, offset + identifier.name.length) === identifier.name) {
            row.symbolStart = offset;
          }
        }
      }
    }
    rows.push(row);
  }
  return {
    rows,
    total: locations.length,
    files: files.size,
    omitted: Math.max(0, locations.length - shown.length),
  };
}

async function sourceLines(
  file: string,
  cache: Map<string, string[] | undefined>,
): Promise<string[] | undefined> {
  if (cache.has(file)) return cache.get(file);
  let lines: string[] | undefined;
  try {
    lines = (await readFile(file, "utf-8")).split("\n");
  } catch {
    // Deleted, unreadable, or generated outside the workspace: the row keeps
    // its position, which is still something to open.
  }
  cache.set(file, lines);
  return lines;
}

/** The identifier at a query position, for a result header: `12 references to
 *  renderKeyHint`. Undefined when the position holds no identifier. */
export async function symbolAtPosition(
  file: string,
  position: { line: number; character: number },
): Promise<string | undefined> {
  const raw = (await sourceLines(file, new Map()))?.[position.line - 1];
  return raw === undefined ? undefined : identifierAt(raw, position.character - 1)?.name;
}
