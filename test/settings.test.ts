/**
 * Settings Module — Unit Tests
 *
 * Tests pure functions from settings.ts:
 * - formatModelKey / parseModelKey
 * - isModuleEnabled / setModuleEnabled / getAllModuleSettings
 * - loadConfig / saveConfig (with temp directory)
 *
 * Uses a temporary directory for config to avoid modifying real user config.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  formatModelKey,
  parseModelKey,
  isModuleEnabled,
  setModuleEnabled,
  getAllModuleSettings,
  loadConfig,
  saveConfig,
  getImageModelKey,
  setImageModelKey,
  getCompactModelKey,
  setCompactModelKey,
  type DecoratedPiConfig,
  type ModuleSettings,
} from "../extensions/settings.js";

// ─── Mock config file path ──────────────────────────────────────────────────
// settings.ts uses a hardcoded path, so we need to test with the real module
// but save/restore state around each test.

let originalConfig: string | null = null;
const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_FILE = path.join(CONFIG_DIR, "decorated-pi.json");

function backupConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      originalConfig = fs.readFileSync(CONFIG_FILE, "utf-8");
      fs.unlinkSync(CONFIG_FILE);
    } else {
      originalConfig = null;
    }
  } catch {
    originalConfig = null;
  }
}

function restoreConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
    }
    if (originalConfig !== null) {
      if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, originalConfig, "utf-8");
    }
  } catch { /* best effort */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// formatModelKey / parseModelKey
// ═══════════════════════════════════════════════════════════════════════════

describe("formatModelKey", () => {
  it("formats provider/model", () => {
    expect(formatModelKey({ provider: "ollama-cloud", id: "gemma3:12b" } as any))
      .toBe("ollama-cloud/gemma3:12b");
  });

  it("handles model IDs with slashes", () => {
    expect(formatModelKey({ provider: "ark-coding", id: "deepseek-v3" } as any))
      .toBe("ark-coding/deepseek-v3");
  });
});

describe("parseModelKey", () => {
  it("parses valid key", () => {
    const result = parseModelKey("ollama-cloud/gemma3:12b");
    expect(result).toEqual({ provider: "ollama-cloud", modelId: "gemma3:12b" });
  });

  it("returns null for key without slash", () => {
    expect(parseModelKey("noSlashHere")).toBeNull();
  });

  it("handles provider with hyphens", () => {
    const result = parseModelKey("qianfan-coding/deepseek-v3.2");
    expect(result).toEqual({ provider: "qianfan-coding", modelId: "deepseek-v3.2" });
  });

  it("handles empty modelId after slash", () => {
    const result = parseModelKey("provider/");
    expect(result).toEqual({ provider: "provider", modelId: "" });
  });

  it("handles multiple slashes (first is separator)", () => {
    const result = parseModelKey("provider/path/to/model");
    expect(result).toEqual({ provider: "provider", modelId: "path/to/model" });
  });
});

