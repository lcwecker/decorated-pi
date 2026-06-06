/**
 * Safety Detection — known secret patterns and safe-pattern exclusions
 */

import { basename, extname } from "node:path";
import {
  type SecretPattern,
  type ConfigStringEntry,
  CONFIG_FILE_EXTENSIONS,
  CONFIG_BASENAME_REGEX,
  SENSITIVE_CONFIG_KEY_REGEX,
  PLACEHOLDER_VALUE_REGEX,
  CONFIG_VALUE_MIN_LENGTH,
} from "./types.js";

// ─── High-confidence Secret Patterns (40+ known formats) ─────────────────

export const SECRET_PATTERNS: SecretPattern[] = [
  // AWS
  { name: "AWS Access Key ID",         pattern: /AKIA[0-9A-Z]{16}/,                                                minLength: 16,  allowsSpaces: false, highConfidence: true },
  { name: "AWS Secret Access Key",    pattern: /(?:aws)?_?(?:secret)?_?(?:access)?_?key['"\s:=]+['"]?[0-9a-zA-Z/+]{40}['"]?/i, minLength: 30, allowsSpaces: false, highConfidence: true },
  // GitHub
  { name: "GitHub OAuth Token",       pattern: /gho_[0-9a-zA-Z]{36}/,                                            minLength: 36,  allowsSpaces: false, highConfidence: true },
  { name: "GitHub App Token",          pattern: /(?:ghu|ghs)_[0-9a-zA-Z]{36}/,                                    minLength: 36,  allowsSpaces: false, highConfidence: true },
  { name: "GitHub PAT",               pattern: /ghp_[0-9a-zA-Z]{36}/,                                            minLength: 36,  allowsSpaces: false, highConfidence: true },
  { name: "GitHub Fine-Grained Token", pattern: /github_pat_[0-9a-zA-Z_]{22,}/,                                   minLength: 26,  allowsSpaces: false, highConfidence: true },
  // GitLab
  { name: "GitLab PAT",              pattern: /glpat-[0-9a-zA-Z\-_]{20,}/,                                      minLength: 20,  allowsSpaces: false, highConfidence: true },
  { name: "GitLab Runner Token",      pattern: /glrt-[0-9a-zA-Z_\-]{20,}/,                                      minLength: 20,  allowsSpaces: false, highConfidence: true },
  // Slack
  { name: "Slack Token",             pattern: /xox[baprs]-[0-9a-zA-Z\-]{10,48}/,                                minLength: 15,  allowsSpaces: false, highConfidence: true },
  { name: "Slack Webhook URL",        pattern: /https:\/\/hooks\.slack\.com\/services\/T[a-zA-Z0-9_]{8,}\/B[a-zA-Z0-9_]{8,}\/[a-zA-Z0-9_]{24}/, minLength: 60, allowsSpaces: false, highConfidence: true },
  // JWT
  { name: "JSON Web Token",          pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/, minLength: 36, allowsSpaces: false, highConfidence: true },
  // Google
  { name: "Google API Key",          pattern: /AIza[0-9A-Za-z\-_]{35}/,                                         minLength: 35,  allowsSpaces: false, highConfidence: true },
  { name: "Google OAuth Token",       pattern: /ya29\.[0-9A-Za-z\-_]+/,                                          minLength: 10,  allowsSpaces: false, highConfidence: true },
  // Stripe
  { name: "Stripe Secret Key",       pattern: /sk_live_[0-9a-zA-Z]{24,}/,                                       minLength: 24,  allowsSpaces: false, highConfidence: true },
  { name: "Stripe Restricted Key",    pattern: /rk_live_[0-9a-zA-Z]{24,}/,                                       minLength: 24,  allowsSpaces: false, highConfidence: true },
  // Twilio / SendGrid / Discord
  { name: "Twilio API Key",          pattern: /SK[a-z0-9]{32}/,                                                 minLength: 30,  allowsSpaces: false, highConfidence: true },
  { name: "SendGrid API Key",        pattern: /SG\.[a-zA-Z0-9_-]{22,}\.[a-zA-Z0-9_-]{40,}/,                    minLength: 40,  allowsSpaces: false, highConfidence: true },
  { name: "Discord Bot Token",        pattern: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}/,                    minLength: 40,  allowsSpaces: false, highConfidence: true },
  // OpenAI / Anthropic / Volcengine Ark
  { name: "OpenAI API Key",          pattern: /sk-[a-zA-Z0-9]{20,}T3BlbkFJ[a-zA-Z0-9]{20,}/,                    minLength: 40,  allowsSpaces: false, highConfidence: true },
  { name: "OpenAI API Key (New)",    pattern: /sk-(?:proj-)?[a-zA-Z0-9\-_]{40,}/,                               minLength: 40,  allowsSpaces: false, highConfidence: true },
  { name: "Anthropic API Key",       pattern: /sk-ant-api[0-9]{2}-[a-zA-Z0-9\-_]{80,}/,                          minLength: 80,  allowsSpaces: false, highConfidence: true },
  { name: "Volcengine Ark API Key",  pattern: /ark-[a-zA-Z0-9\-_]{20,}/,                                        minLength: 20,  allowsSpaces: false, highConfidence: true },
  // NPM / PyPI
  { name: "NPM Token",               pattern: /npm_[a-zA-Z0-9]{36}/,                                            minLength: 36,  allowsSpaces: false, highConfidence: true },
  { name: "PyPI Token",              pattern: /pypi-[a-zA-Z0-9_\-]{50,}/,                                       minLength: 50,  allowsSpaces: false, highConfidence: true },
  // Private Keys
  { name: "RSA Private Key",         pattern: /-----BEGIN RSA PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END RSA PRIVATE KEY-----/,                           minLength: 40,  allowsSpaces: true,  highConfidence: true },
  { name: "OpenSSH Private Key",     pattern: /-----BEGIN OPENSSH PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END OPENSSH PRIVATE KEY-----/,                   minLength: 40,  allowsSpaces: true,  highConfidence: true },
  { name: "EC Private Key",          pattern: /-----BEGIN EC PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END EC PRIVATE KEY-----/,                              minLength: 40,  allowsSpaces: true,  highConfidence: true },
  { name: "PGP Private Key",         pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PGP PRIVATE KEY BLOCK-----/,              minLength: 40,  allowsSpaces: true,  highConfidence: true },
  { name: "Generic Private Key",     pattern: /-----BEGIN (ENCRYPTED )?PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END \1PRIVATE KEY-----/,                   minLength: 40,  allowsSpaces: true,  highConfidence: true },
  // Database URIs
  { name: "MongoDB Connection String", pattern: /mongodb(?:\+srv)?:\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/,           minLength: 20,  allowsSpaces: false, highConfidence: true },
  { name: "PostgreSQL Connection String", pattern: /postgres(?:ql)?:\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/,        minLength: 20,  allowsSpaces: false, highConfidence: true },
  { name: "MySQL Connection String",  pattern: /mysql:\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/,                        minLength: 20,  allowsSpaces: false, highConfidence: true },
  { name: "Redis Connection String",  pattern: /redis:\/\/[^\s'"]*:[^\s'"]+@[^\s'"]+/,                         minLength: 15,  allowsSpaces: false, highConfidence: true },
  // URL-embedded passwords
  { name: "Password in URL",         pattern: /[a-zA-Z]{3,10}:\/\/[^/\s:@]{3,20}:[^/\s:@]{3,20}@[^\s'"]+/,    minLength: 15,  allowsSpaces: false, highConfidence: true },
  // Generic assignments (lower confidence — checked against SAFE_PATTERNS)
  { name: "Bearer Token",            pattern: /[Bb]earer\s+[a-zA-Z0-9\-._~+/]+=*/,                               minLength: 15,  allowsSpaces: false, highConfidence: false },
  { name: "Basic Auth Header",       pattern: /[Bb]asic\s+[a-zA-Z0-9+/]{20,}={0,2}/,                            minLength: 20,  allowsSpaces: false, highConfidence: false },
  { name: "API Key Assignment",      pattern: /(?:api[_-]?key|apikey|api[_-]?secret)['"\s:=]+['"]?[a-zA-Z0-9\-._]{20,}['"]?/i, minLength: 20, allowsSpaces: false, highConfidence: false },
  { name: "Secret Assignment",       pattern: /(?:secret|token|password|passwd|pwd)['"\s:=]+['"]?[a-zA-Z0-9\-._!@#$%^&*]{8,}['"]?/i, minLength: 12, allowsSpaces: false, highConfidence: false },
];

// ─── Safe Patterns (false-positive exclusion) ────────────────────────────

export const SAFE_PATTERNS: RegExp[] = [
  /^https?:\/\/[a-zA-Z0-9.-]+(?:\/[a-zA-Z0-9.\/_\-?&=#%]*)?$/,  // URLs without credentials
  /^\.\.?\/[a-zA-Z0-9_\-./]+$/,                                 // Relative file paths
  /^\/[a-zA-Z0-9_\-./]+$/,                                       // Absolute Unix paths
  /^[a-zA-Z]:\\[a-zA-Z0-9_\-\\./]+$/,                            // Windows paths
  /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/,        // Email addresses
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, // UUIDs
  /^v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?(?:\+[a-zA-Z0-9.]+)?$/,  // Semver
  /^(?:xxx+|your[_-]?(?:api[_-]?)?key|placeholder|example|test|demo|sample)/i, // Placeholders
  /^[0-9a-f]{40}$/i,                                              // Git SHA-1
  /^[0-9a-f]{64}$/i,                                              // SHA-256
  /^@[a-z0-9-]+\/[a-z0-9-]+$/,                                   // npm scoped packages
];

export function isSafeContent(content: string): boolean {
  for (const pat of SAFE_PATTERNS) {
    if (pat.test(content)) return true;
  }
  return false;
}

// ─── Config-file detection ───────────────────────────────────────────────

export function isConfigLikeFile(filePath?: string): boolean {
  if (!filePath) return false;
  const name = basename(filePath);
  if (CONFIG_BASENAME_REGEX.test(name)) return true;
  return CONFIG_FILE_EXTENSIONS.has(extname(name).toLowerCase());
}

const CONFIG_STRING_PATTERNS: RegExp[] = [
  /(?<key>"[^"\r\n]+"|'[^'\r\n]+'|[A-Za-z0-9_.-]+)\s*[:=]\s*"(?<value>(?:\\.|[^"\\])*)"/g,
  /(?<key>"[^"\r\n]+"|'[^'\r\n]+'|[A-Za-z0-9_.-]+)\s*[:=]\s*'(?<value>(?:\\.|[^'\\])*)'/g,
  /(?<key>[A-Za-z0-9_.-]+)\s*=\s*(?<value>[^\r\n#;]+)/g,
];

export function normalizeConfigKey(key: string): string {
  return key
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[.\-\s]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function looksLikeSensitiveConfigValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (PLACEHOLDER_VALUE_REGEX.test(trimmed)) return false;
  if (isSafeContent(trimmed)) return false;
  if (/^(?:true|false|null)$/i.test(trimmed)) return false;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return false;
  return trimmed.length >= CONFIG_VALUE_MIN_LENGTH;
}

export function extractConfigStringEntries(content: string): ConfigStringEntry[] {
  const entries: ConfigStringEntry[] = [];
  const seen = new Set<string>();

  for (const pattern of CONFIG_STRING_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const key = match.groups?.key;
      const value = match.groups?.value;
      if (!key || value === undefined || match.index === undefined) continue;
      const full = match[0] ?? "";
      const rel = full.indexOf(value);
      if (rel < 0) continue;
      const start = match.index + rel;
      const end = start + value.length;
      const dedupeKey = `${start}-${end}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      entries.push({ key, normalizedKey: normalizeConfigKey(key), value, start, end });
    }
  }

  return entries;
}
