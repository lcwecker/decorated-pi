/**
 * Patch — Exact string replacement for pi
 *
 * Replaces diff-based format with old_str/new_str matching.
 * No fuzzy matching, no similarity — only exact string matching.
 *
 * Per-file operations:
 *   { path, edits: [{ old_str, new_str, anchor? }] }  — targeted replacements
 *   { path, overwrite: true, new_str }                — atomic full-file overwrite
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as fsPromises from "node:fs/promises";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface Edit {
  /** Optional anchor to narrow search range (exact string, searched from file start) */
  anchor?: string;
  /** Exact text to find in the file */
  old_str: string;
  /** Replacement text */
  new_str: string;
}

export interface FilePatch {
  /** File path (relative to cwd or absolute) */
  path: string;
  /** Targeted edits to apply sequentially */
  edits?: Edit[];
  /** If true, replace the entire file content atomically */
  overwrite?: boolean;
  /** New file content when overwriting */
  new_str?: string;
}

export interface PatchResult {
  modified: string[];
  created: string[];
  warnings: string[];
  /** Per-file replacement info for diff generation */
  replacements: Map<string, ReplacementInfo[]>;
  /** Original file lines per file, for diff context generation */
  originalLines: Map<string, string[]>;
  /** Pre-generated diff string (set by applyEdits to avoid re-reading files) */
  diff: string;
}

/** Records a single old_str→new_str replacement within a file */
export interface ReplacementInfo {
  /** 1-based line number where old_str starts in the original file */
  oldStartLine: number;
  /** 1-based line number where old_str ends in the original file */
  oldEndLine: number;
  /** 1-based line number where new_str starts in the result file */
  newStartLine: number;
  /** 1-based line number where new_str ends in the result file */
  newEndLine: number;
  /** The original lines that were replaced */
  oldLines: string[];
  /** The new lines that replaced them */
  newLines: string[];
  /** Optional anchor text (first line only, for hunk display) */
  anchor?: string;
  /** Anchor was provided but not found, and patch fell back to global old_str search */
  anchorMissing?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Errors
// ═══════════════════════════════════════════════════════════════════════════

export class ParseError extends Error {
  constructor(message: string) { super(message); this.name = "ParseError"; }
}

export class ApplyError extends Error {
  constructor(message: string) { super(message); this.name = "ApplyError"; }
}

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
  const oldContent = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : "";

  // Write to temp file in the same directory (same filesystem → mv is atomic)
  ensureParentDir(absPath);
  const dir = path.dirname(absPath);
  const tmpName = path.join(dir, `.pi-patch-${randomId()}.tmp`);
  fs.writeFileSync(tmpName, content, "utf8");
  fs.renameSync(tmpName, absPath);

