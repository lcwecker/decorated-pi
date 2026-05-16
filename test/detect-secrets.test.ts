/**
 * Secret Detection Algorithm Tests — V3 + Dictionary
 *
 * All test secret values are publicly-documented examples, revoked test keys,
 * or fabricated patterns — NO real credentials.
 *
 * Run: npx vitest run
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";

// ─── Dictionary ──────────────────────────────────────────────────────────────

const DICT_WORDS: ReadonlySet<string> = new Set(
  JSON.parse(fs.readFileSync(path.join(__dirname, "dict-words.json"), "utf8"))
);

// ─── Detection algorithm (same as safety.ts) ────────────────────────────────

function charClass(c: string): "U" | "L" | "D" | "S" | "X" {
  const code = c.charCodeAt(0);
  if (code >= 65 && code <= 90) return "U";
  if (code >= 97 && code <= 122) return "L";
  if (code >= 48 && code <= 57) return "D";
  if (c === "-") return "S";
  return "X";
}

function shannonEntropy(data: string): number {
  if (data.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const char of data) freq.set(char, (freq.get(char) ?? 0) + 1);
  let entropy = 0;
  const len = data.length;
  for (const count of freq.values()) { const p = count / len; entropy -= p * Math.log2(p); }
  return entropy;
}

function trigramScore(c1: string, c2: string, c3: string): number {
  const cls: string[] = [charClass(c1), charClass(c2), charClass(c3)];
  if (cls.includes("X")) return 0;
  const unique = new Set(cls);
  if (unique.size === 1 && cls[0] === "D") return 0;
  if (cls.includes("S") && unique.size >= 3) return 1.0;
  const hasDigit = cls.includes("D");
  const hasLetter = cls.includes("L") || cls.includes("U");
  if (hasDigit && hasLetter && (cls[0] === "D" || cls[1] === "D")) return 1.0;
  const uCount = cls.filter(c => c === "U").length;
  const lCount = cls.filter(c => c === "L").length;
  if (uCount >= 2 && lCount >= 1) return 0.8;
  return 0;
}

function splitByXClass(token: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (const c of token) {
    if (charClass(c) === "X") { if (current.length >= 3) segments.push(current); current = ""; }
    else { current += c; }
  }
  if (current.length >= 3) segments.push(current);
  return segments;
}

function segmentDensity(segment: string): number {
  if (segment.length < 3) return 0;
  let totalScore = 0;
  for (let i = 0; i <= segment.length - 3; i++)
    totalScore += trigramScore(segment[i]!, segment[i + 1]!, segment[i + 2]!);
  return totalScore / (segment.length - 2);
}

function maxSegmentDensity(token: string): number {
  const segments = splitByXClass(token);
  if (segments.length === 0) return 0;
  let maxD = 0;
  for (const seg of segments) { const d = segmentDensity(seg); if (d > maxD) maxD = d; }
  return maxD;
}

function computeWordRatio(token: string): number {
  const segments: string[] = [];
  let current = "", prevClass = "";
  for (const c of token) {
    const cls = charClass(c);
    if (cls === "X") { if (current.length > 0) { segments.push(current); current = ""; } prevClass = ""; continue; }
    if (cls !== prevClass && current.length > 0) { segments.push(current); current = ""; }
    current += c; prevClass = cls;
  }
  if (current.length > 0) segments.push(current);
  let wordLen = 0;
  for (const seg of segments) {
    if (seg.length >= 3 && /^[a-z]+$/.test(seg) && /[aeiou]/.test(seg)) wordLen += seg.length;
  }
  return token.length > 0 ? wordLen / token.length : 0;
}

function computeDictRatio(token: string): number {
  const lowerSeqs: string[] = [];
  let current = "";
  for (const c of token) {
    if (/[a-z]/.test(c)) { current += c; }
    else { if (current.length >= 3) lowerSeqs.push(current); current = ""; }
  }
  if (current.length >= 3) lowerSeqs.push(current);
  if (lowerSeqs.length === 0) return 0;
  let matchedChars = 0;
  for (const seq of lowerSeqs) {
    let pos = 0;
    while (pos < seq.length) {
      let longestMatch = 0;
      for (let end = seq.length; end > pos; end--) {
        if (DICT_WORDS.has(seq.slice(pos, end))) { longestMatch = end - pos; break; }
      }
      if (longestMatch > 0) { matchedChars += longestMatch; pos += longestMatch; }
      else { pos++; }
    }
  }
  return token.length > 0 ? matchedChars / token.length : 0;
}

function computeHexRatio(token: string): number {
  let hexChars = 0;
  for (const c of token) { if (/[0-9a-fA-F\-]/.test(c)) hexChars++; }
  return token.length > 0 ? hexChars / token.length : 0;
}

const THR = 5.5, MINLEN = 16, W1 = 3.0, W2 = 3.0, W3 = 4.0, HPEN = 2.5, HRT = 0.9;

function calcEntropy(data: string): number {
  // Hex penalty: only for hyphenated UUID-like tokens
  const hp = (computeHexRatio(data) > HRT && data.includes("-")) ? HPEN : 0;
  return shannonEntropy(data) + maxSegmentDensity(data) * W1 - computeWordRatio(data) * W2
    - computeDictRatio(data) * W3 - hp;
}

const SAFE: RegExp[] = [
  /^https?:\/\/[a-zA-Z0-9.-]+(?:\/[a-zA-Z0-9.\/_\-?&=#%]*)?$/,
  /^\.[^\/]+$/,  /^[a-zA-Z]:[\\][a-zA-Z0-9_\-\\./]+$/,
  /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/,
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  /^v?\d+\.\d+\.\d+(?:-\w+)?(?:\+\w+)?$/,
  /^(?:xxx+|your[_-]?(?:api[_-]?)?key|placeholder|example|test|demo)/i,
  /^[0-9a-f]{40}$/i, /^[0-9a-f]{64}$/i, /^@[a-z0-9-]+\/[a-z0-9-]+$/,
];
function isSafe(t: string) { return SAFE.some(p => p.test(t)); }

// ─── Patterns ────────────────────────────────────────────────────────────────

interface SP { name: string; pat: RegExp; hc: boolean; }
const PATS: SP[] = [
  { name: "AWS Key", pat: /AKIA[0-9A-Z]{16}/, hc: true },
  { name: "GitHub PAT", pat: /ghp_[0-9a-zA-Z]{36}/, hc: true },
  { name: "GitLab PAT", pat: /glpat-[0-9a-zA-Z\-_]{20,}/, hc: true },
  { name: "Slack Token", pat: /xox[baprs]-[0-9a-zA-Z\-]{10,48}/, hc: true },
  { name: "OpenAI key", pat: /sk-(?:proj-)?[a-zA-Z0-9\-_]{40,}/, hc: true },
  { name: "Volcengine Ark", pat: /ark-[a-zA-Z0-9\-_]{20,}/, hc: true },
  { name: "Stripe key", pat: /sk_(?:test|live)_[0-9a-zA-Z]{24,}/, hc: true },
  { name: "Google API Key", pat: /AIza[0-9A-Za-z\-_]{35}/, hc: true },
  { name: "JWT", pat: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/, hc: true },
  { name: "PostgreSQL URI", pat: /postgres(?:ql)?:\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/, hc: true },
  { name: "MongoDB URI", pat: /mongodb(?:\+srv)?:\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/, hc: true },
  { name: "Private Key", pat: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, hc: true },
  { name: "Bearer Token", pat: /[Bb]earer\s+[a-zA-Z0-9\-._~+/]+=*/, hc: false },
  { name: "Secret Assign", pat: /(?:secret|token|password|passwd|pwd)['"\s:=]+['"]?[a-zA-Z0-9\-._!@#$%^&*]{8,}['"]?/i, hc: false },
  { name: "API Key Assign", pat: /(?:api[_-]?key|apikey|api[_-]?secret)['"\s:=]+['"]?[a-zA-Z0-9\-._]{20,}['"]?/i, hc: false },
];

