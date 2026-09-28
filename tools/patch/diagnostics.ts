/**
 * patch — old_str mismatch diagnostics.
 *
 * Turns a failed exact match into a hint the model can act on: closest
 * line, tab/space mismatch, trailing whitespace, case, indent.
 */

// ─── old_str mismatch diagnostics ─────────────────────────────────────────

/** Detect tab width from the file by analyzing indentation columns of tab-only lines. */
export function detectTabWidth(content: string): number {
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

/** Reported when a patch carries no edits at all. The schema deliberately has
 *  no `minItems`, because the strict provider subset rejects length keywords;
 *  so an empty array reaches the apply path and fails here instead. */
export const EMPTY_EDITS_HINT =
  "edits[] is empty — provide at least one { old_str, new_str } edit, where old_str is the exact text being replaced.";

/** How many lines each side the uniqueness hint is willing to add. Past this
 *  the suggestion grows longer than the model can usefully copy, so the hint
 *  names the limit instead. */
export const MAX_UNIQUE_EXPANSION = 5;

export interface UniqueExpansion {
  /** Context lines added above / below the first occurrence. */
  up: number;
  down: number;
  /** 1-based range of the widened block in the file. */
  startLine: number;
  endLine: number;
  /** The widened text, verbatim from the file. */
  block: string;
  /** Context lines the widening added, verbatim; empty when that side grew by
   *  nothing. `old_str` replacements must repeat them (see expansionAdvice). */
  addedAbove: string;
  addedBelow: string;
}

/** Smallest number of surrounding lines that turns a duplicated text into a
 *  unique match, so the hint can name the range instead of leaving the model
 *  to guess how much context is enough. Widening upward is tried first:
 *  quoted code usually carries the line above the change. */
export function findUniqueExpansion(
  text: string,
  content: string,
  maxPerSide = MAX_UNIQUE_EXPANSION,
): UniqueExpansion | undefined {
  const firstIdx = content.indexOf(text);
  if (firstIdx === -1) return undefined;
  const fileLines = content.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of fileLines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const baseStart = content.substring(0, firstIdx).split("\n").length - 1; // 0-based
  // A trailing newline splits into an empty last element that occupies no line,
  // so the base span has to stop before it.
  const textLines = text.split("\n");
  const height = text.endsWith("\n") ? textLines.length - 1 : textLines.length;
  const baseEnd = baseStart + Math.max(0, height - 1);
  for (let total = 1; total <= maxPerSide * 2; total++) {
    // Within one budget, spend it upward first: the guard or comment above a
    // duplicated line is the context a reader (and the model) already has,
    // while lines below run into the next block.
    for (let up = Math.min(total, maxPerSide); up >= 0; up--) {
      const down = total - up;
      if (down > maxPerSide) continue;
      const from = baseStart - up;
      const to = baseEnd + down;
      if (from < 0 || to >= fileLines.length) continue;
      const block = fileLines.slice(from, to + 1).join("\n");
      // Same test the matcher applies: a second match anywhere after the first
      // start, overlapping ones included.
      if (content.indexOf(block, lineStarts[from]! + 1) === -1) {
        return {
          up,
          down,
          startLine: from + 1,
          endLine: to + 1,
          block,
          addedAbove: up > 0 ? fileLines.slice(from, baseStart).join("\n") : "",
          addedBelow: down > 0 ? fileLines.slice(baseEnd + 1, to + 1).join("\n") : "",
        };
      }
    }
  }
  return undefined;
}

/** Name the range that makes `text` unique, with the widened text ready to
 *  paste into old_str / anchor. */
function expansionAdvice(kind: "old_str" | "anchor", text: string, content: string): string {
  const expansion = findUniqueExpansion(text, content);
  if (!expansion) {
    const alternative = kind === "anchor" ? "old_str" : "a distinctive anchor";
    return `No unique window within ${MAX_UNIQUE_EXPANSION} lines above or below — widen with ${alternative}, or read the file and quote a larger region.`;
  }
  const { up, down, startLine, endLine, block, addedAbove, addedBelow } = expansion;
  const added = [up > 0 ? `${up} line(s) above` : "", down > 0 ? `${down} line(s) below` : ""]
    .filter(Boolean)
    .join(" and ");
  const lines: string[] = [];
  if (kind === "anchor") {
    lines.push(`Widen anchor by ${added} (lines ${startLine}-${endLine}) to make it unique.`);
  } else {
    lines.push(
      `Widen old_str by ${added} (lines ${startLine}-${endLine}), or keep old_str as-is and pass`,
      `a unique anchor above it — that needs no new_str change. If you widen, the match replaces the`,
      `whole block, so new_str has to keep the added lines too:`,
    );
  }
  if (addedAbove) lines.push(`  added above: ${JSON.stringify(addedAbove)}`);
  if (addedBelow) lines.push(`  added below: ${JSON.stringify(addedBelow)}`);
  lines.push(`  Suggested ${kind}:\n  ${JSON.stringify(block)}`);
  return lines.join("\n");
}

/** Shared body for the duplicated-text hints. */
function notUniqueHint(kind: "old_str" | "anchor", text: string, content: string): string {
  const fileLines = content.split("\n");
  const occurrences: number[] = [];
  let idx = 0;
  while ((idx = content.indexOf(text, idx)) !== -1) {
    occurrences.push(content.substring(0, idx).split("\n").length);
    idx++;
  }
  if (occurrences.length === 0) return "";
  const shown = occurrences.slice(0, 5);
  const extra = occurrences.length - shown.length;
  const lines = shown.map((n) => `  line ${n}: "${(fileLines[n - 1] ?? "").replace(/\t/g, "\\t").slice(0, 60)}"`);
  if (extra > 0) lines.push(`  and ${extra} more occurrence(s)`);
  lines.push(
    occurrences.length > 1
      ? expansionAdvice(kind, text, content)
      : "Add more surrounding context to make it unique.",
  );
  return `${kind} appears ${occurrences.length} times:\n${lines.join("\n")}`;
}

export function diagnoseOldStrNotUnique(oldNorm: string, content: string): string {
  return notUniqueHint("old_str", oldNorm, content);
}

/** Same hint for an anchor that matched more than once: the fix is a longer
 *  anchor, and the same widening search can name the range. */
export function diagnoseAnchorNotUnique(anchorNorm: string, content: string): string {
  return notUniqueHint("anchor", anchorNorm, content);
}

/** Try fuzzy match: normalize tab↔space and trailing whitespace, then search line-by-line. */
export function tryFuzzyLineMatch(
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
export function normalizeIndentForFuzzy(actualLine: string, newLine: string): string {
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

export function truncate(s: string, maxLen = 60): string {
  if (s.length <= maxLen) return s;
  // Show first line only
  const firstLine = s.split("\n")[0];
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen - 3) + "...";
}
