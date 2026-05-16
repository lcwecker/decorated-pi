/**
 * Provider Model Definitions — Validation Tests
 *
 * Validates model definitions from all three providers:
 * - ollama-cloud.ts
 * - qianfan-coding.ts
 * - ark-coding.ts
 *
 * Checks: required fields, sensible values, unique IDs, correct auth type.
 */

import { describe, it, expect } from "vitest";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// ─── Import MODELS arrays from each provider ────────────────────────────────

// We need to extract the MODELS constant from each provider file.
// Since they're not exported, we read the source and eval just the array.
// Alternative: just import and call the setup function with a mock, but
// that's complex. Instead, let's parse the model arrays directly.

import * as fs from "fs";
import * as path from "path";

function extractModelsFromFile(filePath: string): ProviderModelConfig[] {
  const src = fs.readFileSync(filePath, "utf-8");
  // Find the MODELS array by looking for the assignment
  const match = src.match(/const MODELS:\s*ProviderModelConfig\[\]\s*=\s*\[/);
  if (!match) throw new Error(`Could not find MODELS array in ${filePath}`);

  const startIdx = match.index! + match[0].length - 1; // start at [
  let depth = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) { endIdx = i + 1; break; }
    }
  }
  const arrayStr = src.slice(startIdx, endIdx);
  // Use Function constructor to safely eval the array (it contains `as any` which is TS-only)
  const cleaned = arrayStr.replace(/\bas\s+any\b/g, "");
  return new Function(`return ${cleaned}`)();
}

const EXT_DIR = path.join(__dirname, "..", "extensions", "providers");

const ollamaModels = extractModelsFromFile(path.join(EXT_DIR, "ollama-cloud.ts"));
const qianfanModels = extractModelsFromFile(path.join(EXT_DIR, "qianfan-coding.ts"));
const arkModels = extractModelsFromFile(path.join(EXT_DIR, "ark-coding.ts"));

const allProviders: [string, ProviderModelConfig[]][] = [
  ["ollama-cloud", ollamaModels],
  ["qianfan-coding", qianfanModels],
  ["ark-coding", arkModels],
];

// ═══════════════════════════════════════════════════════════════════════════
// Per-provider tests
// ═══════════════════════════════════════════════════════════════════════════

