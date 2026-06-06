/**
 * Safety Detection — main detection pipeline
 *
 * Three-pass detection:
 *   1. High-confidence pattern matching (unambiguous prefixes)
 *   2. Config-key regex matching (config-like files only)
 *   3. Adjusted Shannon entropy analysis (config-like files only)
 */

import {
  type SecretMatch,
  type SecretMatchSource,
  type DetectSecretsOptions,
  MIN_SCAN_LENGTH,
  SENSITIVE_CONFIG_KEY_REGEX,
} from "./types.js";
import { SECRET_PATTERNS, isConfigLikeFile, extractConfigStringEntries, looksLikeSensitiveConfigValue } from "./patterns.js";
import { isHighEntropy } from "./entropy.js";

// ─── Internal helpers ──────────────────────────────────────────────────────

function addMatch(matches: SecretMatch[], seen: Set<string>, match: SecretMatch): void {
  const key = `${match.start}-${match.end}`;
  if (seen.has(key)) return;
  seen.add(key);
  matches.push(match);
}

function isCoveredByExistingMatch(matches: SecretMatch[], start: number, end: number): boolean {
  return matches.some((existing) => !(end <= existing.start || start >= existing.end));
}

// ─── Main API ──────────────────────────────────────────────────────────────

export function detectSecrets(content: string, options: DetectSecretsOptions = {}): SecretMatch[] {
  if (content.length < MIN_SCAN_LENGTH) return [];
  const matches: SecretMatch[] = [];
  const seen = new Set<string>();
  const configLike = isConfigLikeFile(options.filePath);

  // Pass 1: High-confidence pattern matching (unambiguous prefixes like ghp_, AKIA)
  for (const sp of SECRET_PATTERNS) {
    if (!sp.highConfidence) continue;
    if (content.length < sp.minLength) continue;
    for (const m of content.matchAll(new RegExp(sp.pattern.source, sp.pattern.flags + "g"))) {
      const text = m[0];
      if (!text || m.index === undefined) continue;
      if (!sp.allowsSpaces && text.includes(" ")) continue;
      addMatch(matches, seen, {
        name: sp.name,
        start: m.index,
        end: m.index + text.length,
        original: text,
        source: "pattern",
      });
    }
  }

  if (configLike) {
    const entries = extractConfigStringEntries(content);

    // Pass 2: Regex key-name matching for config-like files only
    for (const entry of entries) {
      if (!SENSITIVE_CONFIG_KEY_REGEX.test(entry.normalizedKey)) continue;
      if (!looksLikeSensitiveConfigValue(entry.value)) continue;
      if (isCoveredByExistingMatch(matches, entry.start, entry.end)) continue;
      addMatch(matches, seen, {
        name: `Sensitive config key: ${entry.normalizedKey}`,
        start: entry.start,
        end: entry.end,
        original: entry.value,
        source: "regex",
      });
    }

    // Pass 3: Entropy analysis for config-like files only
    for (const entry of entries) {
      if (isCoveredByExistingMatch(matches, entry.start, entry.end)) continue;
      if (!looksLikeSensitiveConfigValue(entry.value)) continue;
      if (!isHighEntropy(entry.value)) continue;
      addMatch(matches, seen, {
        name: "High Entropy String",
        start: entry.start,
        end: entry.end,
        original: entry.value,
        source: "entropy",
      });
    }
  }

  // Sort by start position descending for safe right-to-left replacement
  return matches.sort((a, b) => b.start - a.start);
}

// ─── Masking ────────────────────────────────────────────────────────────────

function getMaskChar(source?: SecretMatchSource): string {
  if (source === "regex") return "#";
  if (source === "entropy") return "?";
  return "*";
}

export function maskSecret(text: string, source?: SecretMatchSource): string {
  const maskChar = getMaskChar(source);
  if (text.length <= 6) return maskChar.repeat(text.length);
  return text.slice(0, 3) + maskChar.repeat(text.length - 6) + text.slice(-3);
}
