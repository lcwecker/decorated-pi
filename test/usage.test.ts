/**
 * Usage Aggregation — Unit Tests
 *
 * Pure-function tests for commands/usage.ts:
 *   - formatTokens / formatCost / formatHitRate
 *   - pickColumns
 *   - aggregate
 *   - formatCell
 *   - pickModelDisplay
 */

import { describe, it, expect } from "vitest";
import {
  formatTokens,
  formatCost,
  formatHitRate,
  pickColumns,
  aggregate,
  formatCell,
  formatRow,
  pickModelDisplay,
  type Aggregate,
  type ColumnId,
} from "../commands/usage.js";

// ─── formatTokens ───────────────────────────────────────────────────────────

describe("formatTokens", () => {
  it("returns '—' for zero", () => {
    expect(formatTokens(0)).toBe("—");
  });

  it("returns raw number for small values", () => {
    expect(formatTokens(12)).toBe("12");
    expect(formatTokens(800)).toBe("800");
  });

  it("formats with 'k' suffix (1 decimal)", () => {
    expect(formatTokens(1_200)).toBe("1.2k");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(99_900)).toBe("99.9k");
  });

  it("formats with 'k' suffix (no decimal when >=100k)", () => {
    expect(formatTokens(100_000)).toBe("100k");
    expect(formatTokens(512_000)).toBe("512k");
  });

  it("formats with 'M' suffix (2 decimals)", () => {
    expect(formatTokens(1_200_000)).toBe("1.20M");
    expect(formatTokens(8_420_000)).toBe("8.42M");
    expect(formatTokens(23_100_000)).toBe("23.10M");
  });

  it("formats with 'M' suffix (no decimal when >=100M)", () => {
    expect(formatTokens(100_000_000)).toBe("100M");
  });
});

// ─── formatCost ─────────────────────────────────────────────────────────────

describe("formatCost", () => {
  it("returns '—' for zero", () => {
    expect(formatCost(0)).toBe("—");
  });

  it("shows '<$0.01' for very small values", () => {
    expect(formatCost(0.005)).toBe("<$0.01");
  });

  it("formats with 2 decimal places", () => {
    expect(formatCost(0.07)).toBe("$0.07");
    expect(formatCost(44.12)).toBe("$44.12");
  });

  it("formats with 'k' suffix", () => {
    expect(formatCost(1_200)).toBe("$1.2k");
    expect(formatCost(2_610)).toBe("$2.6k");
  });
});

// ─── formatHitRate ─────────────────────────────────────────────────────────

describe("formatHitRate", () => {
  it("returns '—' when no turns", () => {
    expect(formatHitRate(77, 0)).toBe("—");
  });

  it("returns percentage string when turns > 0", () => {
    expect(formatHitRate(77, 10)).toBe("77%");
    expect(formatHitRate(0, 1)).toBe("0%");
  });
});

// ─── pickColumns ────────────────────────────────────────────────────────────

describe("pickColumns", () => {
  it("returns 6 cols for width >= 80", () => {
    const got = pickColumns(80);
    expect(got).toHaveLength(6);
    expect(got).toContain("cacheRead");
    expect(got).toContain("cacheWrite");
  });

  it("returns 4 cols for 50 <= width < 80", () => {
    const got = pickColumns(50);
    expect(got).toHaveLength(4);
    expect(got).toContain("input");
    expect(got).toContain("output");
    expect(got).toContain("hitRate");
    expect(got).toContain("cost");
    expect(got).not.toContain("cacheRead");
    expect(got).not.toContain("cacheWrite");
  });

  it("returns 2 cols for width < 50", () => {
    const got = pickColumns(30);
    expect(got).toHaveLength(2);
    expect(got).toEqual(["hitRate", "cost"]);
  });
});

// ─── formatCell ─────────────────────────────────────────────────────────────

describe("formatCell", () => {
  const agg: Aggregate = {
    input: 12_400,
    output: 800,
    cacheRead: 41_200,
    cacheWrite: 0,
    cost: 0.07,
    turns: 1,
    hitRate: 77,
  };

  it("formats input as total prompt (input + cacheRead + cacheWrite)", () => {
    expect(formatCell("input", agg)).toBe("53.6k"); // 12.4k + 41.2k + 0
  });

  it("includes cacheWrite in total prompt", () => {
    const withW: Aggregate = { ...agg, cacheWrite: 12_300 };
    expect(formatCell("input", withW)).toBe("65.9k"); // 12.4k + 41.2k + 12.3k
  });

  it("formats output", () => {
    expect(formatCell("output", agg)).toBe("800");
  });

  it("formats cacheRead", () => {
    expect(formatCell("cacheRead", agg)).toBe("41.2k");
  });

  it("formats cacheWrite", () => {
    expect(formatCell("cacheWrite", agg)).toBe("—");
  });

  it("formats hitRate", () => {
    expect(formatCell("hitRate", agg)).toBe("77%");
  });

  it("formats cost", () => {
    expect(formatCell("cost", agg)).toBe("$0.07");
  });

  it("returns '—' for hitRate with zero turns", () => {
    const empty: Aggregate = { ...agg, turns: 0, hitRate: 0 };
    expect(formatCell("hitRate", empty)).toBe("—");
  });
});