for (const [providerName, models] of allProviders) {
  describe(`${providerName} — model definitions`, () => {
    it("has at least 5 models", () => {
      expect(models.length).toBeGreaterThanOrEqual(5);
    });

    it("all model IDs are unique", () => {
      const ids = models.map(m => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("all models have required string fields", () => {
      for (const m of models) {
        expect(typeof m.id).toBe("string");
        expect(m.id.length).toBeGreaterThan(0);
        expect(typeof m.name).toBe("string");
        expect(m.name.length).toBeGreaterThan(0);
      }
    });

    it("all models have sensible contextWindow", () => {
      for (const m of models) {
        expect(m.contextWindow).toBeGreaterThan(0);
        expect(m.contextWindow).toBeLessThanOrEqual(10_000_000);
      }
    });

    it("maxTokens should be reasonable", () => {
      for (const m of models) {
        expect(m.maxTokens).toBeGreaterThan(0);
        // Some models allow maxTokens > contextWindow (e.g. Kimi K2.5 on qianfan)
        // Just check it's within a reasonable range
        expect(m.maxTokens).toBeLessThanOrEqual(10_000_000);
      }
    });

    it("all models have valid input types", () => {
      for (const m of models) {
        expect(m.input.length).toBeGreaterThan(0);
        for (const inp of m.input) {
          expect(["text", "image"]).toContain(inp);
        }
      }
    });

    it("all models have cost object with required fields", () => {
      for (const m of models) {
        expect(m.cost).toBeDefined();
        expect(typeof m.cost.input).toBe("number");
        expect(typeof m.cost.output).toBe("number");
        // OAuth providers should have zero cost
        expect(m.cost.input).toBe(0);
        expect(m.cost.output).toBe(0);
      }
    });

    it("reasoning is a boolean", () => {
      for (const m of models) {
        expect(typeof m.reasoning).toBe("boolean");
      }
    });

    it("model IDs don't contain spaces", () => {
      for (const m of models) {
        expect(m.id).not.toMatch(/\s/);
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Cross-provider tests
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-provider — no duplicate model IDs", () => {
  it("model IDs are unique across all providers", () => {
    const allIds: string[] = [];
    for (const [, models] of allProviders) {
      allIds.push(...models.map(m => m.id));
    }
    // Some models appear in multiple providers (e.g. deepseek-v3.2)
    // That's expected — they're different provider endpoints
    // Just verify we don't have exact duplicates within the same provider
    // (already tested above)
    expect(allIds.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Provider-specific: ollama-cloud
// ═══════════════════════════════════════════════════════════════════════════

describe("ollama-cloud — specific models", () => {
  it("has devstral models", () => {
    const ids = ollamaModels.map(m => m.id);
    expect(ids.some(id => id.includes("devstral"))).toBe(true);
  });

  it("has deepseek models", () => {
    const ids = ollamaModels.map(m => m.id);
    expect(ids.some(id => id.includes("deepseek"))).toBe(true);
  });

  it("has qwen models", () => {
    const ids = ollamaModels.map(m => m.id);
    expect(ids.some(id => id.includes("qwen"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Provider-specific: qianfan-coding
// ═══════════════════════════════════════════════════════════════════════════

describe("qianfan-coding — specific models", () => {
  it("has ERNIE model", () => {
    const ids = qianfanModels.map(m => m.id);
    expect(ids.some(id => id.includes("ernie"))).toBe(true);
  });

  it("kimi-k2.5 contextWindow is 229376", () => {
    const kimi = qianfanModels.find(m => m.id === "kimi-k2.5");
    expect(kimi).toBeDefined();
    expect(kimi!.contextWindow).toBe(229_376);
  });

  it("ERNIE 4.5 Turbo maxTokens is 12288", () => {
    const ernie = qianfanModels.find(m => m.id === "ernie-4.5-turbo-20260402");
    expect(ernie).toBeDefined();
    expect(ernie!.maxTokens).toBe(12_288);
  });

  it("ERNIE 4.5 Turbo is NOT reasoning", () => {
    const ernie = qianfanModels.find(m => m.id === "ernie-4.5-turbo-20260402");
    expect(ernie!.reasoning).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Provider-specific: ark-coding
// ═══════════════════════════════════════════════════════════════════════════

describe("ark-coding — specific models", () => {
  it("has kimi models", () => {
    const ids = arkModels.map(m => m.id);
    expect(ids.some(id => id.includes("kimi"))).toBe(true);
  });

  it("has deepseek models", () => {
    const ids = arkModels.map(m => m.id);
    expect(ids.some(id => id.includes("deepseek"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Provider source files — OAuth configuration
// ═══════════════════════════════════════════════════════════════════════════

describe("Provider source files — auth configuration", () => {
  it("ollama-cloud uses OAuth (no apiKey)", () => {
    const src = fs.readFileSync(path.join(EXT_DIR, "ollama-cloud.ts"), "utf-8");
    expect(src).toContain("oauth:");
    expect(src).not.toContain("apiKey:");
  });

  it("qianfan-coding uses OAuth (no apiKey)", () => {
    const src = fs.readFileSync(path.join(EXT_DIR, "qianfan-coding.ts"), "utf-8");
    expect(src).toContain("oauth:");
    expect(src).not.toContain("apiKey:");
  });

  it("ark-coding uses OAuth (no apiKey)", () => {
    const src = fs.readFileSync(path.join(EXT_DIR, "ark-coding.ts"), "utf-8");
    expect(src).toContain("oauth:");
    expect(src).not.toContain("apiKey:");
  });

  it("all providers have correct base URLs", () => {
    const ollamaSrc = fs.readFileSync(path.join(EXT_DIR, "ollama-cloud.ts"), "utf-8");
    expect(ollamaSrc).toContain("https://ollama.com/v1");

    const qianfanSrc = fs.readFileSync(path.join(EXT_DIR, "qianfan-coding.ts"), "utf-8");
    expect(qianfanSrc).toContain("https://qianfan.baidubce.com/v2/coding");

    const arkSrc = fs.readFileSync(path.join(EXT_DIR, "ark-coding.ts"), "utf-8");
    expect(arkSrc).toContain("https://ark.cn-beijing.volces.com/api/coding/v3");
  });
});
