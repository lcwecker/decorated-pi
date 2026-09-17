/**
 * patch — unified-diff rendering for previews and results.
 *
 * Two entry points into the same hunk machinery: `generatePatchDiff`
 * (result rendering) and `generateLocalDiff` (preview rendering).
 */

import { CONTEXT_LINES } from "./lines.js";
import type { PatchResult, ReplacementInfo } from "./types.js";

export function generatePatchDiff(result: PatchResult): string {
  // If applyEdits pre-generated the diff, use it directly (avoids re-reading files)
  if (result.diff) {
    return result.diff;
  }

  // Fallback: reconstruct diff from stored originalLines (legacy path)
  const parts: string[] = [];
  for (const [filePath, reps] of result.replacements) {
    const origLines = result.originalLines.get(filePath) ?? [];
    parts.push(generateReplacementDiff(filePath, reps, origLines));
  }
  return parts.join("\n");
}

interface ReplacementChunk {
  startLine: number;
  endLine: number;
  reps: ReplacementInfo[];
}

function buildReplacementChunks(
  reps: ReplacementInfo[],
  totalLines: number,
  contextLines: number,
): ReplacementChunk[] {
  const sorted = [...reps].sort((a, b) => a.oldStartLine - b.oldStartLine);
  const chunks: ReplacementChunk[] = [];

  for (const rep of sorted) {
    const startLine = Math.max(1, rep.oldStartLine - contextLines);
    const endLine = Math.min(totalLines, rep.oldEndLine + contextLines);
    const current = chunks[chunks.length - 1];

    if (current && startLine <= current.endLine + 1) {
      current.endLine = Math.max(current.endLine, endLine);
      current.reps.push(rep);
    } else {
      chunks.push({ startLine, endLine, reps: [rep] });
    }
  }

  return chunks;
}

interface ChunkAnchor {
  text: string;
  missing: boolean;
  notUnique?: boolean;
}

function getChunkAnchors(chunk: ReplacementChunk): ChunkAnchor[] {
  const byText = new Map<string, ChunkAnchor>();
  for (const rep of chunk.reps) {
    const raw = rep.anchor?.trim();
    if (!raw) continue;
    // Support \n-separated anchors from collapsed sequential replacements
    const texts = raw.includes("\n") ? raw.split("\n").map(s => s.trim()).filter(Boolean) : [raw];
    for (const text of texts) {
      const existing = byText.get(text);
      if (!existing) {
        byText.set(text, { text, missing: Boolean(rep.anchorMissing), notUnique: Boolean(rep.anchorNotUnique) });
      } else {
        // A later rep with the same anchor text that did NOT degrade clears
        // the stale flag — the anchor is usable in at least one rep, so
        // don't keep a stale warning for the other.
        if (!rep.anchorMissing) existing.missing = false;
        if (!rep.anchorNotUnique) existing.notUnique = false;
      }
    }
  }
  return [...byText.values()];
}

function formatAnchorLabel(anchor: ChunkAnchor): string {
  if (anchor.notUnique) return anchor.text + " (not unique)";
  if (anchor.missing) return anchor.text + " (missing)";
  return anchor.text;
}

function formatChunkHeader(chunk: ReplacementChunk): string {
  const range = chunk.startLine === chunk.endLine
    ? String(chunk.startLine)
    : `${chunk.startLine}-${chunk.endLine}`;

  const anchors = getChunkAnchors(chunk);
  if (anchors.length === 0) {
    return `@@ lines ${range} @@`;
  }

  if (anchors.length === 1) {
    return `@@ lines ${range} @@ anchor: ${formatAnchorLabel(anchors[0]!)}`;
  }

  return `@@ lines ${range} @@`;
}

