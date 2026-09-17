/**
 * patch — edit location.
 *
 * Shared locator for anchor / exact / fuzzy matching, used by both the
 * apply path and the preview path so the two can never drift apart.
 */

import {
  diagnoseOldStrNotUnique,
  normalizeIndentForFuzzy,
  truncate,
  tryFuzzyLineMatch,
} from "./diagnostics.js";
import { normalizeLineEndings } from "./lines.js";
import { ApplyError } from "./types.js";

export type LocateEditResult =
  | {
      found: true;
      oldNorm: string;
      newNorm: string;
      matchIdx: number;
      displayAnchor?: string;
      anchorMissing: boolean;
      anchorNotUnique: boolean;
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
export function locateEdit(
  edit: { old_str: string; new_str: string; anchor?: string },
  content: string,
  displayPath: string,
): LocateEditResult {
  let oldNorm = normalizeLineEndings(edit.old_str);
  let newNorm = normalizeLineEndings(edit.new_str);

  let searchFrom = 0;
  let displayAnchor: string | undefined;
  let anchorMissing = false;
  let anchorNotUnique = false;
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
    // Distinguish the two degradation modes: a not-unique anchor still
    // appeared in the file (just more than once), whereas a missing anchor
    // did not appear at all. The diff label differs accordingly.
    if (anchorState === "not_unique") anchorNotUnique = true;
    else anchorMissing = true;
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

  return { found: true, oldNorm, newNorm, matchIdx, displayAnchor, anchorMissing, anchorNotUnique };
}
