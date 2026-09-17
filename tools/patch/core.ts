/**
 * Patch — Exact string replacement for pi
 *
 * Replaces diff-based format with old_str/new_str matching.
 * No fuzzy matching, no similarity — only exact string matching.
 *
 * Per-file operations:
 *   { path, edits: [{ old_str, new_str, anchor? }] }  — targeted replacements
 *   { path, overwrite: true, new_str }                — atomic full-file overwrite
 *
 * This module owns the apply API and the preview API. Everything else lives
 * in sibling modules and is re-exported here so importers keep one entry
 * point:
 *   types.ts       — Edit / FilePatch / PatchResult / ReplacementInfo + errors
 *   lines.ts       — line, offset, and path helpers
 *   locate.ts      — anchor / exact / fuzzy edit location
 *   diagnostics.ts — old_str mismatch hints
 *   diff.ts        — unified-diff rendering
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  detectFileEncoding,
  readFileDecoded,
  writeFileEncoded,
  type FileEncoding,
} from "./encoding.js";

import {
  collapseSequentialReplacements,
  generateLocalDiff,
  generateReplacementDiff,
} from "./diff.js";
import {
  detectTabWidth,
  diagnoseOldStrMismatch,
  normalizeIndentForFuzzy,
  truncate,
} from "./diagnostics.js";
import { locateEdit, type LocateEditResult } from "./locate.js";
import {
  buildLineOffsets,
  buildNormToRawMap,
  charOffsetToLine,
  CONTEXT_LINES,
  ensureParentDir,
  extractLineRange,
  lineAtOffset,
  mergeRanges,
  normalizeLineEndings,
  randomId,
  resolveAbsPath,
  spliceOntoRaw,
  type LineRange,
} from "./lines.js";
import {
  ApplyError,
  ParseError,
  type Edit,
  type FilePatch,
  type PatchResult,
  type ReplacementInfo,
} from "./types.js";

// ── Public surface ────────────────────────────────────────────────────────
// `tools/patch/core.js` stays the single entry point for tools and tests.
export type { Edit, FilePatch, PatchResult, ReplacementInfo } from "./types.js";
export { ApplyError, ParseError } from "./types.js";
export { generatePatchDiff } from "./diff.js";
export { diagnoseOldStrMismatch, diagnoseOldStrNotUnique } from "./diagnostics.js";

// ═══════════════════════════════════════════════════════════════════════════
// Main API
// ═══════════════════════════════════════════════════════════════════════════

export async function applyPatch(patch: FilePatch, cwd: string): Promise<PatchResult> {
  if (!patch.path?.trim()) throw new ParseError("File path cannot be empty.");

  const result: PatchResult = {
    modified: [],
    created: [],
    warnings: [],
    replacements: new Map(),
    originalLines: new Map(),
    diff: "",
  };

  const absPath = resolveAbsPath(cwd, patch.path);

  if (patch.overwrite) {
    applyOverwrite(absPath, patch.path, patch.new_str ?? "", result);
  } else if (patch.edits && patch.edits.length > 0) {
    await applyEdits(absPath, patch.path, patch.edits, result);
  } else {
    throw new ParseError(
      `File ${patch.path}: must provide either edits[] or overwrite:true with new_str.`
    );
  }

  return result;
}

/** @deprecated Use applyPatch instead. Kept for backward compatibility with tests. */
export async function applyPatches(patches: FilePatch[], cwd: string): Promise<PatchResult> {
  if (!Array.isArray(patches) || patches.length === 0) {
    throw new ParseError("Patch is empty — no files specified.");
  }

  const result: PatchResult = {
    modified: [],
    created: [],
    warnings: [],
    replacements: new Map(),
    originalLines: new Map(),
    diff: "",
  };

  for (const p of patches) {
    if (!p.path?.trim()) throw new ParseError("File path cannot be empty.");

    const absPath = resolveAbsPath(cwd, p.path);

    if (p.overwrite) {
      applyOverwrite(absPath, p.path, p.new_str ?? "", result);
    } else if (p.edits && p.edits.length > 0) {
      await applyEdits(absPath, p.path, p.edits, result);
    } else {
      throw new ParseError(
        `File ${p.path}: must provide either edits[] or overwrite:true with new_str.`
      );
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// Overwrite (atomic mv)
// ═══════════════════════════════════════════════════════════════════════════

function applyOverwrite(
  absPath: string,
  displayPath: string,
  content: string,
  result: PatchResult,
): void {
  // Detect encoding from the existing file so we round-trip in the same
  // bytes. New files default to UTF-8 (no BOM).
  const enc: FileEncoding | null = fs.existsSync(absPath)
    ? detectFileEncoding(absPath)
    : null;
  const oldContent = enc ? readFileDecoded(absPath, enc) : "";

  // Write to temp file in the same directory (same filesystem → mv is atomic)
  ensureParentDir(absPath);
  const dir = path.dirname(absPath);
  const tmpName = path.join(dir, `.pi-patch-${randomId()}.tmp`);
  // Overwrite semantics: write exactly what the caller passed, in the
  // detected encoding (UTF-8 for new files).
  writeFileEncoded(tmpName, content, enc ?? { encoding: "utf-8", hasBOM: false, isUtf8: true });
  fs.renameSync(tmpName, absPath);

  if (oldContent) {
    result.modified.push(displayPath);
  } else {
    result.created.push(displayPath);
  }
}
async function applyEdits(
  absPath: string,
  displayPath: string,
  edits: Edit[],
  result: PatchResult,
): Promise<void> {
  if (!fs.existsSync(absPath)) {
    throw new ApplyError(`File not found: ${displayPath}`);
  }
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    throw new ApplyError(`Cannot patch directory: ${displayPath}`);
  }

  const enc = detectFileEncoding(absPath);
  const rawContent = readFileDecoded(absPath, enc);
  const originalContent = normalizeLineEndings(rawContent);

  // Precompute line offsets for the original file (used throughout)
  const lineOffsets = buildLineOffsets(originalContent);
  const totalLines = lineOffsets.length - 1;

  // ═══════════════════════════════════════════════════════════════════
  // Phase 1: try matching every old_str against the ORIGINAL snapshot.
  // If any edit requires content from a prior edit (chained dependency),
  // fall back to sequential mode.
  // ═══════════════════════════════════════════════════════════════════

  const planned: Array<Extract<LocateEditResult, { found: true }>> = [];
  let needsSequential = false;

  for (const edit of edits) {
    if (!edit.old_str) {
      throw new ApplyError(`old_str must not be empty in ${displayPath}.`);
    }

    const located = locateEdit(edit, originalContent, displayPath);
    if (!located.found) {
      // old_str not found in the original snapshot — likely chained edit.
      // Fall back to sequential mode.
      needsSequential = true;
      break;
    }

    planned.push(located);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Sequential fallback — old behaviour for chained edits
  // ═══════════════════════════════════════════════════════════════════

  if (needsSequential) {
    let content = originalContent;
    let cumulativeOffset = 0;
    const rawReplacements: ReplacementInfo[] = [];

    for (const edit of edits) {
      const located = locateEdit(edit, content, displayPath);
      if (!located.found) {
        const diag = diagnoseOldStrMismatch(located.oldNorm, content);
        if (located.anchorState === "missing" || located.anchorState === "not_unique") {
          throw new ApplyError(
            `${located.anchorMessage}\nold_str not found in ${displayPath}: "${truncate(edit.old_str)}".\n${diag}`
          );
        }
        throw new ApplyError(
          `old_str not found in ${displayPath}` +
          (edit.anchor ? ` after anchor "${truncate(edit.anchor)}"` : "") +
          `: "${truncate(edit.old_str)}".\n${diag}`
        );
      }

      const { oldNorm, newNorm, matchIdx, displayAnchor, anchorMissing, anchorNotUnique } = located;

      const oldStartLine = lineAtOffset(lineOffsets, matchIdx - cumulativeOffset);
      const oldEndLine = lineAtOffset(lineOffsets, matchIdx - cumulativeOffset + oldNorm.length - 1);
      const normStart = matchIdx - cumulativeOffset;
      const normEnd = normStart + oldNorm.length;

      content =
        content.substring(0, matchIdx) +
        newNorm +
        content.substring(matchIdx + oldNorm.length);

      cumulativeOffset += newNorm.length - oldNorm.length;

      rawReplacements.push({
        oldStartLine,
        oldEndLine,
        newStartLine: 0, // placeholder — recalculated after collapse
        newEndLine: 0,
        oldLines: oldNorm.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === "")),
        newLines: newNorm.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === "")),
        newStr: newNorm,
        normStart,
        normEnd,
        anchor: displayAnchor ? displayAnchor.split("\n")[0] : undefined,
        anchorMissing,
        anchorNotUnique,
      });
    }

    // Collapse chained-edit replacements into net-change replacements,
    // so the TUI diff shows only the net effect (original→final).
    const cleanReplacements = collapseSequentialReplacements(rawReplacements);

    const mergedRanges = mergeRanges(cleanReplacements.map(r => ({
      startLine: Math.max(1, r.oldStartLine - CONTEXT_LINES),
      endLine: Math.min(totalLines, r.oldEndLine + CONTEXT_LINES),
    })));
    const neededLines: Map<number, string> = new Map();
    for (const range of mergedRanges) {
      const lines = extractLineRange(originalContent, lineOffsets, range.startLine, range.endLine);
      for (let i = 0; i < lines.length; i++) {
        neededLines.set(range.startLine + i, lines[i]);
      }
    }

    const fileDiff = generateLocalDiff(displayPath, cleanReplacements, neededLines, totalLines);
    if (result.diff) {
      result.diff += "\n" + fileDiff;
    } else {
      result.diff = fileDiff;
    }

    const finalContent = spliceOntoRaw(
      rawContent,
      cleanReplacements
        .map((r) => ({
          normStart: r.normStart ?? 0,
          normEnd: r.normEnd ?? 0,
          newStr: r.newStr ?? r.newLines.join("\n"),
        }))
        .sort((a, b) => a.normStart - b.normStart),
    );

    writeFileEncoded(absPath, finalContent, enc);
    result.modified.push(displayPath);
    result.replacements.set(displayPath, cleanReplacements);
    return;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2: Conflict detection — sort by position, check for overlaps
  // ═══════════════════════════════════════════════════════════════════

  const sorted = [...planned].sort((a, b) => a.matchIdx - b.matchIdx);

  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i]!;
    const next = sorted[i + 1]!;
    const curEnd = cur.matchIdx + cur.oldNorm.length;
    if (curEnd > next.matchIdx) {
      const curStartLine = lineAtOffset(lineOffsets, cur.matchIdx);
      const curEndLine = lineAtOffset(lineOffsets, curEnd - 1);
      const nextStartLine = lineAtOffset(lineOffsets, next.matchIdx);
      const overlapEnd = Math.min(curEnd, next.matchIdx + next.oldNorm.length);
      const overlapEndLine = lineAtOffset(lineOffsets, overlapEnd - 1);
      throw new ApplyError(
        `Edits target overlapping regions in ${displayPath}: ` +
        `edit targeting lines ${curStartLine}-${curEndLine} overlaps with ` +
        `edit targeting lines ${nextStartLine}-${overlapEndLine}. ` +
        `Split overlapping edits into separate patch calls.`
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Phase 3: One-shot assembly — splice replacements into final content
  // ═══════════════════════════════════════════════════════════════════

  let content = "";
  let cursor = 0;
  const replacements: ReplacementInfo[] = [];
  const neededRanges: LineRange[] = [];

  for (const p of sorted) {
    // Copy original content up to this edit
    content += originalContent.substring(cursor, p.matchIdx);

    // Record where new_str lands in the assembled content
    const newStartIdx = content.length;
    content += p.newNorm;
    const newEndIdx = content.length - 1;

    // Compute line numbers (original file coordinates for old, result for new)
    const oldStartLine = lineAtOffset(lineOffsets, p.matchIdx);
    const oldEndLine = lineAtOffset(lineOffsets, p.matchIdx + p.oldNorm.length - 1);
    const newStartLine = charOffsetToLine(content, newStartIdx);
    const newEndLine = charOffsetToLine(content, newEndIdx);

    replacements.push({
      oldStartLine,
      oldEndLine,
      newStartLine,
      newEndLine,
      oldLines: p.oldNorm.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === "")),
      newLines: p.newNorm.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === "")),
      anchor: p.displayAnchor ? p.displayAnchor.split("\n")[0] : undefined,
      anchorMissing: p.anchorMissing,
      anchorNotUnique: p.anchorNotUnique,
    });

    neededRanges.push({
      startLine: Math.max(1, oldStartLine - CONTEXT_LINES),
      endLine: Math.min(totalLines, oldEndLine + CONTEXT_LINES),
    });

    cursor = p.matchIdx + p.oldNorm.length;
  }

  // Copy trailing original content
  content += originalContent.substring(cursor);

  // ═══════════════════════════════════════════════════════════════════
  // Diff generation
  // ═══════════════════════════════════════════════════════════════════

  const mergedRanges = mergeRanges(neededRanges);
  const originalLineOffsets = buildLineOffsets(originalContent);
  const neededLines: Map<number, string> = new Map();
  for (const range of mergedRanges) {
    const lines = extractLineRange(originalContent, originalLineOffsets, range.startLine, range.endLine);
    for (let i = 0; i < lines.length; i++) {
      neededLines.set(range.startLine + i, lines[i]);
    }
  }

  const fileDiff = generateLocalDiff(displayPath, replacements, neededLines, totalLines);
  if (result.diff) {
    result.diff += "\n" + fileDiff;
  } else {
    result.diff = fileDiff;
  }

  const finalContent = spliceOntoRaw(
    rawContent,
    sorted.map((p) => ({
      normStart: p.matchIdx,
      normEnd: p.matchIdx + p.oldNorm.length,
      newStr: p.newNorm,
    })),
  );

  writeFileEncoded(absPath, finalContent, enc);
  result.modified.push(displayPath);
  result.replacements.set(displayPath, replacements);
}
// ═══════════════════════════════════════════════════════════════════════════
// Diff generation (for TUI preview and result display)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Patch preview without writing to disk.
 * Returns unified diff for edits, or truncated content for overwrites.
 */