function formatChunkMetadataLines(chunk: ReplacementChunk): string[] {
  const anchors = getChunkAnchors(chunk);
  if (anchors.length <= 1) return [];

  const shown = anchors.slice(0, 2);
  const remaining = anchors.length - shown.length;
  const lines = ["anchors:", ...shown.map((anchor) => `  - ${formatAnchorLabel(anchor)}`)];
  if (remaining > 0) {
    lines.push(`  - +${remaining} more`);
  }
  return lines;
}

type RenderOp =
  | { type: "context"; line: number; text: string; /** New-file line number (differs from `line` when there are added/removed lines before it). Optional for backward compat. */ newLine?: number }
  | { type: "removed"; line: number; text: string; /** Optional for type compatibility — removed lines always keep their original `line` and never receive a `newLine` assignment. */ newLine?: number }
  | { type: "added"; line: number; text: string; /** New-file line number (differs from `line` when there are added/removed lines before it). Optional for backward compat. */ newLine?: number };

interface RenderableReplacement {
  operations: RenderOp[];
  /** Line number of the first removed/added operation (BEFORE trimming).
   *  Used to limit how far "context before" extends. */
  firstChangeLine: number;
  /** Line number of the last removed/added operation (BEFORE trimming). */
  lastChangeLine: number;
}

/** Compute a minimal line-level diff between old and new lines using LCS.
 *  Common lines become context, while only truly different lines become
 *  removed/added. The resulting context is trimmed to `contextLines` lines
 *  before the first and after the last non-context operation so the TUI hunk
 *  doesn't grow with the size of the LLM's old_str. */
function splitReplacementForRender(
  rep: ReplacementInfo,
  contextLines: number,
): RenderableReplacement {
  const m = rep.oldLines.length;
  const n = rep.newLines.length;

  // DP table: dp[i][j] = LCS length of oldLines[0..i) and newLines[0..j)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (rep.oldLines[i - 1] === rep.newLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack to produce operations in reverse order.
  const stack: RenderOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (rep.oldLines[i - 1] === rep.newLines[j - 1]) {
      stack.push({ type: "context", line: rep.oldStartLine + i - 1, text: rep.oldLines[i - 1]! });
      i--;
      j--;
    } else if (dp[i - 1]![j]! > dp[i]![j - 1]!) {
      stack.push({ type: "removed", line: rep.oldStartLine + i - 1, text: rep.oldLines[i - 1]! });
      i--;
    } else {
      stack.push({ type: "added", line: rep.oldStartLine + j - 1, text: rep.newLines[j - 1]! });
      j--;
    }
  }
  while (i > 0) {
    stack.push({ type: "removed", line: rep.oldStartLine + i - 1, text: rep.oldLines[i - 1]! });
    i--;
  }
  while (j > 0) {
    stack.push({ type: "added", line: rep.oldStartLine + j - 1, text: rep.newLines[j - 1]! });
    j--;
  }

  // Reverse to get the final order.
  const operations: RenderOp[] = [];
  while (stack.length > 0) operations.push(stack.pop()!);

  // Find first and last non-context operations (in the original order).
  let firstChangeLine = rep.oldStartLine;
  let lastChangeLine = rep.oldStartLine;
  for (const op of operations) {
    if (op.type !== "context") {
      firstChangeLine = op.line;
      break;
    }
  }
  for (let k = operations.length - 1; k >= 0; k--) {
    if (operations[k]!.type !== "context") {
      lastChangeLine = operations[k]!.line;
      break;
    }
  }

  // Trim context operations that sit far from any non-context change.
  const firstNonContextIdx = operations.findIndex(op => op.type !== "context");
  if (firstNonContextIdx === -1) {
    return { operations: [], firstChangeLine, lastChangeLine };
  }
  let lastNonContextIdx = operations.length - 1;
  for (let k = operations.length - 1; k >= 0; k--) {
    if (operations[k]!.type !== "context") { lastNonContextIdx = k; break; }
  }
  const start = Math.max(0, firstNonContextIdx - contextLines);
  const end = Math.min(operations.length - 1, lastNonContextIdx + contextLines);
  const trimmed = operations.slice(start, end + 1);

  // Second pass: compute the new-file line number for each operation.
  // Standard unified-diff convention: context/removed use ORIGINAL line
  // numbers; added use NEW-file line numbers (so they don't collide with
  // the line numbers of unchanged lines that follow in the file).
  let newLineCounter = rep.oldStartLine;
  for (const op of trimmed) {
    if (op.type === "context" || op.type === "added") {
      op.newLine = newLineCounter;
      newLineCounter++;
    }
    // removed: no new-file line; skip increment
  }

  return { operations: trimmed, firstChangeLine, lastChangeLine };
}

