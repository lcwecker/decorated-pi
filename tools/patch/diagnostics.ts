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
