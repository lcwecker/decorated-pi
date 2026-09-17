/**
 * patch — shared types and error classes.
 *
 * Split out of core.ts so diff / diagnostics / locate / lines can import
 * them without routing through core.ts (which would create a cycle).
 */

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
  /** Verbatim normalized replacement text (for byte-faithful writeback). */
  newStr?: string;
  /** Offset in normalized content where the matched region starts (writeback). */
  normStart?: number;
  /** Offset one past the matched region in normalized content (writeback). */
  normEnd?: number;
  /** Anchor was provided but appeared multiple times; matcher fell back to a global old_str search. */
  anchorNotUnique?: boolean;
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