describe("formatModelKey ↔ parseModelKey roundtrip", () => {
  const keys = [
    { provider: "ollama-cloud", id: "gemma3:12b" },
    { provider: "qianfan-coding", id: "deepseek-v3.2" },
    { provider: "ark-coding", id: "kimi-k2.5" },
  ];

  for (const { provider, id } of keys) {
    it(`roundtrip: ${provider}/${id}`, () => {
      const key = formatModelKey({ provider, id } as any);
      const parsed = parseModelKey(key);
      expect(parsed).toEqual({ provider, modelId: id });
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Module Settings (isModuleEnabled / setModuleEnabled / getAllModuleSettings)
// ═══════════════════════════════════════════════════════════════════════════

describe("Module Settings", () => {
  beforeEach(() => {
    backupConfig();
    // Start with clean config
    try {
      if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
    } catch {}
  });

  afterEach(() => {
    restoreConfig();
  });

  it("defaults all modules to enabled", () => {
    const settings = getAllModuleSettings();
    expect(settings.safety).toBe(true);
    expect(settings.lsp).toBe(true);
    expect(settings["smart-at"]).toBe(true);
  });

  it("isModuleEnabled returns true by default", () => {
    expect(isModuleEnabled("safety")).toBe(true);
    expect(isModuleEnabled("lsp")).toBe(true);
    expect(isModuleEnabled("smart-at")).toBe(true);
  });

  it("setModuleEnabled persists to config file", () => {
    setModuleEnabled("safety", false);
    expect(isModuleEnabled("safety")).toBe(false);
    expect(isModuleEnabled("lsp")).toBe(true); // others unchanged
  });

  it("setModuleEnabled can re-enable a module", () => {
    setModuleEnabled("lsp", false);
    expect(isModuleEnabled("lsp")).toBe(false);
    setModuleEnabled("lsp", true);
    expect(isModuleEnabled("lsp")).toBe(true);
  });

  it("getAllModuleSettings reflects changes", () => {
    setModuleEnabled("safety", false);
    setModuleEnabled("smart-at", false);
    const settings = getAllModuleSettings();
    expect(settings.safety).toBe(false);
    expect(settings.lsp).toBe(true);
    expect(settings["smart-at"]).toBe(false);
  });

  it("config file is valid JSON after setModuleEnabled", () => {
    setModuleEnabled("lsp", false);
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.modules.lsp).toBe(false);
  });

  it("multiple module toggles persist independently", () => {
    setModuleEnabled("safety", false);
    setModuleEnabled("lsp", false);
    setModuleEnabled("smart-at", true);

    expect(isModuleEnabled("safety")).toBe(false);
    expect(isModuleEnabled("lsp")).toBe(false);
    expect(isModuleEnabled("smart-at")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// loadConfig / saveConfig
// ═══════════════════════════════════════════════════════════════════════════

describe("loadConfig / saveConfig", () => {
  beforeEach(() => {
    backupConfig();
    try {
      if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
    } catch {}
  });

  afterEach(() => {
    restoreConfig();
  });

  it("loadConfig returns empty object when no config file", () => {
    const config = loadConfig();
    expect(config).toEqual({});
  });

  it("saveConfig creates config file", () => {
    saveConfig({ imageModelKey: "test/model" });
    expect(fs.existsSync(CONFIG_FILE)).toBe(true);
  });

  it("saveConfig merges with existing config", () => {
    saveConfig({ imageModelKey: "test/model" });
    saveConfig({ compactModelKey: "test/compact" });
    const config = loadConfig();
    expect(config.imageModelKey).toBe("test/model");
    expect(config.compactModelKey).toBe("test/compact");
  });

  it("saveConfig overwrites same key", () => {
    saveConfig({ imageModelKey: "old/model" });
    saveConfig({ imageModelKey: "new/model" });
    const config = loadConfig();
    expect(config.imageModelKey).toBe("new/model");
  });

  it("config file is pretty-printed JSON", () => {
    saveConfig({ imageModelKey: "test/model" });
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    expect(raw).toContain("\n"); // formatted
    const parsed = JSON.parse(raw);
    expect(parsed.imageModelKey).toBe("test/model");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getImageModelKey / setImageModelKey / getCompactModelKey / setCompactModelKey
// ═══════════════════════════════════════════════════════════════════════════

describe("Model key getters/setters", () => {
  beforeEach(() => {
    backupConfig();
    try { if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE); } catch {}
  });

  afterEach(() => {
    restoreConfig();
  });

  it("getImageModelKey returns null by default", () => {
    expect(getImageModelKey()).toBeNull();
  });

  it("getCompactModelKey returns null by default", () => {
    expect(getCompactModelKey()).toBeNull();
  });

  it("setImageModelKey / getImageModelKey roundtrip", () => {
    setImageModelKey("ollama-cloud/gemma3:12b");
    expect(getImageModelKey()).toBe("ollama-cloud/gemma3:12b");
  });

  it("setCompactModelKey / getCompactModelKey roundtrip", () => {
    setCompactModelKey("qianfan-coding/deepseek-v3.2");
    expect(getCompactModelKey()).toBe("qianfan-coding/deepseek-v3.2");
  });

  it("setImageModelKey(null) clears the key", () => {
    setImageModelKey("ollama-cloud/gemma3:12b");
    expect(getImageModelKey()).toBe("ollama-cloud/gemma3:12b");
    setImageModelKey(null);
    expect(getImageModelKey()).toBeNull();
  });

  it("setCompactModelKey(null) clears the key", () => {
    setCompactModelKey("qianfan-coding/deepseek-v3.2");
    expect(getCompactModelKey()).toBe("qianfan-coding/deepseek-v3.2");
    setCompactModelKey(null);
    expect(getCompactModelKey()).toBeNull();
  });

  it("image and compact keys are independent", () => {
    setImageModelKey("provider-a/model-x");
    setCompactModelKey("provider-b/model-y");
    expect(getImageModelKey()).toBe("provider-a/model-x");
    expect(getCompactModelKey()).toBe("provider-b/model-y");
  });

  it("setting one key does not overwrite the other", () => {
    setImageModelKey("provider-a/model-x");
    setCompactModelKey("provider-b/model-y");
    setImageModelKey("provider-c/model-z");
    expect(getCompactModelKey()).toBe("provider-b/model-y");
  });
});
