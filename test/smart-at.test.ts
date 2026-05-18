import { describe, it, expect } from "vitest";
import { __smartAtTest } from "../extensions/smart-at.js";

const { computePenaltyMeta, computePenalty, fuzzyScore, computeMatchScore, smartSearch, atPrefix } = __smartAtTest;

// ═══════════════════════════════════════════════════════════
// 惩罚分级
// ═══════════════════════════════════════════════════════════

describe("penalty tiers", () => {
  it("Tier 1: gitIgnored wins, no stacking", () => {
    const meta = computePenaltyMeta("dist/foo.pyc", false, true);
    expect(meta.tier).toBe(1);
    expect(meta.penalty).toBe(-400 - (2 * 20) - 7); // -447
  });

  it("Tier 2: hidden dir", () => {
    const meta = computePenaltyMeta(".cache/data.json", false, false);
    expect(meta.tier).toBe(2);
    expect(meta.penalty).toBe(-300 - (2 * 20) - 9); // -349
  });

  it("Tier 3: bad dir", () => {
    const meta = computePenaltyMeta("dist/index.ts", false, false);
    expect(meta.tier).toBe(3);
    expect(meta.penalty).toBe(-200 - (2 * 20) - 8); // -248
  });

  it("Tier 4: bad extension", () => {
    const meta = computePenaltyMeta("images/logo.png", false, false);
    expect(meta.tier).toBe(4);
    expect(meta.penalty).toBe(-100 - (2 * 20) - 8); // -148
  });

  it("Tier 0: normal source file", () => {
    const meta = computePenaltyMeta("src/new-file.ts", false, false);
    expect(meta.tier).toBe(0);
    expect(meta.penalty).toBe(-(2 * 20) - 11); // -51
  });

  it("root dotfiles are NOT penalized as hidden dir", () => {
    const meta = computePenaltyMeta(".eslintrc.js", false, false);
    expect(meta.tier).toBe(0);
    expect(meta.penalty).toBe(-(1 * 20) - 12); // -32
  });

  it("directory itself as hidden dir gets Tier 2", () => {
    const meta = computePenaltyMeta(".cache", true, false);
    expect(meta.tier).toBe(2);
  });

  it("computePenalty helper returns number", () => {
    expect(computePenalty("src/a.ts", false, false)).toBe(-(2 * 20) - 4); // -44
  });
});

// ═══════════════════════════════════════════════════════════
// 匹配评分(大小写敏感)
// ═══════════════════════════════════════════════════════════

describe("match scoring (case-sensitive)", () => {
  it("fuzzyScore returns 0 when no match", () => {
    expect(fuzzyScore("index.ts", "zzz")).toBe(0);
  });

  it("case mismatch reduces to fuzzy or zero", () => {
    const upper = computeMatchScore({ path: "src/Index.ts", name: "Index.ts", isDir: false, tier: 0 as const, penalty: 0 }, "index");
    const exact = computeMatchScore({ path: "src/index.ts", name: "index.ts", isDir: false, tier: 0 as const, penalty: 0 }, "index");
    expect(exact).toBeGreaterThan(upper);
  });

  it("exact stem beats prefix", () => {
    const exact = computeMatchScore({ path: "src/index.ts", name: "index.ts", isDir: false, tier: 0 as const, penalty: 0 }, "index");
    const prefix = computeMatchScore({ path: "src/indexer.ts", name: "indexer.ts", isDir: false, tier: 0 as const, penalty: 0 }, "index");
    expect(exact).toBeGreaterThan(prefix);
  });

  it("directory gets +500 bonus", () => {
    const dir = computeMatchScore({ path: "src/utils/", name: "utils", isDir: true, tier: 0 as const, penalty: 0 }, "utils");
    const file = computeMatchScore({ path: "src/utils.ts", name: "utils.ts", isDir: false, tier: 0 as const, penalty: 0 }, "utils");
    expect(dir).toBeGreaterThan(file);
  });

  it("parent dir match adds bonus", () => {
    const withDir = computeMatchScore({ path: "button/index.ts", name: "index.ts", isDir: false, tier: 0 as const, penalty: 0 }, "button");
    const noDir = computeMatchScore({ path: "src/index.ts", name: "index.ts", isDir: false, tier: 0 as const, penalty: 0 }, "button");
    expect(withDir).toBeGreaterThan(noDir);
  });
});

// ═══════════════════════════════════════════════════════════
// 搜索行为
// ═══════════════════════════════════════════════════════════

describe("smartSearch", () => {
  const candidates = [
    { path: "src/index.ts", name: "index.ts", isDir: false, tier: 0 as const, penalty: -48 },
    { path: "src/", name: "src", isDir: true, tier: 0 as const, penalty: -23 },
    { path: "dist/index.js", name: "index.js", isDir: false, tier: 3 as const, penalty: -248 },
    { path: ".cache/index.json", name: "index.json", isDir: false, tier: 2 as const, penalty: -349 },
    { path: "ignored.log", name: "ignored.log", isDir: false, tier: 1 as const, penalty: -431 },
    { path: "build/", name: "build", isDir: true, tier: 3 as const, penalty: -225 },
  ];

  it("empty query: hides Tier 1/2, shows Tier 0/3/4", () => {
    const results = smartSearch(candidates, "");
    expect(results).toContain("src/index.ts");
    expect(results).toContain("src/");
    expect(results).toContain("dist/index.js");
    expect(results).toContain("build/");
    expect(results).not.toContain(".cache/index.json");
    expect(results).not.toContain("ignored.log");
  });

  it("empty query: directories come first", () => {
    const results = smartSearch(candidates, "");
    const firstFile = results.findIndex(r => !r.endsWith("/"));
    const lastDir = results.reduce((acc, r, i) => r.endsWith("/") ? i : acc, -1);
    expect(lastDir).toBeLessThan(firstFile);
  });

  it("explicit query surfaces penalized files", () => {
    const results = smartSearch(candidates, "index");
    expect(results).toContain("dist/index.js");
    expect(results).toContain(".cache/index.json");
    expect(results[0]).toBe("src/index.ts");
  });

  it("case-sensitive: 'Index' does not match 'index'", () => {
    const results = smartSearch(candidates, "Index");
    // 'index.ts' stem is 'index', not 'Index' → only fuzzy match
    expect(results.length).toBe(0);
  });

  it("multi-token returns union", () => {
    const results = smartSearch(candidates, "index build");
    expect(results).toContain("src/index.ts");
    expect(results).toContain("build/");
  });
});

// ═══════════════════════════════════════════════════════════
// @ 前缀检测
// ═══════════════════════════════════════════════════════════

describe("@ prefix detection", () => {
  it("line start", () => {
    expect(atPrefix("@src/ind")).toBe("@src/ind");
  });

  it("after space", () => {
    expect(atPrefix("read @src/ind")).toBe("@src/ind");
  });

  it("email-like text does not trigger", () => {
    expect(atPrefix("user@example.com")).toBeNull();
  });
});
