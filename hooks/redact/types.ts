/**
 * Redact — shared types and constants
 */

export type SecretMatchSource = "pattern" | "regex" | "entropy";

export interface SecretMatch {
  name: string;
  start: number;
  end: number;
  original: string;
  source: SecretMatchSource;
}

export interface SecretPattern {
  name: string;
  pattern: RegExp;
  minLength: number;
  allowsSpaces: boolean;
  highConfidence: boolean;
}

export interface DetectSecretsOptions {
  filePath?: string;
}

export interface ConfigStringEntry {
  key: string;
  normalizedKey: string;
  value: string;
  start: number;
  end: number;
}

export const MIN_SCAN_LENGTH = 10;
export const CONFIG_VALUE_MIN_LENGTH = 32;
export const CONFIG_FILE_EXTENSIONS = new Set([
  ".json", ".jsonc", ".env", ".toml", ".yaml", ".yml",
  ".ini", ".cfg", ".conf", ".properties",
]);
export const CONFIG_BASENAME_REGEX = /^\.env(?:\..+)?$/i;
export const SENSITIVE_CONFIG_KEY_REGEX = /(?:^|_)(?:apikey|api_(?:key|secret|token)|access_(?:key|token)|refresh_token|client_secret|secret(?:_key)?|private_key|bearer_token|auth(?:orization|_token)?|pass(?:word|wd)?|pwd|token|webhook_secret)(?:_|$)/i;
export const PLACEHOLDER_VALUE_REGEX = /^(?:\$\{[^}]+\}|\{\{[^}]+\}\}|<[^>]+>|xxx+|placeholder|example|sample|demo|test|changeme|your[_-]?(?:api[_-]?)?key(?:[_-]?here)?)$/i;
