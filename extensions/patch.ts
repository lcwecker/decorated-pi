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
  let content = normalizeLineEndings(rawContent);

  // Precompute line offsets for O(log n) line number lookups
  const lineOffsets = buildLineOffsets(rawContent);
  const totalLines = lineOffsets.length - 1;

  // Track cumulative offset for mapping current positions back to original
  let cumulativeOffset = 0;
  const replacements: ReplacementInfo[] = [];
  const neededRanges: LineRange[] = [];

  for (const edit of edits) {
    if (!edit.old_str) {
      throw new ApplyError(`old_str must not be empty in ${displayPath}.`);
    }

    let oldNorm = normalizeLineEndings(edit.old_str);
    let newNorm = normalizeLineEndings(edit.new_str);

    // Determine search range
    let searchFrom = 0;
    let displayAnchor: string | undefined;
    let anchorMissing = false;
    let anchorNotFoundMessage: string | undefined;

    if (edit.anchor) {
      const anchorNorm = normalizeLineEndings(edit.anchor);

      // Find anchor — must be unique when present
      const anchorIdx = content.indexOf(anchorNorm);
      if (anchorIdx === -1) {
        anchorNotFoundMessage = `Anchor not found in ${displayPath}: "${truncate(edit.anchor)}".`;
      } else {
        const secondAnchor = content.indexOf(anchorNorm, anchorIdx + 1);
        if (secondAnchor !== -1) {
          anchorNotFoundMessage = `Anchor is not unique in ${displayPath}: "${truncate(edit.anchor)}".`;
        } else {
          searchFrom = Math.max(0, anchorIdx - (oldNorm.length - 1));
          displayAnchor = edit.anchor;
          anchorMissing = false;
        }
      }
    }

    // Find old_str in range — must be unique
    let matchIdx = anchorNotFoundMessage ? -1 : content.indexOf(oldNorm, searchFrom);
    if (matchIdx === -1 && anchorNotFoundMessage) {
      // Anchor was missing/unusable — try global exact match first
      displayAnchor = edit.anchor;
      anchorMissing = true;
      matchIdx = content.indexOf(oldNorm, 0);
      if (matchIdx !== -1) {
        const secondGlobalMatch = content.indexOf(oldNorm, matchIdx + 1);
        if (secondGlobalMatch !== -1) {
          const dupDiag = diagnoseOldStrNotUnique(oldNorm, content);
          throw new ApplyError(`${anchorNotFoundMessage}\n${dupDiag}`);
        }
      }
    }

    if (matchIdx === -1) {
      // Fuzzy match fallback: normalize tab↔space + trailing whitespace
      const searchLine = searchFrom === 0 ? 0 : content.substring(0, searchFrom).split("\n").length - 1;
      const fuzzy = tryFuzzyLineMatch(oldNorm, content, searchLine);
      if (fuzzy) {
        oldNorm = fuzzy.matched;
        matchIdx = fuzzy.idx;
        newNorm = normalizeIndentForFuzzy(fuzzy.matched.split("\n")[0] ?? "", newNorm);
      } else if (anchorNotFoundMessage) {
        const diag = diagnoseOldStrMismatch(oldNorm, content);
        throw new ApplyError(
          `${anchorNotFoundMessage}\nold_str not found in ${displayPath}: "${truncate(edit.old_str)}".\n${diag}`
        );
      } else {
        const diag = diagnoseOldStrMismatch(oldNorm, content);
        throw new ApplyError(
          `old_str not found in ${displayPath}` +
          (edit.anchor ? ` after anchor "${truncate(edit.anchor)}"` : "") +
          `: "${truncate(edit.old_str)}".\n${diag}`
        );
      }
    }

    // Check uniqueness in anchor-narrowed / plain search path only when anchor was used normally
    if (!anchorNotFoundMessage) {
      const secondMatch = content.indexOf(oldNorm, matchIdx + 1);
      if (secondMatch !== -1) {
        const dupDiag = diagnoseOldStrNotUnique(oldNorm, content);
        throw new ApplyError(
          `${dupDiag}`
        );
      }
    }

    // Compute line numbers in the original file for diff generation (O(log n) via binary search)
    // matchIdx is in the modified content; subtract cumulative offset to map back to original
    const origMatchIdx = matchIdx - cumulativeOffset;
    const oldStartLine = lineAtOffset(lineOffsets, origMatchIdx);
    const oldEndLine = lineAtOffset(lineOffsets, origMatchIdx + oldNorm.length - 1);

    // Apply replacement
    content =
      content.substring(0, matchIdx) +
      newNorm +
      content.substring(matchIdx + oldNorm.length);

    // Track the offset shift for subsequent edits
    cumulativeOffset += newNorm.length - oldNorm.length;

    // Compute new_str line numbers in the result
    const newStartLine = charOffsetToLine(content, matchIdx);
    const newEndLine = charOffsetToLine(content, matchIdx + newNorm.length - 1);

    // Record replacement info
    replacements.push({
      oldStartLine,
      oldEndLine,
      newStartLine,
      newEndLine,
      oldLines: oldNorm.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === "")),
      newLines: newNorm.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === "")),
      anchor: displayAnchor ? displayAnchor.split("\n")[0] : undefined,
      anchorMissing,
    });

    // Collect context range for this edit
    neededRanges.push({
      startLine: Math.max(1, oldStartLine - CONTEXT_LINES),
      endLine: Math.min(totalLines, oldEndLine + CONTEXT_LINES),
    });
  }

  // Generate diff using only needed context lines (no full-file split)
  const mergedRanges = mergeRanges(neededRanges);
  const currentLineOffsets = buildLineOffsets(content);
  const neededLines: Map<number, string> = new Map();
  for (const range of mergedRanges) {
    const lines = extractLineRange(content, currentLineOffsets, range.startLine, range.endLine);
    for (let i = 0; i < lines.length; i++) {
      neededLines.set(range.startLine + i, lines[i]);
    }
  }

  // Build diff for this file and append to result
  const fileDiff = generateLocalDiff(displayPath, replacements, neededLines, totalLines);
  if (result.diff) {
    result.diff += "\n" + fileDiff;
  } else {
    result.diff = fileDiff;
  }

  // Restore line endings
  const finalContent = restoreLineEndings(content, lineEnding);

  // Warn if line endings were normalized (CRLF → LF)
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

      // Merge needed ranges and extract only those lines
      const mergedRanges = mergeRanges(neededRanges);
      const currentLineOffsets = buildLineOffsets(content);
      const neededLines: Map<number, string> = new Map();
      for (const range of mergedRanges) {
        const lines = extractLineRange(content, currentLineOffsets, range.startLine, range.endLine);
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
    const text = rep.anchor?.trim();
    if (!text) continue;
    const existing = byText.get(text);
    if (!existing) {
      byText.set(text, { text, missing: Boolean(rep.anchorMissing) });
    } else if (!rep.anchorMissing) {
      // If any replacement successfully used this anchor, do not mark it missing.
      existing.missing = false;
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

/**
 * Generate diff as visual chunks merged by overlapping/adjacent context windows.
 * This keeps spacing stable when multiple nearby edits would otherwise create
 * repeated context and oversized gaps between chunks.
 */
function generateReplacementDiff(filePath: string, reps: ReplacementInfo[], originalLines: string[]): string {
  const parts: string[] = [];
  parts.push(`--- ${filePath}`);
  parts.push(`+++ ${filePath}`);

  if (reps.length === 0) {
    parts.push("");
    return parts.join("\n");
  }

  const maxLineNum = Math.max(originalLines.length, ...reps.map(r => r.oldEndLine));
  const numWidth = String(maxLineNum).length;
  const CONTEXT = 3;
  const chunks = buildReplacementChunks(reps, originalLines.length, CONTEXT);

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]!;
    if (c > 0) parts.push("");
    parts.push(formatChunkHeader(chunk));
    parts.push(...formatChunkMetadataLines(chunk));

    let cursor = chunk.startLine;

    for (const rep of chunk.reps) {
      // Context before this replacement (only once per original line)
      for (let i = cursor; i < rep.oldStartLine; i++) {
        const num = String(i).padStart(numWidth, " ");
        parts.push(` ${num} ${originalLines[i - 1]}`);
      }

      // Removed lines (from original)
      for (let i = 0; i < rep.oldLines.length; i++) {
        const num = String(rep.oldStartLine + i).padStart(numWidth, " ");
        parts.push(`-${num} ${rep.oldLines[i]}`);
      }

      // Added lines
      for (let i = 0; i < rep.newLines.length; i++) {
        const num = String(rep.oldStartLine + i).padStart(numWidth, " ");
        parts.push(`+${num} ${rep.newLines[i]}`);
      }

      cursor = rep.oldEndLine + 1;
    }

    // Trailing context for the merged chunk
    for (let i = cursor; i <= chunk.endLine; i++) {
      const num = String(i).padStart(numWidth, " ");
      parts.push(` ${num} ${originalLines[i - 1]}`);
    }
  }

  if (parts[parts.length - 1] !== "") parts.push("");
  return parts.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════════════════════════

export function formatPatchResult(result: PatchResult): string {
  const lines: string[] = [];
  for (const p of result.created) lines.push(`A ${p}`);
  for (const p of result.modified) lines.push(`M ${p}`);
  let output = lines.length > 0
    ? "Updated the following files:\n" + lines.join("\n")
    : "No files were modified.";
  if (result.warnings.length > 0) {
    output += "\n\n" + result.warnings.join("\n");
  }
  return output;
}

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
function generateLocalDiff(
  filePath: string,
  reps: ReplacementInfo[],
  neededLines: Map<number, string>,
  totalLines: number,
): string {
  if (reps.length === 0) return "";

  const parts: string[] = [];
  parts.push(`--- ${filePath}`);
  parts.push(`+++ ${filePath}`);

  // Calculate dynamic width based on max line number
  const maxLineNum = Math.max(totalLines, ...reps.map(r => r.oldEndLine));
  const numWidth = String(maxLineNum).length;

  // Merge replacement chunks
  const chunks = buildReplacementChunks(reps, totalLines, CONTEXT_LINES);
  for (let c = 0; c < chunks.length; c++) {
    if (c > 0) parts.push("");
    const chunk = chunks[c]!;
    parts.push(formatChunkHeader(chunk));
    parts.push(...formatChunkMetadataLines(chunk));

    // Output context + removed + added
    let cursor = chunk.startLine;
    for (const rep of chunk.reps) {
      // Context before this replacement
      for (let i = cursor; i < rep.oldStartLine; i++) {
        const lineText = neededLines.get(i);
        if (lineText !== undefined) {
          parts.push(` ${String(i).padStart(numWidth, " ")} ${lineText}`);
        }
      }
      // Removed lines
      for (let i = 0; i < rep.oldLines.length; i++) {
        parts.push(`-${String(rep.oldStartLine + i).padStart(numWidth, " ")} ${rep.oldLines[i]}`);
      }
      // Added lines
      for (let i = 0; i < rep.newLines.length; i++) {
        parts.push(`+${String(rep.oldStartLine + i).padStart(numWidth, " ")} ${rep.newLines[i]}`);
      }
      cursor = rep.oldEndLine + 1;
    }
    // Trailing context
    for (let i = cursor; i <= chunk.endLine; i++) {
      const lineText = neededLines.get(i);
      if (lineText !== undefined) {
        parts.push(` ${String(i).padStart(numWidth, " ")} ${lineText}`);
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