export interface PatchPreview {
  diff?: string;
  error?: string;
  /** Truncated new content preview for overwrite mode */
  preview?: string;
  isOverwrite?: boolean;
}

export async function computePatchPreview(
  patch: FilePatch,
  cwd: string,
): Promise<PatchPreview> {
  try {
    if (!patch.path?.trim()) {
      return { error: "File path cannot be empty." };
    }

    const absPath = resolveAbsPath(cwd, patch.path);

    if (patch.overwrite) {
      return { preview: patch.new_str ?? "", isOverwrite: true };
    } else if (patch.edits && patch.edits.length > 0) {
      if (!fs.existsSync(absPath)) {
        return { error: "File not found" };
      }

      const enc = detectFileEncoding(absPath);
      const rawContent = readFileDecoded(absPath, enc);
    const lineOffsets = buildLineOffsets(rawContent);
    const totalLines = lineOffsets.length - 1;
    let content = normalizeLineEndings(rawContent);
    // Snapshot the original (pre-edit) content for diff display. The
    // `content` variable below is mutated in-place as edits are applied,
    // but the TUI diff should show the ORIGINAL lines (not the post-edit
    // content) so leading whitespace is preserved correctly.
    const originalContent = content;
    const allReplacements: ReplacementInfo[] = [];
    const neededRanges: LineRange[] = [];
    let cumulativeOffset = 0;

      for (const edit of patch.edits) {
        if (!edit.old_str) continue;

        // Reuse the shared locator so preview and apply can never drift
        // apart on anchor / fuzzy / uniqueness semantics. The only
        // difference is error reporting: apply throws, preview returns.
        let located: LocateEditResult;
        try {
          located = locateEdit(edit, content, patch.path);
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
        if (!located.found) {
          const diag = diagnoseOldStrMismatch(located.oldNorm, content);
          if (located.anchorState === "missing" || located.anchorState === "not_unique") {
            return { error: `${located.anchorMessage}\nold_str not found: "${truncate(edit.old_str)}"\n${diag}` };
          }
          return { error: `old_str not found: "${truncate(edit.old_str)}".${edit.anchor ? ` after anchor "${truncate(edit.anchor)}"` : ""}\n${diag}` };
        }

        const { oldNorm, newNorm, matchIdx, displayAnchor, anchorMissing, anchorNotUnique } = located;

        const origMatchIdx = matchIdx - cumulativeOffset;
        const oldStartLine = lineAtOffset(lineOffsets, origMatchIdx);
        const oldEndLine = lineAtOffset(lineOffsets, origMatchIdx + oldNorm.length - 1);
        const oldLines = oldNorm.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === ""));
        const newLines = newNorm.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === ""));
        content = content.substring(0, matchIdx) + newNorm + content.substring(matchIdx + oldNorm.length);
        const newStartLine = charOffsetToLine(content, matchIdx);
        const newEndLine = charOffsetToLine(content, matchIdx + newNorm.length - 1);
        // Record needed context range around this edit
        neededRanges.push({
          startLine: Math.max(1, oldStartLine - CONTEXT_LINES),
          endLine: Math.min(totalLines, oldEndLine + CONTEXT_LINES),
        });
        allReplacements.push({ oldStartLine, oldEndLine, newStartLine, newEndLine, oldLines, newLines, anchor: displayAnchor ? displayAnchor.split("\n")[0] : undefined, anchorMissing, anchorNotUnique });
        cumulativeOffset += newNorm.length - oldNorm.length;
      }

      // Merge needed ranges and extract lines from the ORIGINAL content
      // (not the mutated `content`), so the diff shows pre-edit lines.
      const mergedRanges = mergeRanges(neededRanges);
      const originalLineOffsets = buildLineOffsets(originalContent);
      const neededLines: Map<number, string> = new Map();
      for (const range of mergedRanges) {
        const lines = extractLineRange(originalContent, originalLineOffsets, range.startLine, range.endLine);
        for (let i = 0; i < lines.length; i++) {
          neededLines.set(range.startLine + i, lines[i]);
        }
      }

      const diff = generateLocalDiff(patch.path, allReplacements, neededLines, totalLines);
      return { diff };
    } else {
      return { error: "Must provide edits[] or overwrite:true" };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** @deprecated Use computePatchPreview(single) instead. Kept for backward compatibility. */
export async function computePatchPreviewMulti(
  patches: FilePatch[],
  cwd: string,
): Promise<Map<string, PatchPreview>> {
  const results = new Map<string, PatchPreview>();
  for (const p of patches) {
    const preview = await computePatchPreview(p, cwd);
    results.set(p.path || "_parse", preview);
  }
  return results;
}


// Test exports
export const __patchCoreTest = {
  charOffsetToLine,
  detectTabWidth,
  normalizeIndentForFuzzy,
  truncate,
  collapseSequentialReplacements,
  generateReplacementDiff,
  spliceOntoRaw,
  buildNormToRawMap,
};
