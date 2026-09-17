/**
 * patch — line, offset, and path helpers.
 *
 * Pure text arithmetic plus the path helpers used by the apply path.
 * No knowledge of edits, anchors, or diffs.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

export function resolveAbsPath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

export function ensureParentDir(absPath: string): void {
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** A replacement expressed in coordinates of the normalized (\n-only) content,
 *  paired with the exact new_str to drop in. Used by spliceOntoRaw to rebuild
 *  the file byte-for-byte on the original rawContent. */
export interface RawSplice {
  /** Offset in the normalized content where the matched text starts. */
  normStart: number;
  /** Offset in the normalized content one past the matched text. */
  normEnd: number;
  /** Verbatim replacement text (already normalized to \n). */
  newStr: string;
}

/** Map every index of the normalized content to its offset in rawContent.
 *  The two strings differ only by `\r` bytes (CRLF→LF normalization removed
 *  them), so we walk both in lockstep. O(n). */
export function buildNormToRawMap(raw: string, norm: string): Int32Array {
  const map = new Int32Array(norm.length + 1);
  let ri = 0;
  for (let ni = 0; ni <= norm.length; ni++) {
    // Skip any `\r` in raw that the normalization folded into `\n`.
    // norm[ni] corresponds to raw[ri]; when norm advances past a `\n` that
    // came from `\r\n`, raw must skip the `\r` first.
    if (ni < norm.length) {
      map[ni] = ri;
      const ch = norm.charCodeAt(ni);
      const rawCh = raw.charCodeAt(ri);
      if (ch === 10 /* \n */ && rawCh === 13 /* \r */) {
        // raw had \r\n; advance past \r then \n
        ri += 2;
      } else {
        ri += 1;
      }
    } else {
      map[ni] = raw.length;
    }
  }
  return map;
}

/** Rebuild the file on top of the original rawContent: untouched regions keep
 *  their original bytes (including CRLF / mixed endings), edited regions get
 *  the verbatim newStr the caller supplied. Splices must be sorted by
 *  normStart and non-overlapping. */
export function spliceOntoRaw(rawContent: string, splices: RawSplice[]): string {
  if (splices.length === 0) return rawContent;
  const norm = normalizeLineEndings(rawContent);
  const map = buildNormToRawMap(rawContent, norm);
  let out = "";
  let rawCursor = 0;
  for (const s of splices) {
    const rawStart = map[s.normStart] ?? 0;
    const rawEnd = map[s.normEnd] ?? rawContent.length;
    if (rawStart > rawCursor) out += rawContent.substring(rawCursor, rawStart);
    out += s.newStr;
    rawCursor = rawEnd;
  }
  if (rawCursor < rawContent.length) out += rawContent.substring(rawCursor);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Line range utilities (for partial file reading)
// ═══════════════════════════════════════════════════════════════════════════

export const CONTEXT_LINES = 3;

export interface LineRange {
  startLine: number;
  endLine: number;
}

/** Build line offset table: offsets[i] = character offset of line i+1 (1-based).
 *  If the content does not end with a newline, the final line has no
 *  trailing marker; push an extra offset at content.length so callers
 *  like lineAtOffset / extractLineRange handle the last line correctly. */
export function buildLineOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") offsets.push(i + 1);
  }
  if (content.length > 0 && content[content.length - 1] !== "\n") {
    offsets.push(content.length);
  }
  return offsets;
}


/** Binary search: find 1-based line number containing charOffset */
export function lineAtOffset(lineOffsets: number[], charOffset: number): number {
  let lo = 0, hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineOffsets[mid] <= charOffset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Binary search: find line start offset given 1-based line number */
export function offsetAtLine(lineOffsets: number[], lineNum: number): number {
  if (lineNum <= 1) return 0;
  if (lineNum > lineOffsets.length) return lineOffsets[lineOffsets.length - 1];
  return lineOffsets[lineNum - 1];
}

/** Extract a range of lines from content (1-based, inclusive) */
export function extractLineRange(content: string, lineOffsets: number[], startLine: number, endLine: number): string[] {
  const lines: string[] = [];
  for (let i = startLine; i <= endLine; i++) {
    const start = offsetAtLine(lineOffsets, i);
    const end = offsetAtLine(lineOffsets, i + 1);
    // Remove trailing \n from last line if present
    const lineText = content.slice(start, end).replace(/\n$/, "");
    lines.push(lineText);
  }
  return lines;
}


/** Merge overlapping/adjacent line ranges */
export function mergeRanges(ranges: LineRange[]): LineRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine);
  const merged: LineRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, r.endLine);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Convert a character offset to a 1-based line number. */
export function charOffsetToLine(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}