  if (oldContent) {
    result.modified.push(displayPath);
  } else {
    result.created.push(displayPath);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Edits (exact string replacement)
// ═══════════════════════════════════════════════════════════════════════════

type LocateEditResult =
  | {
      found: true;
      oldNorm: string;
      newNorm: string;
      matchIdx: number;
      displayAnchor?: string;
      anchorMissing: boolean;
    }
  | {
      found: false;
      oldNorm: string;
      anchorState: "ok" | "missing" | "not_unique";
      anchorMessage?: string;
    };

/** Shared edit location logic used by both one-shot and sequential paths.
 *  Returns structured failure details when old_str is not found so callers can
 *  preserve precise diagnostics instead of guessing why matching failed.
 *  Throws ApplyError on duplicate global matches or non-unique old_str. */
function locateEdit(
  edit: { old_str: string; new_str: string; anchor?: string },
  content: string,
  displayPath: string,
): LocateEditResult {
  let oldNorm = normalizeLineEndings(edit.old_str);
  let newNorm = normalizeLineEndings(edit.new_str);

  let searchFrom = 0;
  let displayAnchor: string | undefined;
  let anchorMissing = false;
  let anchorState: "ok" | "missing" | "not_unique" = "ok";
  let anchorMessage: string | undefined;

  // ── Anchor parsing ──
  if (edit.anchor) {
    const anchorNorm = normalizeLineEndings(edit.anchor);
    const anchorIdx = content.indexOf(anchorNorm);
    if (anchorIdx === -1) {
      anchorState = "missing";
      anchorMessage = `Anchor not found in ${displayPath}: "${truncate(edit.anchor)}".`;
    } else {
      const secondAnchor = content.indexOf(anchorNorm, anchorIdx + 1);
      if (secondAnchor !== -1) {
        anchorState = "not_unique";
        anchorMessage = `Anchor is not unique in ${displayPath}: "${truncate(edit.anchor)}".`;
      } else {
        searchFrom = Math.max(0, anchorIdx - (oldNorm.length - 1));
        displayAnchor = edit.anchor;
      }
    }
  }

  // ── Exact match in search range ──
  let matchIdx = anchorMessage ? -1 : content.indexOf(oldNorm, searchFrom);

  // ── Global exact match fallback (when anchor was missing/unusable) ──
  if (matchIdx === -1 && anchorMessage) {
    displayAnchor = edit.anchor;
    anchorMissing = true;
    matchIdx = content.indexOf(oldNorm, 0);
    if (matchIdx !== -1) {
      const secondGlobalMatch = content.indexOf(oldNorm, matchIdx + 1);
      if (secondGlobalMatch !== -1) {
        const dupDiag = diagnoseOldStrNotUnique(oldNorm, content);
        throw new ApplyError(`${anchorMessage}\n${dupDiag}`);
      }
    }
  }

  // ── Fuzzy match ──
  if (matchIdx === -1) {
    const searchLine = searchFrom === 0 ? 0 : content.substring(0, searchFrom).split("\n").length - 1;
    const fuzzy = tryFuzzyLineMatch(oldNorm, content, searchLine);
    if (fuzzy) {
      oldNorm = fuzzy.matched;
      matchIdx = fuzzy.idx;
      newNorm = normalizeIndentForFuzzy(fuzzy.matched.split("\n")[0] ?? "", newNorm);
    }
  }

  if (matchIdx === -1) {
    return { found: false, oldNorm, anchorState, anchorMessage };
  }

  // ── Uniqueness check (skip when anchor was used as a fallback) ──
  if (!anchorMessage) {
    const secondMatch = content.indexOf(oldNorm, matchIdx + 1);
    if (secondMatch !== -1) {
      const dupDiag = diagnoseOldStrNotUnique(oldNorm, content);
      throw new ApplyError(`${dupDiag}`);
    }
  }

  return { found: true, oldNorm, newNorm, matchIdx, displayAnchor, anchorMissing };
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

  const rawContent = fs.readFileSync(absPath, "utf8");
  const lineEnding = detectLineEnding(rawContent);
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

      const { oldNorm, newNorm, matchIdx, displayAnchor, anchorMissing } = located;

      const oldStartLine = lineAtOffset(lineOffsets, matchIdx - cumulativeOffset);
      const oldEndLine = lineAtOffset(lineOffsets, matchIdx - cumulativeOffset + oldNorm.length - 1);

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
        anchor: displayAnchor ? displayAnchor.split("\n")[0] : undefined,
        anchorMissing,
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

    const finalContent = restoreLineEndings(content, lineEnding);
    if (lineEnding === "\r\n" && rawContent.includes("\r\n")) {
      result.warnings.push(`${displayPath}: CRLF line endings were normalized to LF during editing.`);
    }

    fs.writeFileSync(absPath, finalContent, "utf8");
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

  // Restore line endings
  const finalContent = restoreLineEndings(content, lineEnding);

  if (lineEnding === "\r\n" && rawContent.includes("\r\n")) {
    result.warnings.push(`${displayPath}: CRLF line endings were normalized to LF during editing.`);
  }

  fs.writeFileSync(absPath, finalContent, "utf8");
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

      const rawContent = await fsPromises.readFile(absPath, "utf8");
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
        let oldNorm = normalizeLineEndings(edit.old_str);
        let newNorm = normalizeLineEndings(edit.new_str);

        let searchFrom = 0;
        let displayAnchor: string | undefined;
        let anchorMissing = false;
        let anchorNotFoundMessage: string | undefined;
        if (edit.anchor) {
          const anchorNorm = normalizeLineEndings(edit.anchor);
          const idx = content.indexOf(anchorNorm);
          if (idx === -1) {
            anchorNotFoundMessage = `Anchor not found: "${truncate(edit.anchor)}"`;
          } else {
            const secondAnchor = content.indexOf(anchorNorm, idx + 1);
            if (secondAnchor !== -1) {
              anchorNotFoundMessage = `Anchor is not unique: "${truncate(edit.anchor)}"`;
            } else {
              searchFrom = Math.max(0, idx - (oldNorm.length - 1));
              displayAnchor = edit.anchor;
              anchorMissing = false;
            }
          }
        }

        let matchIdx = anchorNotFoundMessage ? -1 : content.indexOf(oldNorm, searchFrom);
        if (matchIdx === -1 && anchorNotFoundMessage) {
          displayAnchor = edit.anchor;
          anchorMissing = true;
          matchIdx = content.indexOf(oldNorm, 0);
          if (matchIdx !== -1) {
            const secondGlobalMatch = content.indexOf(oldNorm, matchIdx + 1);
            if (secondGlobalMatch !== -1) {
              const dupDiag = diagnoseOldStrNotUnique(oldNorm, content);
              return { error: `${anchorNotFoundMessage}\n${dupDiag}` };
            }
          }
        }

        if (matchIdx === -1) {
          const searchLine = 0;
          const fuzzy = tryFuzzyLineMatch(oldNorm, content, searchLine);
          if (fuzzy) {
            oldNorm = fuzzy.matched;
            matchIdx = fuzzy.idx;
            newNorm = normalizeIndentForFuzzy(fuzzy.matched.split("\n")[0] ?? "", newNorm);
          } else if (anchorNotFoundMessage) {
            const diag = diagnoseOldStrMismatch(oldNorm, content);
            return { error: `${anchorNotFoundMessage}\nold_str not found: "${truncate(edit.old_str)}"\n${diag}` };
          } else {
            const diag = diagnoseOldStrMismatch(oldNorm, content);
            return { error: `old_str not found: "${truncate(edit.old_str)}".\n${diag}` };
          }
        }

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
        allReplacements.push({ oldStartLine, oldEndLine, newStartLine, newEndLine, oldLines, newLines, anchor: displayAnchor ? displayAnchor.split("\n")[0] : undefined, anchorMissing });
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
        byText.set(text, { text, missing: Boolean(rep.anchorMissing) });
      } else if (!rep.anchorMissing) {
        existing.missing = false;
      }
    }
  }
  return [...byText.values()];
}