/** Compute the actual hunk range for a chunk by looking at the rendered
 *  context (before / after) and the LCS-trimmed operations. Returns
 *  [startLine, endLine] (1-based, inclusive). */
function computeRenderedRange(
  chunk: ReplacementChunk,
  repViews: Array<{ rep: ReplacementInfo; view: RenderableReplacement; beforeStart: number; afterEnd: number }>,
  totalLines: number,
  contextLines: number,
): { startLine: number; endLine: number } {
  let renderedStart = Infinity;
  let renderedEnd = -Infinity;
  for (const { view, beforeStart, afterEnd } of repViews) {
    // Skip reps with no operations (no changes to render). The original
    // check also required beforeStart >= oldStartLine && afterEnd <= oldEndLine,
    // but that fails when oldStartLine > CONTEXT_LINES (beforeStart would be
    // oldStartLine - CONTEXT_LINES < oldStartLine), causing view.operations[0]
    // to be undefined and throw "Cannot read properties of undefined".
    if (view.operations.length === 0) continue;
    // Use the new-file line number of the first/last operations so the
    // hunk header matches the line numbers used in the diff content.
    const opStart = view.operations[0]!.newLine ?? view.operations[0]!.line;
    const opEnd = view.operations[view.operations.length - 1]!.newLine ?? view.operations[view.operations.length - 1]!.line;
    // beforeStart / afterEnd are in original line numbers; convert via
    // the offset of this rep's operations. For a clean approximation
    // (and to avoid running into line-number collisions), use the rep's
    // own oldStartLine/oldEndLine as the anchor for the conversion.
    const origStart = view.operations[0]!.line;
    const origEnd = view.operations[view.operations.length - 1]!.line;
    const beforeNew = opStart - (origStart - beforeStart);
    const afterNew = opEnd + (afterEnd - origEnd);
    const s = Math.min(beforeNew, opStart);
    const e = Math.max(afterNew, opEnd);
    if (s < renderedStart) renderedStart = s;
    if (e > renderedEnd) renderedEnd = e;
  }
  if (renderedStart === Infinity) {
    return { startLine: chunk.startLine, endLine: chunk.endLine };
  }
  return { startLine: renderedStart, endLine: Math.min(totalLines, renderedEnd) };
}

/**
 * Generate diff as visual chunks merged by overlapping/adjacent context windows.
 * This keeps spacing stable when multiple nearby edits would otherwise create
 * repeated context and oversized gaps between chunks.
 */