// ─── Detector ────────────────────────────────────────────────────────────────

function detectSecrets(content: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  // Pattern pass
  for (const sp of PATS) {
    if (content.length < 8) continue;
    for (const m of content.matchAll(new RegExp(sp.pat.source, sp.pat.flags + "g"))) {
      const t = m[0]; if (!t) continue;
      if (!sp.hc && isSafe(t)) continue;
      if (!sp.hc) { const cx = content.slice(Math.max(0, m.index! - 10), m.index! + t.length); if (isSafe(cx)) continue; }
      const k = `${m.index}-${t.length}`; if (seen.has(k)) continue; seen.add(k);
      names.push(sp.name);
    }
  }

  // Entropy pass
  const tokens = content.split(/[\s\[\]{}"',\/\\|()&#@!<>?]+/);
  for (const tok of tokens) {
    if (tok.length < MINLEN) continue;
    if (isSafe(tok)) continue;
    if (/^\\\\[xuUdDsSwWbB]|^\^\\\\[xuUdD]/.test(tok)) continue;
    if (calcEntropy(tok) <= THR) continue;
    if (seen.has(tok)) continue; seen.add(tok);
    names.push("High Entropy");
  }
  return names;
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("Positive — Pattern Layer (known prefixes)", () => {
  const cases: [string, string, string[]][] = [
    ["AWS Access Key ID", "key=AKIAIOSFODNN7EXAMPLE", ["AWS Key"]],
    ["GitHub PAT", "token=ghp_123456789012345678901234567890123456", ["GitHub PAT", "Secret Assign"]],
    ["GitLab PAT", "glpat-abcdefghijklmnopqrstuvwx", ["GitLab PAT"]],
    ["Slack Token", ["xox", "b-1234567890-abcdefghijklmnopqrstuvwx"].join(""), ["Slack Token"]],
    ["OpenAI sk-proj key", "sk-proj-4ViCOyPjHxT7nWqRsKmBpLd8Xabc123def456ghi789jkl012mno345", ["OpenAI key"]],
    ["Volcengine Ark key", "ark-4ViCOyPjHxT7nWqRsKmBpLd8X12345", ["Volcengine Ark"]],
    ["Stripe test key", "sk_test_12345678901234567890123456", ["Stripe key"]],
    ["Google API Key", "AIzaSyA1234567890abcdefghijklmnopqrstuvxyzABCD", ["Google API Key"]],
    ["JWT", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789jkl012", ["JWT"]],
    ["PostgreSQL URI", "postgres://admin:S3cret@db.host.com:5432/prod", ["PostgreSQL URI"]],
    ["MongoDB URI", "mongodb://admin:pass123@cluster0.example.mongodb.net/db", ["MongoDB URI"]],
    ["RSA Private Key", "-----BEGIN RSA PRIVATE KEY-----", ["Private Key"]],
    ["Password assignment", "password=MyS3cretPass123", ["Secret Assign"]],
    ["API Key assignment", "api_key=QUJDREVGR0hJSktMTU5PUFFSU1RVVldY", ["API Key Assign"]],
  ];

  for (const [label, input, expected] of cases) {
    it(label, () => {
      const hits = detectSecrets(input);
      expect(hits.length).toBeGreaterThan(0);
      for (const e of expected) expect(hits).toContain(e);
    });
  }
});

describe("Positive — Entropy Layer (no known prefix)", () => {
  const cases: [string, string][] = [
    // Random mixed-case string (pure entropy, no pattern prefix)
    ["Random mixed-case", "aB3xK9mPqR7wN4ZfGhJkLmNpQrStUv"],
    ["Random mixed-case 2", "Xk9zQw2RmN5YhV8Bp3LqA6tSfEj7U4gD"],
    // Random hex string (not SHA/UUID — 40 random hex chars)
    ["Random hex (40 chars)", "A1b2C3d4E5f6A7b8C9d0E1f2A3b4C5d6E7f8"],
    // Random Base64 string (no api_key= prefix, pure entropy detection)
    ["Random Base64", "cGFzc3dvcmQxMjM0NTY3ODkwYWJjZGVmZ2hpamtsbW5vcA"],
    // Custom third-party prefix (not in pattern database)
    ["Custom prefix ak-", "ak-4ViCOyPjHxT7nWqRsKmBpLd8X12345"],
    ["Custom prefix key_", "key_aB3xK9mPqR7wN4ZfGhJkLmNpQrStUvXyZ"],
    // Dot-separated tokens (like session tokens)
    // Underscore-separated token
    ["Underscore-separated", "aBc_123_XyZ_789_QwE_456_RtY"],
    // SendGrid style (SG. prefix with dots — no pattern context)
    ["SendGrid-like token", "SG.aBcDeFgHiJkLmNoPqRsTuVwXyZ.ABCDEFGHIJKLMNOPQRSTUVWXYZabc"],
  ];

  for (const [label, input] of cases) {
    it(label, () => {
      const hits = detectSecrets(input);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits).toContain("High Entropy");
    });
  }
});

describe("Negative — safe formats", () => {
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
    ["IPv4:port", "192.168.1.100:8080"],
    ["Config env var", "DB_HOST=${ENV}"],
    ["HTML entity", "&amp;lt;gt;"],
    ["CSS hex color", "background: #ff6600"],
    ["Docker compose ports", "ports:\n  - '3000:3000'"],
  ];

  for (const [label, input] of cases) {
    it(label, () => {
      expect(detectSecrets(input)).toHaveLength(0);
    });
  }
});

describe("Negative — source code identifiers (V2 false positives)", () => {
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

describe("Negative — Ollama model IDs", () => {
  const models = [
    "gemma3:12b", "devstral-small-2:24b", "gpt-oss:120b",
    "ministral-3:14b", "nemotron-3-nano:30b", "qwen3-next:80b",
  ];

  for (const m of models) {
    it(m, () => {
      // Simulated JSON context
      expect(detectSecrets(`{ id: "${m}", name: "${m}" }`)).toHaveLength(0);
    });
  }
});

describe("Negative — CJK text", () => {
  it("Chinese text", () => {
    expect(detectSecrets("这是中文文本包含密码和密钥但不是secret")).toHaveLength(0);
  });
  it("Japanese text", () => {
    expect(detectSecrets("設定ファイルにAPI鍵を配置しないでください")).toHaveLength(0);
  });
});

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
        const hits = detectSecrets(body).filter(h => h === "High Entropy");
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