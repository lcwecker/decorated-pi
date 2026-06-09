/**
 * Safety Module — Comprehensive Unit Tests
 *
 * Tests pure functions exported from safety/detect.ts:
 * - charClass / shannonEntropy / trigramScore
 * - splitByXClass / segmentDensity / maxSegmentDensity
 * - computeWordRatio / computeHexRatio / computeDictRatio
 * - calculateAdjustedEntropy / isHighEntropy / findHighEntropyTokens
 * - isSafeContent
 * - detectSecrets / maskSecret
 * - SECRET_PATTERNS / SAFE_PATTERNS
 *
 * All test secret values are publicly-documented examples, revoked test keys,
 * or fabricated patterns — NO real credentials.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import {
  charClass,
  shannonEntropy,
  trigramScore,
  splitByXClass,
  segmentDensity,
  maxSegmentDensity,
  computeWordRatio,
  computeHexRatio,
  computeDictRatio,
  calculateAdjustedEntropy,
  isHighEntropy,
  findHighEntropyTokens,
  ENTROPY_THRESHOLD,
  MIN_ENTROPY_TOKEN_LENGTH,
} from "../hooks/redact/entropy.js";
import {
  isSafeContent,
  SECRET_PATTERNS,
  SAFE_PATTERNS,
} from "../hooks/redact/patterns.js";
import {
  detectSecrets,
  maskSecret,
} from "../hooks/redact/detect.js";
import { redactModule } from "../hooks/redact.js";

// ═══════════════════════════════════════════════════════════════════════════
// charClass
// ═══════════════════════════════════════════════════════════════════════════

describe("charClass", () => {
  it("classifies uppercase as U", () => {
    for (const c of "ABCZ") expect(charClass(c)).toBe("U");
  });
  it("classifies lowercase as L", () => {
    for (const c of "abcz") expect(charClass(c)).toBe("L");
  });
  it("classifies digits as D", () => {
    for (const c of "0129") expect(charClass(c)).toBe("D");
  });
  it("classifies dash as S", () => {
    expect(charClass("-")).toBe("S");
  });
  it("classifies everything else as X", () => {
    for (const c of ".:_/@!") expect(charClass(c)).toBe("X");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// shannonEntropy
// ═══════════════════════════════════════════════════════════════════════════

describe("shannonEntropy", () => {
  it("returns 0 for empty string", () => {
    expect(shannonEntropy("")).toBe(0);
  });

  it("returns 0 for single repeated character", () => {
    expect(shannonEntropy("aaaa")).toBe(0);
  });

  it("returns higher entropy for mixed characters", () => {
    expect(shannonEntropy("aB3xK9mP")).toBeGreaterThan(shannonEntropy("aaaaaaaa"));
  });

  it("returns ~4.0 for 16 distinct hex chars", () => {
    // 16 distinct symbols → log2(16) = 4.0
    const entropy = shannonEntropy("0123456789abcdef");
    expect(entropy).toBeCloseTo(4.0, 1);
  });

  it("returns ~3.0 for 8 distinct chars repeated", () => {
    // 8 distinct symbols → log2(8) = 3.0
    const entropy = shannonEntropy("abcd1234");
    expect(entropy).toBeCloseTo(3.0, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// trigramScore
// ═══════════════════════════════════════════════════════════════════════════

describe("trigramScore", () => {
  it("returns 0 for pure digits", () => {
    expect(trigramScore("1", "2", "3")).toBe(0);
  });

  it("returns 1.0 for Letter↔Digit with digit in first position", () => {
    expect(trigramScore("3", "A", "b")).toBe(1.0);
  });

  it("returns 0 for Letter↔Digit with digit in second position", () => {
    expect(trigramScore("A", "3", "b")).toBe(0);
  });

  it("returns 0 for Letter↔Digit with digit only in third position", () => {
    expect(trigramScore("A", "b", "3")).toBe(0);
  });

  it("returns 1.0 for dash with ≥3 classes", () => {
    expect(trigramScore("A", "-", "3")).toBe(1.0); // U, S, D → 3 classes
  });

  it("returns 0 for dash with <3 classes", () => {
    expect(trigramScore("a", "-", "b")).toBe(0); // L, S, L → 2 classes
  });

  it("returns 0.8 for AbA pattern (2 uppercase + lowercase)", () => {
    expect(trigramScore("A", "B", "a")).toBe(0.8);
  });

  it("returns 0 for X-class characters", () => {
    expect(trigramScore("A", ".", "3")).toBe(0);
  });

  it("returns 0 for all-same uppercase (API-like)", () => {
    expect(trigramScore("A", "P", "I")).toBe(0); // 3 U, 0 L → no AbA
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// splitByXClass / segmentDensity / maxSegmentDensity
// ═══════════════════════════════════════════════════════════════════════════

describe("splitByXClass", () => {
  it("splits at :// and other X-class chars", () => {
    // :// splits: https | api-key (but - is S-class, not X)
    expect(splitByXClass("https://api-key")).toEqual(["https", "api-key"]);
    // dot splits
    expect(splitByXClass("api.key.secret")).toEqual(["api", "key", "secret"]);
  });

  it("splits at @ and .", () => {
    expect(splitByXClass("user@host.com")).toEqual(["user", "host", "com"]);
  });

  it("skips segments < 3 chars", () => {
    expect(splitByXClass("ab.cd")).toEqual([]);
  });

  it("returns whole token if no X-class", () => {
    expect(splitByXClass("abcDef123")).toEqual(["abcDef123"]);
  });
});

describe("segmentDensity", () => {
  it("returns 0 for segments < 3 chars", () => {
    expect(segmentDensity("ab")).toBe(0);
  });

  it("returns 0 for pure digits", () => {
    expect(segmentDensity("123456")).toBe(0);
  });

  it("returns > 0 for mixed alphanumeric", () => {
    expect(segmentDensity("aB3xK9mPqR7wN")).toBeGreaterThan(0);
  });
});

describe("maxSegmentDensity", () => {
  it("returns 0 for all-X tokens", () => {
    expect(maxSegmentDensity("@.!")).toBe(0);
  });

  it("returns max across segments", () => {
    // "api-key" has low density, "aB3xK9m" has high density
    expect(maxSegmentDensity("api-key.aB3xK9m")).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// computeWordRatio
// ═══════════════════════════════════════════════════════════════════════════

describe("computeWordRatio", () => {
  it("returns 0 for pure digits/symbols", () => {
    expect(computeWordRatio("1234567890")).toBe(0);
  });

  it("returns > 0 for English words", () => {
    // "password" is 8 chars, has vowels
    expect(computeWordRatio("password12345678")).toBeGreaterThan(0);
  });

  it("returns high ratio for mostly words", () => {
    const ratio = computeWordRatio("thequickbrownfox");
    expect(ratio).toBeGreaterThan(0.5);
  });

  it("returns 0 for mixed case with no alphabetic word segments", () => {
    expect(computeWordRatio("aB3xK9mPqR7wN2")).toBe(0);
  });

  it("treats uppercase words case-insensitively", () => {
    expect(computeWordRatio("NET_CHANNEL_INFO_REPORT_V20")).toBeGreaterThan(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// computeHexRatio
// ═══════════════════════════════════════════════════════════════════════════

describe("computeHexRatio", () => {
  it("returns 1.0 for pure hex", () => {
    expect(computeHexRatio("0123456789abcdef")).toBe(1.0);
  });

  it("returns ~1.0 for UUID", () => {
    expect(computeHexRatio("550e8400-e29b-41d4-a716-446655440000")).toBeGreaterThan(0.9);
  });

  it("returns 0 for all non-hex", () => {
    expect(computeHexRatio("ghijklmnop")).toBe(0);
  });

  it("returns partial ratio for mixed", () => {
    const ratio = computeHexRatio("abc123xyz");
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// computeDictRatio
// ═══════════════════════════════════════════════════════════════════════════

describe("computeDictRatio", () => {
  it("returns 0 for random gibberish", () => {
    expect(computeDictRatio("aB3xK9mPqR7wN2")).toBe(0);
  });

  it("returns > 0 for English words", () => {
    expect(computeDictRatio("password-secret-token")).toBeGreaterThan(0);
  });

  it("treats uppercase words case-insensitively", () => {
    expect(computeDictRatio("NET_CHANNEL_INFO_REPORT_V20")).toBeGreaterThan(0.5);
  });

  it("returns high ratio for model names with known words", () => {
    // "devstral-small" → "dev", "str", "small" are in dict
    const ratio = computeDictRatio("devstral-small-2");
    expect(ratio).toBeGreaterThan(0.3);
  });

  it("returns 0 for pure digits", () => {
    expect(computeDictRatio("1234567890123456")).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// calculateAdjustedEntropy
// ═══════════════════════════════════════════════════════════════════════════

describe("calculateAdjustedEntropy", () => {
  it("is high for random-looking secrets", () => {
    const e = calculateAdjustedEntropy("7aB9cD2eF4gH6jK8mN1pQ3rT5uV7xY9zA1bC3dE");
    expect(e).toBeGreaterThan(ENTROPY_THRESHOLD);
  });

  it("is low for UUIDs (hex penalty + dash)", () => {
    const e = calculateAdjustedEntropy("550e8400-e29b-41d4-a716-446655440000");
    expect(e).toBeLessThan(ENTROPY_THRESHOLD);
  });

  it("is low for English text (word + dict penalty)", () => {
    const e = calculateAdjustedEntropy("the-quick-brown-fox-jumps-over-the-lazy-dog");
    expect(e).toBeLessThan(ENTROPY_THRESHOLD);
  });

  it("is low for model names like devstral-small", () => {
    const e = calculateAdjustedEntropy("devstral-small-2:24b");
    expect(e).toBeLessThan(ENTROPY_THRESHOLD);
  });

  it("hex penalty only applies with hyphens", () => {
    // Pure hex without dashes should NOT get hex penalty
    const eNoDash = calculateAdjustedEntropy("a1b2c3d4e5f6a7b8c9d0e1f2a3b4");
    const eWithDash = calculateAdjustedEntropy("a1b2-c3d4-e5f6-a7b8-c9d0-e1f2-a3b4");
    // With dashes + high hex ratio → gets penalty
    expect(eNoDash).toBeGreaterThan(eWithDash);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// isHighEntropy / findHighEntropyTokens
// ═══════════════════════════════════════════════════════════════════════════

describe("isHighEntropy", () => {
  it("returns false for short strings", () => {
    expect(isHighEntropy("abc123")).toBe(false);
  });

  it("returns false for UUIDs", () => {
    expect(isHighEntropy("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
  });

  it("returns false for git SHAs", () => {
    expect(isHighEntropy("abc123def456789abc123def456789abc123def4")).toBe(false);
  });

  it("returns true for random mixed-case 32+ char strings", () => {
    expect(isHighEntropy("7aB9cD2eF4gH6jK8mN1pQ3rT5uV7xY9zA1bC3dE")).toBe(true);
  });

  it("exports the raised minimum entropy token length", () => {
    expect(MIN_ENTROPY_TOKEN_LENGTH).toBe(32);
  });
});

describe("findHighEntropyTokens", () => {
  it("extracts high-entropy tokens from text", () => {
    const tokens = findHighEntropyTokens('api_key="7aB9cD2eF4gH6jK8mN1pQ3rT5uV7xY9zA1bC3dE"');
    expect(tokens.length).toBeGreaterThan(0);
  });

  it("returns empty for plain English", () => {
    expect(findHighEntropyTokens("hello world this is normal text")).toHaveLength(0);
  });

  it("splits by whitespace and code punctuation", () => {
    // Quotes and = are split chars, so token between them is extracted
    const tokens = findHighEntropyTokens('key="7aB9cD2eF4gH6jK8mN1pQ3rT5uV7xY9zA1bC3dE"');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.some(t => t.includes("7aB9cD2e"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// isSafeContent
// ═══════════════════════════════════════════════════════════════════════════

describe("isSafeContent", () => {
  it("matches URLs without credentials", () => {
    expect(isSafeContent("https://api.example.com/v1/users")).toBe(true);
  });

  it("matches UUIDs", () => {
    expect(isSafeContent("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("matches semver", () => {
    expect(isSafeContent("1.2.3-beta.4")).toBe(true);
  });

  it("matches emails", () => {
    expect(isSafeContent("user@example.com")).toBe(true);
  });

  it("matches Git SHA-1", () => {
    expect(isSafeContent("abc123def456789abc123def456789abc123def4")).toBe(true);
  });

  it("matches Git SHA-256", () => {
    expect(isSafeContent("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")).toBe(true);
  });

  it("matches npm scoped packages", () => {
    expect(isSafeContent("@babel/core")).toBe(true);
  });

  it("matches placeholders", () => {
    expect(isSafeContent("your_api_key")).toBe(true);
    expect(isSafeContent("placeholder")).toBe(true);
    expect(isSafeContent("example")).toBe(true);
  });

  it("does NOT match random strings", () => {
    expect(isSafeContent("aB3xK9mPqR7wN2tL")).toBe(false);
  });

  it("does NOT match real secrets", () => {
    expect(isSafeContent(["AKIA", "IOSFODNN7EXAMPLE"].join(""))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// detectSecrets — Pattern Layer (known prefixes)
// ═══════════════════════════════════════════════════════════════════════════

describe("detectSecrets — Pattern Layer (high confidence)", () => {
  const cases: [string, string, string][] = [
    ["AWS Access Key ID", ["key=AKIA", "IOSFODNN7EXAMPLE"].join(""), "AWS Access Key ID"],
    ["GitHub PAT", ["token=ghp_", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl"].join(""), "GitHub PAT"],
    ["GitLab PAT", ["glpat", "-abcdefghijklmnopqrstuvwx"].join(""), "GitLab PAT"],
    ["Slack Token", ["xoxb", "-1234567890-abcdefghijklmnopqrstuvwx"].join(""), "Slack Token"],
    ["Google API Key", ["AIzaSy", "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567"].join(""), "Google API Key"],
    ["Stripe Secret Key", ["sk_live", "_abcdefghijklmnopqrstuvwxyz123456"].join(""), "Stripe Secret Key"],
    ["OpenAI Key (new format)", ["sk-proj-", "abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH"].join(""), "OpenAI API Key (New)"],
    ["Volcengine Ark Key", ["ark", "-abcdefghijklmnopqrstuvwxyz12345"].join(""), "Volcengine Ark API Key"],
    ["JWT", ["eyJhbGciOiJIUzI1", "NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456"].join(""), "JSON Web Token"],
    ["MongoDB URI", ["mongodb://user:", "password@host:27017/db"].join(""), "MongoDB Connection String"],
    ["PostgreSQL URI", ["postgresql://admin:", "secret@db.example.com:5432/production"].join(""), "PostgreSQL Connection String"],
    ["MySQL URI", ["mysql://root:", "password@localhost:3306/mydb"].join(""), "MySQL Connection String"],
    ["Redis URI", ["redis://:", "secret@redis.example.com:6379/0"].join(""), "Redis Connection String"],
    ["RSA Private Key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1\n-----END RSA PRIVATE KEY-----", "RSA Private Key"],
    ["OpenSSH Private Key", "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2EAAAADAQABAAABAQ\n-----END OPENSSH PRIVATE KEY-----", "OpenSSH Private Key"],
    ["Generic Private Key", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----", "Generic Private Key"],
    ["SendGrid API Key", ["SG.", "abcdefghijklmnopqrstuvwx.abcdefghijklmnopqrstuvwxyz0123456789ABCD"].join(""), "SendGrid API Key"],
  ];

  for (const [label, input, expectedName] of cases) {
    it(label, () => {
      const matches = detectSecrets(input);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.some(m => m.name === expectedName && m.source === "pattern")).toBe(true);
    });
  }
});

describe("detectSecrets — Regex Layer (config key matching)", () => {
  it("detects api_key in config files only", () => {
    const matches = detectSecrets('{"api_key":"abcdefghijklmnopqrstuvwxyz123456"}', { filePath: "config.json" });
    expect(matches.some(m => m.source === "regex" && m.original === "abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
  });

  it("detects password assignments in env files when values are 32+ chars", () => {
    const matches = detectSecrets("DB_PASSWORD=s3cret_val_1234567890_extra_chars", { filePath: ".env" });
    expect(matches.some(m => m.source === "regex" && m.original === "s3cret_val_1234567890_extra_chars")).toBe(true);
  });

  it("detects camelCase sensitive keys", () => {
    const matches = detectSecrets('{"clientSecret":"abcdefghijklmnopqrstuvwxyz123456"}', { filePath: "config.json" });
    expect(matches.some(m => m.source === "regex" && m.original === "abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
  });

  it("detects authToken-style keys", () => {
    const matches = detectSecrets('{"authToken":"abcdefghijklmnopqrstuvwxyz123456"}', { filePath: "config.json" });
    expect(matches.some(m => m.source === "regex" && m.original === "abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
  });

  it("detects dot and dash separated sensitive keys", () => {
    const matches = detectSecrets('{"webhook.secret":"abcdefghijklmnopqrstuvwxyz123456","access-token":"abcdefghijklmnopqrstuvwxyz123456"}', { filePath: "config.json" });
    expect(matches.filter(m => m.source === "regex")).toHaveLength(2);
  });

  it("skips placeholder config values", () => {
    const matches = detectSecrets('{"api_key":"your_api_key_here"}', { filePath: "config.json" });
    expect(matches.some(m => m.source === "regex")).toBe(false);
  });

  it("skips short sensitive config values under 32 chars", () => {
    const matches = detectSecrets('{"password":"short_secret_value"}', { filePath: "config.json" });
    expect(matches.some(m => m.source === "regex")).toBe(false);
  });

  it("does not run regex key matching on source files", () => {
    const matches = detectSecrets('api_key="abcdefghijklmnopqrstuvwxyz123456"', { filePath: "main.cpp" });
    expect(matches.some(m => m.source === "regex")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// detectSecrets — Entropy Layer
// ═══════════════════════════════════════════════════════════════════════════

describe("detectSecrets — Entropy Layer (unknown formats)", () => {
  const positiveCases: [string, string][] = [
    ["Random mixed-case", '{"value":"7aB9cD2eF4gH6jK8mN1pQ3rT5uV7xY9zA1bC3dE"}'],
    // 40+ char mixed alphanumeric (not pure hex, not SHA)
    ["Random mixed alphanumeric", '{"value":"9zY7xW5vU3tS1rQ8pN6mL4kJ2hG0fE7dC5bA3qP1nM"}'],
    ["Random digit-led mix", '{"value":"4Vi7Xk2Qm9Lp5Tr8Ws1Ya6Bd3Cn0Ef7Gh2Jk5Mn8"}'],
    ["Custom prefix ak-", '{"value":"ak-7aB9cD2eF4gH6jK8mN1pQ3rT5uV7xY9zA1bC3dE"}'],
    // Underscore prefix should still be detectable when stored as a config string value
    ["Custom prefix key_", '{"value":"key_7aB9cD2eF4gH6jK8mN1pQ3rT5uV7xY9zA1bC3dE"}'],
    ["Underscore-separated", '{"value":"pre_7aB9cD2eF4gH6jK8mN1pQ3rT5uV7xY9zA1bC3dE_suf"}'],
  ];

  for (const [label, input] of positiveCases) {
    it(label, () => {
      const matches = detectSecrets(input, { filePath: "config.json" });
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.some(m => m.name === "High Entropy String" && m.source === "entropy")).toBe(true);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// detectSecrets — Negative cases
// ═══════════════════════════════════════════════════════════════════════════

describe("detectSecrets — Negative cases", () => {
  const cases: [string, string][] = [
    ["UUID", "550e8400-e29b-41d4-a716-446655440000"],
    ["Git SHA-1", "abc123def456789abc123def456789abc123def4"],
    ["Git SHA-256", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["Semver", "1.2.3-beta.4"],
    ["Email", "user@example.com"],
    ["URL", "https://api.example.com/v1/users"],
    ["Placeholder", "your_api_key=xxxxxxxxxxxx"],
    ["Short string", "abc123"],
    ["npm package", "@babel/core"],
    ["CSS hex color", "background: #ff6600"],
    ["Chinese text", "这是中文文本包含密码和密钥但不是secret"],
    ["Japanese text", "設定ファイルにAPI鍵を配置しないでください"],
    ["Private key regex literal", "/-----BEGIN RSA PRIVATE KEY-----\\r?\\n(?:[A-Za-z0-9+/=]+\\r?\\n)+-----END RSA PRIVATE KEY-----/"],
  ];

  for (const [label, input] of cases) {
    it(label, () => {
      expect(detectSecrets(input)).toHaveLength(0);
    });
  }
});

describe("detectSecrets — source code identifiers (no FP)", () => {
  const ids = [
    "getApiKeyAndHeaders", "OAuthCredentials", "ProviderModelConfig",
    "OpenAI-compatible", "supportsReasoningEffort", "PROVIDER_DISPLAY_NAME",
    "OAuthLoginCallbacks", "setupOllamaCloud", "DetectImageType",
    "ModelPickerComponent", "DecoratedPiConfig", "generateTurnPrefixSummary",
    "hasConfiguredAuth", "setImageModelKey",
  ];

  for (const id of ids) {
    it(id, () => {
      expect(detectSecrets(id)).toHaveLength(0);
    });
  }
});

describe("detectSecrets — model IDs (no FP)", () => {
  const models = [
    "gemma3:12b", "devstral-small-2:24b", "gpt-oss:120b",
    "ministral-3:14b", "nemotron-3-nano:30b", "qwen3-next:80b",
  ];

  for (const m of models) {
    it(m, () => {
      expect(detectSecrets(`{ id: "${m}", name: "${m}" }`)).toHaveLength(0);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// maskSecret
// ═══════════════════════════════════════════════════════════════════════════

describe("maskSecret", () => {
  it("masks short strings fully with source-specific characters", () => {
    expect(maskSecret("abc")).toBe("***");
    expect(maskSecret("abc", "regex")).toBe("###");
    expect(maskSecret("abc", "entropy")).toBe("???");
  });

  it("preserves first and last 3 chars with original length", () => {
    expect(maskSecret(["AKIA", "IOSFODNN7EXAMPLE"].join(""))).toBe("AKI**************PLE");
  });

  it("keeps length and only masks the middle for values longer than 6", () => {
    expect(maskSecret("abcdefgh")).toBe("abc**fgh");
  });

  it("uses source-specific mask symbols when provided", () => {
    expect(maskSecret("abcdefghijkl", "pattern")).toBe("abc******jkl");
    expect(maskSecret("abcdefghijkl", "regex")).toBe("abc######jkl");
    expect(maskSecret("abcdefghijkl", "entropy")).toBe("abc??????jkl");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECRET_PATTERNS / SAFE_PATTERNS integrity
// ═══════════════════════════════════════════════════════════════════════════

describe("SECRET_PATTERNS integrity", () => {
  it("all patterns have required fields", () => {
    for (const p of SECRET_PATTERNS) {
      expect(p.name).toBeTruthy();
      expect(p.pattern).toBeInstanceOf(RegExp);
      expect(p.minLength).toBeGreaterThan(0);
      expect(typeof p.highConfidence).toBe("boolean");
      expect(typeof p.allowsSpaces).toBe("boolean");
    }
  });

  it("no duplicate pattern names", () => {
    const names = SECRET_PATTERNS.map(p => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("high-confidence patterns > low-confidence patterns", () => {
    const hc = SECRET_PATTERNS.filter(p => p.highConfidence).length;
    const lc = SECRET_PATTERNS.filter(p => !p.highConfidence).length;
    expect(hc).toBeGreaterThan(lc);
  });
});

describe("SAFE_PATTERNS integrity", () => {
  it("all safe patterns are valid regex", () => {
    for (const p of SAFE_PATTERNS) {
      expect(() => p.test("")).not.toThrow();
    }
  });

  it("has patterns for UUID, SHA, semver, email, URL, placeholder", () => {
    const sources = SAFE_PATTERNS.map(p => p.source);
    expect(sources.some(s => s.includes("a-fA-F"))).toBe(true); // UUID/SHA
    expect(sources.some(s => s.includes("@"))).toBe(true);       // email
    expect(sources.some(s => s.includes("https"))).toBe(true);   // URL
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration — local project scan (no entropy FP)
// ═══════════════════════════════════════════════════════════════════════════

describe("Integration — local project scan (no entropy FP)", () => {
  const projectRoot = path.join(__dirname, "..");

  function scanDir(dir: string): string[] {
    const fps: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === "test" || e.name === "package-lock.json") continue;
        fps.push(...scanDir(full));
      } else if (/\.(ts|js|md)$/.test(e.name)) {
        const body = fs.readFileSync(full, "utf8");
        if (body.length < 50) continue;
        const hits = detectSecrets(body).filter(h => h.name === "High Entropy String");
        const rel = path.relative(projectRoot, full);
        if (hits.length > 0) fps.push(`${rel} (${hits.length} entropy hits)`);
      }
    }
    return fps;
  }

  it("no entropy false positives in project files", () => {
    const fps = scanDir(projectRoot);
    expect(fps, fps.join("\n")).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Redact hook — patch tool coverage
// ═══════════════════════════════════════════════════════════════════════════
//
// Patch failures surface "did you mean" diagnostics that quote surrounding
// file content verbatim. If the file is a config / .env / source with API
// keys, those secrets would leak into the LLM context unless the redact
// hook covers the patch tool. The success path returns the constant
// "Success" so the filter is a no-op there, but it must still pass through.

describe("redactModule — patch tool coverage", () => {
  const handler = redactModule.hooks.tool_result![0]!;
  const silentCtx = { hasUI: false, cwd: "/tmp", ui: { notify: () => {} } } as any;
  const noopPi = {} as any;

  function makeEvent(toolName: string, text: string, input: Record<string, unknown> = {}): any {
    return {
      toolName,
      toolCallId: "call_test",
      input,
      content: [{ type: "text", text }],
    };
  }

  it("redacts secrets in patch failure diagnostics (pattern match)", () => {
    // `sk-proj-` OpenAI-style key — pattern requires 40+ chars after
    // the prefix. Fabricated value, not a real key.
    const fakeOpenAIKey = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789aBcDeFgHiJkLmN";
    const event = makeEvent(
      "patch",
      'old_str not found in src/config.ts: "old-key=placeholder".\n' +
      'Did you mean:\n' +
      `  api_key = "${fakeOpenAIKey}"`,
      { path: "src/config.ts" },
    );
    const out = handler(event, silentCtx, noopPi) as any;
    expect(out).toBeDefined();
    expect(out.content[0].text).not.toContain(fakeOpenAIKey);
    expect(out.content[0].text).toMatch(/\*+/);
  });

  it("redacts GitHub PAT in patch failure diagnostics (pattern match)", () => {
    // GitHub Personal Access Token: `ghp_` prefix + 36 alphanumerics.
    // Fabricated value, not a real token.
    const fakeGhPat = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const event = makeEvent(
      "patch",
      'old_str not found in src/auth.ts.\n' +
      'Did you mean:\n' +
      `  GITHUB_TOKEN = "${fakeGhPat}"`,
      { path: "src/auth.ts" },
    );
    const out = handler(event, silentCtx, noopPi) as any;
    expect(out).toBeDefined();
    expect(out.content[0].text).not.toContain(fakeGhPat);
    expect(out.content[0].text).toMatch(/\*+/);
  });

  it("passes patch success (\"Success\") through unchanged", () => {
    // Success path text is a constant — no secrets, filter must be a no-op.
    const event = makeEvent("patch", "Success", { path: "src/foo.ts" });
    const out = handler(event, silentCtx, noopPi);
    expect(out).toBeUndefined(); // no redactions → handler returns undefined (no-op)
  });

  it("ignores tools outside the allowlist (e.g. unknown tool)", () => {
    // Pattern-matches a real secret format, but the tool name isn't in
    // the allowlist — handler must early-return without redacting.
    const event = makeEvent("grep", "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789aBcDeFgHiJkLmN", { path: "src/x.ts" });
    const out = handler(event, silentCtx, noopPi);
    expect(out).toBeUndefined(); // allowlist filters grep out
  });
});