export function generateReplacementDiff(filePath: string, reps: ReplacementInfo[], originalLines: string[]): string {
  const parts: string[] = [];

  if (reps.length === 0) {
    return "";
  }

  const maxLineNum = Math.max(originalLines.length, ...reps.map(r => r.oldEndLine));
  const numWidth = String(maxLineNum).length;
  const CONTEXT = 3;
  const chunks = buildReplacementChunks(reps, originalLines.length, CONTEXT);
  let firstHunk = true;

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]!;

    // Pre-compute the rendered range for this chunk so the hunk header
    // reflects what we actually emit (not the full chunk window).
    const repViews = chunk.reps.map(rep => {
      const v = splitReplacementForRender(rep, CONTEXT);
      const beforeStart = Math.max(chunk.startLine, v.firstChangeLine - CONTEXT);
      const afterEnd = Math.min(chunk.endLine, v.lastChangeLine + CONTEXT);
      return { rep, view: v, beforeStart, afterEnd };
    });

    // Skip hunk entirely if every rep produced no effective changes
    // (e.g., LLM sent old_str === new_str). Rendering context-only hunks
    // is misleading — there is nothing to show.
    if (repViews.every(r => r.view.operations.length === 0)) continue;

    const { startLine: renderedStart, endLine: renderedEnd } = computeRenderedRange(
      chunk, repViews, originalLines.length, CONTEXT,
    );
    const syntheticChunk = { ...chunk, startLine: renderedStart, endLine: renderedEnd };
    parts.push(formatChunkHeader(syntheticChunk));
    parts.push(...formatChunkMetadataLines(syntheticChunk));

    let lastOutputLine = 0;
    for (const { rep, view, beforeStart } of repViews) {
      // Skip no-op reps (old_str === new_str): no changes to show, and
      // emitting their context lines would mislead the reader.
      if (view.operations.length === 0) continue;

      // Context before this rep. Start from `lastOutputLine + 1` to
      // avoid duplicating context lines already emitted by the previous
      // rep's before-context window or operations.
      const ctxStart = Math.max(lastOutputLine + 1, beforeStart);
      for (let i = ctxStart; i < rep.oldStartLine; i++) {
        const num = String(i).padStart(numWidth, " ");
        parts.push(` ${num} ${originalLines[i - 1]}`);
        lastOutputLine = i;
      }

      for (const op of view.operations) {
        // Use the new-file line number for context and added lines so
        // they don't conflict with the original-file line numbers used by
        // the trailing-context loop. Removed lines keep the original.
        const newNum = op.newLine !== undefined
          ? String(op.newLine).padStart(numWidth, " ")
          : String(op.line).padStart(numWidth, " ");
        const origNum = String(op.line).padStart(numWidth, " ");
        if (op.type === "context") {
          parts.push(` ${newNum} ${op.text}`);
          lastOutputLine = op.line;
        }
        // For removed lines, use the file's actual content (not the LLM's
        // old_str) so leading whitespace is preserved even if the LLM
        // stripped it from the old_str.
        else if (op.type === "removed") {
          const fileLine = originalLines[op.line - 1] ?? op.text;
          parts.push(`-${origNum} ${fileLine}`);
          lastOutputLine = op.line;
        }
        else {
          parts.push(`+${newNum} ${op.text}`);
        }
      }
    }

    // Trailing context after the LAST NON-NOOP rep. Use new-file line
    // numbers (offset from the last operation's newLine) so trailing
    // context doesn't collide with added lines.
    let lastRealEntry: typeof repViews[number] | undefined;
    for (const rv of repViews) {
      if (rv.view.operations.length > 0) lastRealEntry = rv;
    }
    if (lastRealEntry) {
      const lastOp = lastRealEntry.view.operations[lastRealEntry.view.operations.length - 1];
      const lastNewLine = lastOp?.newLine ?? lastOp?.line ?? lastRealEntry.rep.oldEndLine;
      const lastOrigLine = lastOp?.line ?? lastRealEntry.rep.oldEndLine;
      // Start from lastOutputLine + 1 to avoid duplicating context
      // already emitted.
      const ctxStart = Math.max(lastOutputLine + 1, lastRealEntry.rep.oldEndLine + 1);
      for (let i = ctxStart; i <= lastRealEntry.afterEnd; i++) {
        const num = String(lastNewLine + (i - lastOrigLine)).padStart(numWidth, " ");
        parts.push(` ${num} ${originalLines[i - 1]}`);
      }
    }
  }

  return parts.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════════════════════════

// Note: a previous `formatPatchResult` helper lived here. It was removed
// when the tool's execute() was simplified to return a constant "Success"
// string (the LLM already knows what it asked to change, so the summary
// was redundant and cost prompt-cache stability). If callers need to
// surface the file list to a non-LLM UI, they can format `result.modified`
// and `result.created` themselves — they are plain `string[]`.