// ─── pickModelDisplay ───────────────────────────────────────────────────────

describe("pickModelDisplay", () => {
  it("returns full name if short enough", () => {
    expect(pickModelDisplay("anthropic/claude-sonnet-4", 30)).toBe("anthropic/claude-sonnet-4");
  });

  it("truncates with ellipsis", () => {
    expect(pickModelDisplay("anthropic/claude-sonnet-4", 10)).toBe("anthropic…");
  });

  it("handles exactly maxLen", () => {
    expect(pickModelDisplay("abc", 3)).toBe("abc");
  });

  it("handles very short maxLen", () => {
    expect(pickModelDisplay("abc", 1)).toBe("a");
  });
});

// ─── formatRow ──────────────────────────────────────────────────────────────

describe("formatRow", () => {
  const agg: Aggregate = {
    input: 1000,
    output: 200,
    cacheRead: 500,
    cacheWrite: 300,
    cost: 0.05,
    turns: 1,
    hitRate: 28,
  };
  const cols: ColumnId[] = ["input", "output", "hitRate", "cost"];
  const colWidths: Record<ColumnId, number> = { input: 6, output: 5, hitRate: 5, cost: 6 };

  it("pads label and aligns columns", () => {
    const row = formatRow("Today", 10, agg, cols, colWidths);
    expect(row).toContain("Today");
    expect(row).toContain("1.8k"); // 1000+500+300
    expect(row).toContain("200");
  });
});

// ─── aggregate ───────────────────────────────────────────────────────────────

describe("aggregate", () => {
  const mk = (overrides: Record<string, unknown> = {}) => ({
    ts: Date.now(),
    model: "test/m",
    sessionFile: "sessions/p/test.jsonl",
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    ...overrides,
  });

  it("returns empty report for no entries", () => {
    const report = aggregate([]);
    expect(report.allTime.turns).toBe(0);
    expect(report.currentSession.turns).toBe(0);
    expect(report.byModel).toHaveLength(0);
  });

  it("accumulates single entry across all periods", () => {
    const report = aggregate([mk({ input: 100, output: 50, cacheRead: 200, cacheWrite: 10, cost: 0.01 })]);
    expect(report.allTime.turns).toBe(1);
    expect(report.today.turns).toBe(1);
    expect(report.allTime.hitRate).toBe(65);
    expect(report.byModel).toHaveLength(1);
    expect(report.byModel[0]!.model).toBe("test/m");
  });

  it("filters currentSession when file matches", () => {
    const report = aggregate(
      [
        mk({ input: 100, sessionFile: "a.jsonl" }),
        mk({ input: 200, sessionFile: "b.jsonl" }),
      ],
      "a.jsonl",
    );
    expect(report.currentSession.input).toBe(100);
    expect(report.allTime.input).toBe(300);
  });

  it("currentSession is zero when no file matches", () => {
    const report = aggregate([mk({ input: 100 })], "nonexistent.jsonl");
    expect(report.currentSession.turns).toBe(0);
    expect(report.allTime.turns).toBe(1);
  });

  it("groups by model correctly", () => {
    const report = aggregate([
      mk({ model: "a/a", input: 100, cost: 1 }),
      mk({ model: "b/b", input: 200, cost: 3 }),
      mk({ model: "a/a", input: 300, cost: 2 }),
    ]);
    expect(report.byModel).toHaveLength(2);
    expect(report.byModel[0]!.model).toBe("a/a");
    expect(report.byModel[0]!.allTime.cost).toBe(3);
    expect(report.byModel[0]!.allTime.input).toBe(400);
    expect(report.byModel[1]!.model).toBe("b/b");
  });

  it("only includes entries in today if timestamp is after midnight", () => {
    const yesterday = Date.now() - 25 * 60 * 60 * 1000;
    const today = Date.now();
    const report = aggregate([
      mk({ ts: yesterday, model: "x/x", input: 100 }),
      mk({ ts: today, model: "y/y", input: 200 }),
    ]);
    expect(report.today.input).toBe(200);
    expect(report.allTime.input).toBe(300);
  });

  it("computes hitRate correctly", () => {
    const report = aggregate([mk({ input: 100, output: 50, cacheRead: 300 })]);
    expect(report.allTime.hitRate).toBe(75);
  });

  it("hitRate is 0 when denominator is 0", () => {
    const report = aggregate([mk()]);
    expect(report.allTime.hitRate).toBe(0);
  });

  it("sorts models by most recent usage, then alphabetically", () => {
    const base = Date.now();
    const report = aggregate([
      mk({ model: "b/b", ts: base - 2000 }),
      mk({ model: "a/a", ts: base - 1000 }),
      mk({ model: "c/c", ts: base }),
    ]);
    expect(report.byModel[0]!.model).toBe("c/c");
    expect(report.byModel[1]!.model).toBe("a/a");
    expect(report.byModel[2]!.model).toBe("b/b");
  });

  it("falls back to alphabetical when last-used is the same", () => {
    const ts = Date.now();
    const report = aggregate([
      mk({ model: "b/b", ts }),
      mk({ model: "a/a", ts }),
    ]);
    expect(report.byModel[0]!.model).toBe("a/a");
    expect(report.byModel[1]!.model).toBe("b/b");
  });
});