function formatAnchorLabel(anchor: ChunkAnchor): string {
  return anchor.text + (anchor.missing ? " (missing)" : "");
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
function generateReplacementDiff(filePath: string, reps: ReplacementInfo[], originalLines: string[]): string {
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

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function resolveAbsPath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function ensureParentDir(absPath: string): void {
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function detectLineEnding(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: string): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

// ═══════════════════════════════════════════════════════════════════════════
// Line range utilities (for partial file reading)
// ═══════════════════════════════════════════════════════════════════════════

const CONTEXT_LINES = 3;

interface LineRange {
  startLine: number;
  endLine: number;
}

/** Build line offset table: offsets[i] = character offset of line i+1 (1-based) */
function buildLineOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}


/** Binary search: find 1-based line number containing charOffset */
function lineAtOffset(lineOffsets: number[], charOffset: number): number {
  let lo = 0, hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineOffsets[mid] <= charOffset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Binary search: find line start offset given 1-based line number */
function offsetAtLine(lineOffsets: number[], lineNum: number): number {
  if (lineNum <= 1) return 0;
  if (lineNum > lineOffsets.length) return lineOffsets[lineOffsets.length - 1];
  return lineOffsets[lineNum - 1];
}

/** Extract a range of lines from content (1-based, inclusive) */
function extractLineRange(content: string, lineOffsets: number[], startLine: number, endLine: number): string[] {
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
function mergeRanges(ranges: LineRange[]): LineRange[] {
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

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Convert a character offset to a 1-based line number. */
function charOffsetToLine(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/**
 * Generate diff using only the needed lines (partial file context).
 */
/** Collapse chained-edit replacements (where out[i] === in[i+1]) into
 *  net-change replacements showing only the net effect (original→final). */
function collapseSequentialReplacements(
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
        anchor: undefined,
        anchorMissing: merged.anchorMissing || next.anchorMissing,
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

function linesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function generateLocalDiff(
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

// ─── old_str mismatch diagnostics ─────────────────────────────────────────

/** Detect tab width from the file by analyzing indentation columns of tab-only lines. */
function detectTabWidth(content: string): number {
  const lines = content.split("\n");
  const cols: number[] = [];
  for (const line of lines) {
    const nonTabIdx = line.search(/[^\t]/);
    if (nonTabIdx === -1 || nonTabIdx === 0) continue;
    cols.push(nonTabIdx);
  }
  if (cols.length < 2) return 0;
  const diffs: number[] = [];
  for (let i = 1; i < cols.length; i++) {
    if (cols[i] === cols[i - 1] || cols[i]! > cols[i - 1]! + 8) continue;
    diffs.push(cols[i]! - cols[i - 1]!);
  }
  if (diffs.length === 0) return 0;
  const sorted = [...diffs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return [2, 4, 8].reduce((best, w) => Math.abs(w - median) < Math.abs(best - median) ? w : best, 4);
}

export function diagnoseOldStrNotUnique(oldNorm: string, content: string): string {
  const fileLines = content.split("\n");
  const firstOldLine = (oldNorm.split("\n")[0] ?? "").trim();
  const occurrences: number[] = [];
  let idx = 0;
  while ((idx = content.indexOf(oldNorm, idx)) !== -1) {
    const lineNum = content.substring(0, idx).split("\n").length;
    occurrences.push(lineNum);
    idx++;
  }
  if (occurrences.length === 0) return "";
  const shown = occurrences.slice(0, 5);
  const extra = occurrences.length - shown.length;
  const lines = shown.map((n) => `  line ${n}: "${(fileLines[n - 1] ?? "").replace(/\t/g, "\\t").slice(0, 60)}"`);
  if (extra > 0) lines.push(`  and ${extra} more occurrence(s)`);
  return `old_str appears ${occurrences.length} times:\n${lines.join("\n")}\nAdd more surrounding context to make it unique.`;
}

/** Try fuzzy match: normalize tab↔space and trailing whitespace, then search line-by-line. */
function tryFuzzyLineMatch(
  oldNorm: string,
  content: string,
  searchLineStart: number,
): { idx: number; matched: string } | undefined {
  const oldLines = oldNorm.split("\n");
  const fileLines = content.split("\n");

  const fuzzyEq = (fileLine: string, oldLine: string): boolean => {
    if (fileLine === oldLine) return true;
    for (const tw of [8, 4, 2]) {
      if (fileLine.replace(/\t/g, " ".repeat(tw)) === oldLine.replace(/\t/g, " ".repeat(tw))) return true;
    }
    if (fileLine.replace(/[\t ]+$/, "") === oldLine.replace(/[\t ]+$/, "")) return true;
    return false;
  };

  for (let i = searchLineStart; i <= fileLines.length - oldLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (!fuzzyEq(fileLines[i + j] ?? "", oldLines[j] ?? "")) { ok = false; break; }
    }
    if (ok) {
      let idx = 0;
      for (let k = 0; k < i; k++) idx += (fileLines[k] ?? "").length + 1;
      const matched = oldLines.map((_, j) => fileLines[i + j]).join("\n");
      // Check uniqueness in the fuzzy-matched range
      const secondIdx = content.indexOf(matched, idx + 1);
      if (secondIdx === -1) return { idx, matched };
    }
  }
  return undefined;
}

/** Replace new_str's leading whitespace with the actual file line's leading whitespace style. */
function normalizeIndentForFuzzy(actualLine: string, newLine: string): string {
  const actualLeading = actualLine.match(/^[\t ]*/)?.[0] ?? "";
  const newLeading = newLine.match(/^[\t ]*/)?.[0] ?? "";
  if (actualLeading === newLeading) return newLine;
  return actualLeading + newLine.slice(newLeading.length);
}

export function diagnoseOldStrMismatch(oldNorm: string, content: string, isConfigFile?: boolean): string {
  const oldLines = oldNorm.split("\n");
  const fileLines = content.split("\n");
  const firstOldLine = oldLines[0] ?? "";
  const parts: string[] = [];

  // Find the closest matching line in the file
  let bestMatchIdx = -1;
  let bestMatchType = "";

  for (let i = 0; i < fileLines.length; i++) {
    const fileLine = fileLines[i] ?? "";

    if (fileLine === firstOldLine) {
      bestMatchIdx = i;
      bestMatchType = "";
      break;
    }

    if (fileLine.replace(/\t/g, "        ") === firstOldLine ||
        fileLine.replace(/\t/g, "    ") === firstOldLine ||
        fileLine.replace(/\t/g, "  ") === firstOldLine) {
      bestMatchIdx = i;
      bestMatchType = "tab vs space (file has tabs, old_str has spaces)";
      break;
    }

    if (fileLine.replace(/[\t ]+$/, "") === firstOldLine.replace(/[\t ]+$/, "")) {
      bestMatchIdx = i;
      bestMatchType = "trailing whitespace mismatch";
      break;
    }

    if (fileLine.toLowerCase() === firstOldLine.toLowerCase()) {
      bestMatchIdx = i;
      bestMatchType = "case mismatch";
      break;
    }

    const trimmedOld = firstOldLine.trim();
    if (trimmedOld.length > 3 && fileLine.includes(trimmedOld)) {
      if (bestMatchIdx === -1) {
        bestMatchIdx = i;
        bestMatchType = "indent mismatch (content matches, whitespace differs)";
      }
    }
  }

  if (bestMatchIdx >= 0 && bestMatchType) {
    parts.push(`Hint: ${bestMatchType} at line ${bestMatchIdx + 1}.`);
    parts.push(`  actual: ${JSON.stringify(fileLines[bestMatchIdx])}`);
    parts.push(`  expected: ${JSON.stringify(firstOldLine)}`);
  } else if (bestMatchIdx >= 0) {
    // First line matched, but full old_str block does not — find the first mismatching line
    const oldArr = oldNorm.split("\n");
    let mismatchLine = 0;
    for (let j = 1; j < oldArr.length; j++) {
      const fileLine = fileLines[bestMatchIdx + j] ?? "<EOF>";
      const oldLine = oldArr[j] ?? "";
      if (fileLine !== oldLine) {
        mismatchLine = bestMatchIdx + j + 1;
        parts.push(`Line ${bestMatchIdx + 1} matches, but diff at line ${mismatchLine}:`);
        parts.push(`  actual: ${JSON.stringify(fileLine)}`);
        parts.push(`  expected: ${JSON.stringify(oldLine)}`);
        break;
      }
    }
    if (mismatchLine === 0) {
      parts.push(`First line matches at line ${bestMatchIdx + 1}, but full ${oldArr.length}-line block does not.`);
    }
  } else if (firstOldLine.trim().length > 3) {
    parts.push(`Content "${firstOldLine.trim().slice(0, 60)}" not found anywhere in the file.`);
    parts.push(`File may have changed — re-read it and try again.`);
  }

  return parts.join("\n");
}

function truncate(s: string, maxLen = 60): string {
  if (s.length <= maxLen) return s;
  // Show first line only
  const firstLine = s.split("\n")[0];
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen - 3) + "...";
}