/** Collapse chained-edit replacements (where out[i] === in[i+1]) into
 *  net-change replacements showing only the net effect (original→final). */
export function collapseSequentialReplacements(
  reps: ReplacementInfo[],
): ReplacementInfo[] {
  const collapsed: ReplacementInfo[] = [];
  let i = 0;
  while (i < reps.length) {
    const start = reps[i]!;
    let merged: ReplacementInfo = {
      ...start,
      newStartLine: start.oldStartLine,
      newEndLine: start.oldStartLine + start.newLines.length - 1,
    };

    const anchors: string[] = [];
    const seenAnchors = new Set<string>();
    const addAnchor = (raw?: string) => {
      if (!raw) return;
      for (const text of raw.split("\n").map(s => s.trim()).filter(Boolean)) {
        if (seenAnchors.has(text)) continue;
        seenAnchors.add(text);
        anchors.push(text);
      }
    };
    addAnchor(start.anchor);

    let j = i + 1;
    while (j < reps.length) {
      const next = reps[j]!;
      // Merge chained edits when next edit's input matches merged output.
      // We allow slightly shifted line numbers because sequential edits can
      // change string lengths before we compute displayed line ranges.
      if (!(linesEqual(merged.newLines, next.oldLines) && next.oldStartLine <= merged.oldEndLine + 1)) {
        break;
      }
      addAnchor(next.anchor);
      merged = {
        // Keep the ORIGINAL region from the first replacement in the chain.
        // Later chained replacements may have shifted line numbers, but the
        // net diff should still point at the original file region.
        oldStartLine: merged.oldStartLine,
        oldEndLine: merged.oldEndLine,
        newStartLine: merged.oldStartLine,
        newEndLine: merged.oldStartLine + next.newLines.length - 1,
        oldLines: merged.oldLines,
        newLines: next.newLines,
        newStr: next.newStr,
        normStart: merged.normStart,
        normEnd: merged.normEnd,
        anchor: undefined,
        anchorMissing: merged.anchorMissing || next.anchorMissing,
        anchorNotUnique: merged.anchorNotUnique || next.anchorNotUnique,
      };
      j++;
    }

    collapsed.push({
      ...merged,
      anchor: anchors.length > 0 ? anchors.join("\n") : undefined,
    });
    i = j;
  }
  return collapsed;
}

export function linesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Generate diff using only the needed lines (partial file context).
 */
