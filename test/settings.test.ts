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
import { describe, it, expect, beforeEach } from "vitest";
import { agentDir, agentDirFile } from "./agent-dir.js";
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
  getDependencyPath,
  setDependencyPath,
  isDontBother,
  setDontBother,
  getDependencyView,
  resolveDependency,
  captureModuleSnapshot,
  moduleSnapshotChanged,
  type DecoratedPiConfig,
  type ModuleSettings,
} from "../settings.js";

// ─── Config file under test ─────────────────────────────────────────────────
// Every agent-dir path resolves through getAgentDir(), which the vitest
// setup file points at a per-spec temp directory.

const CONFIG_FILE = agentDirFile("decorated-pi.json");

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
    // Start with clean config
    try {
      if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
    } catch {}
  });

  it("defaults all modules to enabled", () => {
    const settings = getAllModuleSettings();
    expect(settings.tools.patchOverrideEdit).toBe(true);
    expect(settings.tools.ask).toBe(true);
    expect(settings.tools.lsp).toBe(true);
    expect(settings.commands.retry).toBe(true);
    expect(settings.commands.usage).toBe(true);
    expect(settings.hooks.tps).toBe(true);
  });

  it("does not expose codegraph as a module switch", () => {
    // codegraph is now just an MCP server, not a top-level module toggle.
    const settings = getAllModuleSettings();
    expect("codegraph" in settings.tools).toBe(false);
    expect("codegraph" in settings.hooks).toBe(false);
    expect("codegraph" in settings.commands).toBe(false);
  });

  it("isModuleEnabled returns true by default", () => {
    expect(isModuleEnabled("lsp")).toBe(true);
    expect(isModuleEnabled("retry")).toBe(true);
  });

  it("setModuleEnabled persists to config file", () => {
    setModuleEnabled("wakatime", false);
    expect(isModuleEnabled("wakatime")).toBe(false);
    expect(isModuleEnabled("lsp")).toBe(true); // others unchanged
  });

  it("setModuleEnabled can re-enable a module", () => {
    setModuleEnabled("lsp", false);
    expect(isModuleEnabled("lsp")).toBe(false);
    setModuleEnabled("lsp", true);
    expect(isModuleEnabled("lsp")).toBe(true);
  });

  it("getAllModuleSettings reflects changes", () => {
    setModuleEnabled("wakatime", false);
    setModuleEnabled("retry", false);
    const settings = getAllModuleSettings();
    expect(settings.hooks.wakatime).toBe(false);
    expect(settings.tools.lsp).toBe(true);
    expect(settings.commands.retry).toBe(false);
  });

  it("config file is valid JSON after setModuleEnabled", () => {
    setModuleEnabled("lsp", false);
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.modules.tools.lsp).toBe(false);
  });

  it("migrates legacy flat 'patch' key to nested tools.patchOverrideEdit", () => {
    saveConfig({ modules: { patch: false } as any });
    const config = loadConfig();
    expect(config.modules?.tools?.patchOverrideEdit).toBe(false);
    expect((config.modules as any)?.patch).toBeUndefined();
  });

  it("drops removed legacy flat redact settings", () => {
    saveConfig({ modules: { safety: false, secretRedaction: true } as any });
    const config = loadConfig();
    expect((config.modules as any)?.safety).toBeUndefined();
    expect((config.modules as any)?.secretRedaction).toBeUndefined();
  });

  it("migrates legacy inner names and drops removed redact settings", () => {
    saveConfig({ modules: { tools: { patch: false }, hooks: { safety: true, secretRedaction: false } } as any });
    const config = loadConfig();
    expect(config.modules?.tools?.patchOverrideEdit).toBe(false);
    expect((config.modules?.tools as any)?.patch).toBeUndefined();
    expect((config.modules?.hooks as any)?.safety).toBeUndefined();
    expect((config.modules?.hooks as any)?.secretRedaction).toBeUndefined();
  });

  it("does not overwrite new key when both legacy and new keys exist", () => {
    saveConfig({ modules: { patch: false, tools: { patchOverrideEdit: true } } as any });
    const config = loadConfig();
    expect(config.modules?.tools?.patchOverrideEdit).toBe(true);
    expect((config.modules as any)?.patch).toBeUndefined();
  });

  it("preserves already-correct nested config", () => {
    saveConfig({
      modules: {
        tools: { patchOverrideEdit: false, lsp: true },
        hooks: { wakatime: false },
        commands: {},
      },
    });
    const config = loadConfig();
    expect(config.modules?.tools?.patchOverrideEdit).toBe(false);
    expect(config.modules?.tools?.lsp).toBe(true);
    expect(config.modules?.hooks?.wakatime).toBe(false);
  });

  it("multiple module toggles persist independently", () => {
    setModuleEnabled("wakatime", false);
    setModuleEnabled("lsp", false);

    expect(isModuleEnabled("wakatime")).toBe(false);
    expect(isModuleEnabled("lsp")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// moduleSnapshot (used by /dp-settings to decide whether to prompt reload)
// ═══════════════════════════════════════════════════════════════════════════

describe("moduleSnapshot", () => {
  beforeEach(() => {
    try {
      if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
    } catch {}
  });

  it("moduleSnapshotChanged returns false after capture with no subsequent change", () => {
    captureModuleSnapshot();
    expect(moduleSnapshotChanged()).toBe(false);
  });

  it("moduleSnapshotChanged returns true after a module toggle", () => {
    captureModuleSnapshot();
    setModuleEnabled("mcp", !isModuleEnabled("mcp"));
    expect(moduleSnapshotChanged()).toBe(true);
  });

  it("moduleSnapshotChanged returns false when toggle is reverted to original", () => {
    const originalMcp = isModuleEnabled("mcp");
    captureModuleSnapshot();
    setModuleEnabled("mcp", !originalMcp);
    setModuleEnabled("mcp", originalMcp);
    expect(moduleSnapshotChanged()).toBe(false);
  });

  it("recapture picks up the current effective state as the new baseline", () => {
    captureModuleSnapshot();
    setModuleEnabled("mcp", !isModuleEnabled("mcp"));
    expect(moduleSnapshotChanged()).toBe(true);
    captureModuleSnapshot();
    expect(moduleSnapshotChanged()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// dependencies (binary path overrides)
// ═══════════════════════════════════════════════════════════════════════════

describe("dependencies", () => {
  beforeEach(() => {
    try {
      if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
    } catch {}
  });

  it("getDependencyPath returns null when not configured", () => {
    expect(getDependencyPath("depbin")).toBe(null);
  });

  it("setDependencyPath persists and getDependencyPath reads back", () => {
    setDependencyPath("depbin", "/custom/depbin");
    expect(getDependencyPath("depbin")).toBe("/custom/depbin");
  });

  it("setDependencyPath null clears the override", () => {
    setDependencyPath("depbin", "/custom/depbin");
    expect(getDependencyPath("depbin")).toBe("/custom/depbin");
    setDependencyPath("depbin", null);
    expect(getDependencyPath("depbin")).toBe(null);
  });

  it("dependencies are independent per binary name", () => {
    setDependencyPath("depbin", "/a/depbin");
    setDependencyPath("wakatime-cli", "/b/wakatime-cli");
    expect(getDependencyPath("depbin")).toBe("/a/depbin");
    expect(getDependencyPath("wakatime-cli")).toBe("/b/wakatime-cli");
  });

  it("moduleSnapshotChanged returns true after dependency path changes", () => {
    captureModuleSnapshot();
    expect(moduleSnapshotChanged()).toBe(false);
    setDependencyPath("depbin", "/custom/depbin");
    expect(moduleSnapshotChanged()).toBe(true);
  });

  it("moduleSnapshotChanged returns false after dependency cleared back to baseline", () => {
    setDependencyPath("depbin", "/custom/depbin");
    captureModuleSnapshot();
    setDependencyPath("depbin", null);
    expect(moduleSnapshotChanged()).toBe(true);
    setDependencyPath("depbin", "/custom/depbin");
    expect(moduleSnapshotChanged()).toBe(false);
  });

  it("setDependencyPath doesn't clobber other dependencies", () => {
    setDependencyPath("depbin", "/a/depbin");
    setDependencyPath("gopls", "/b/gopls");
    setDependencyPath("wakatime-cli", "/c/wakatime-cli");
    expect(getDependencyPath("depbin")).toBe("/a/depbin");
    expect(getDependencyPath("gopls")).toBe("/b/gopls");
    expect(getDependencyPath("wakatime-cli")).toBe("/c/wakatime-cli");
  });

  it("setDontBother preserves path override", () => {
    setDependencyPath("depbin", "/custom/depbin");
    setDontBother("depbin", true);
    expect(getDependencyPath("depbin")).toBe("/custom/depbin");
    expect(isDontBother("depbin")).toBe(true);
    setDontBother("depbin", false);
    expect(getDependencyPath("depbin")).toBe("/custom/depbin");
    expect(isDontBother("depbin")).toBe(false);
  });

  it("resolveDependency records runtime shadow without persisting it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-dep-"));
    try {
      const bin = path.join(dir, "shadow-bin");
      fs.writeFileSync(bin, "#!/bin/sh\necho ok\n");
      fs.chmodSync(bin, 0o755);

      expect(resolveDependency("shadow-bin", { extendPath: [dir] })).toBe(bin);
      expect(getDependencyView("shadow-bin")).toMatchObject({
        resolvedPath: bin,
        resolvedState: "ok",
      });
      expect(loadConfig().dependencies?.["shadow-bin"]).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("setDependencyPath invalidates stale runtime shadow for that binary", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-dep-"));
    try {
      const bin = path.join(dir, "clear-shadow-bin");
      fs.writeFileSync(bin, "#!/bin/sh\necho ok\n");
      fs.chmodSync(bin, 0o755);

      expect(resolveDependency("clear-shadow-bin", { extendPath: [dir] })).toBe(bin);
      expect(getDependencyView("clear-shadow-bin").resolvedPath).toBe(bin);
      setDependencyPath("clear-shadow-bin", "/custom/clear-shadow-bin");
      expect(getDependencyView("clear-shadow-bin")).toEqual({ path: "/custom/clear-shadow-bin" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// loadConfig / saveConfig
// ═══════════════════════════════════════════════════════════════════════════

describe("loadConfig / saveConfig", () => {
  beforeEach(() => {
    try {
      if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
    } catch {}
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
    try { if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE); } catch {}
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

// ── Agent dir resolution ──────────────────────────────────────────────────

describe("agent dir resolution", () => {
  it("writes decorated-pi.json under PI_CODING_AGENT_DIR", () => {
    // settings.ts must resolve through pi's getAgentDir(). Hardcoding
    // os.homedir() would ignore a relocated agent dir and would also defeat
    // the per-spec isolation in test/setup-agent-dir.ts.
    saveConfig({ imageModelKey: "resolution/model" });
    expect(fs.existsSync(path.join(agentDir(), "decorated-pi.json"))).toBe(true);
    expect(getImageModelKey()).toBe("resolution/model");
  });
});