export function generateLocalDiff(
  filePath: string,
  reps: ReplacementInfo[],
  neededLines: Map<number, string>,
  totalLines: number,
): string {
  if (reps.length === 0) return "";

  const parts: string[] = [];
  let firstHunk = true;

  // Calculate dynamic width based on max line number
  const maxLineNum = Math.max(totalLines, ...reps.map(r => r.oldEndLine));
  const numWidth = String(maxLineNum).length;

  // Merge replacement chunks
  const chunks = buildReplacementChunks(reps, totalLines, CONTEXT_LINES);
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]!;

    // Pre-compute the rendered range so the hunk header reflects what we
    // actually emit (not the full chunk window).
    const repViews = chunk.reps.map(rep => {
      const view = splitReplacementForRender(rep, CONTEXT_LINES);
      const beforeStart = Math.max(chunk.startLine, view.firstChangeLine - CONTEXT_LINES);
      const afterEnd = Math.min(chunk.endLine, view.lastChangeLine + CONTEXT_LINES);
      return { rep, view, beforeStart, afterEnd };
    });

    // Skip hunk entirely if every rep produced no effective changes
    // (e.g., LLM sent old_str === new_str). Rendering context-only hunks
    // is misleading — there is nothing to show.
    if (repViews.every(r => r.view.operations.length === 0)) continue;

    if (firstHunk) {
      parts.push(`--- ${filePath}`);
      parts.push(`+++ ${filePath}`);
      firstHunk = false;
    } else {
      parts.push("");
    }

    const { startLine: renderedStart, endLine: renderedEnd } = computeRenderedRange(
      chunk, repViews, totalLines, CONTEXT_LINES,
    );
    const syntheticChunk = { ...chunk, startLine: renderedStart, endLine: renderedEnd };
    parts.push(formatChunkHeader(syntheticChunk));
    parts.push(...formatChunkMetadataLines(syntheticChunk));

    // Output context + removed + added
    let lastOutputLine = 0;
    for (const { rep, view, beforeStart } of repViews) {
      // Skip no-op reps (old_str === new_str): no changes to show, and
      // emitting their context lines would mislead the reader.
      if (view.operations.length === 0) continue;

      // Context before this rep. Start from `lastOutputLine + 1` (not
      // `beforeStart`) to avoid duplicating context lines that were
      // already emitted by the previous rep's before-context window
      // or operations (common when multiple reps are close together).
      const ctxStart = Math.max(lastOutputLine + 1, beforeStart);
      for (let i = ctxStart; i < rep.oldStartLine; i++) {
        const lineText = neededLines.get(i);
        if (lineText !== undefined) {
          parts.push(` ${String(i).padStart(numWidth, " ")} ${lineText}`);
          lastOutputLine = i;
        }
      }

      for (const op of view.operations) {
        // Use the new-file line number for context and added lines so
        // they don't conflict with the original-file line numbers used by
        // the trailing-context loop. Removed lines keep the original.
        const newNum = op.newLine !== undefined
          ? String(op.newLine).padStart(numWidth, " ")
          : String(op.line).padStart(numWidth, " ");
        const origNum = String(op.line).padStart(numWidth, " ");
        if (op.type === "context") {
          parts.push(` ${newNum} ${op.text}`);
          lastOutputLine = op.line;
        }
        // For removed lines, use the file's actual content (not the LLM's
        // old_str) so leading whitespace is preserved even if the LLM
        // stripped it from the old_str.
        else if (op.type === "removed") {
          const fileLine = neededLines.get(op.line) ?? op.text;
          parts.push(`-${origNum} ${fileLine}`);
          lastOutputLine = op.line;
        }
        else {
          parts.push(`+${newNum} ${op.text}`);
          // Don't bump lastOutputLine for added (no original line to consume)
        }
      }
    }

    // Trailing context after the LAST NON-NOOP rep (a no-op's trailing
    // context would be based on the no-op's line range, not the real
    // change's end, which would skip past the real change's after-context).
    // Use new-file line numbers (offset from the last operation's newLine)
    // so trailing context doesn't collide with added lines.
    let lastRealEntry: typeof repViews[number] | undefined;
    for (const rv of repViews) {
      if (rv.view.operations.length > 0) lastRealEntry = rv;
    }
    if (lastRealEntry) {
      const lastOp = lastRealEntry.view.operations[lastRealEntry.view.operations.length - 1];
      const lastNewLine = lastOp?.newLine ?? lastOp?.line ?? lastRealEntry.rep.oldEndLine;
      const lastOrigLine = lastOp?.line ?? lastRealEntry.rep.oldEndLine;
      // Start from lastOutputLine + 1 to avoid duplicating context
      // already emitted (e.g., when the rep's operations ended with a
      // context op and then we'd otherwise re-emit the same line).
      const ctxStart = Math.max(lastOutputLine + 1, lastRealEntry.rep.oldEndLine + 1);
      for (let i = ctxStart; i <= lastRealEntry.afterEnd; i++) {
        const lineText = neededLines.get(i);
        if (lineText !== undefined) {
          const newLine = lastNewLine + (i - lastOrigLine);
          parts.push(` ${String(newLine).padStart(numWidth, " ")} ${lineText}`);
        }
      }
    }
  }

  return parts.join("\n");
}
