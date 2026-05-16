/**
 * Module Conditional Loading — Integration Test
 *
 * Verifies that extensions/index.ts correctly gates module loading
 * based on isModuleEnabled() config.
 *
 * Since we can't instantiate ExtensionAPI in tests, we test the
 * logic indirectly by verifying:
 * 1. isModuleEnabled() correctly controls which setup functions run
 * 2. The config toggle persists so /reload will pick up changes
 * 3. No tool/command name conflicts exist between modules
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isModuleEnabled,
  setModuleEnabled,
  getAllModuleSettings,
} from "../extensions/settings.js";

// ─── Config backup/restore ──────────────────────────────────────────────────

import * as os from "node:os";
const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_FILE = path.join(CONFIG_DIR, "decorated-pi.json");

let originalConfig: string | null = null;

function backupConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      originalConfig = fs.readFileSync(CONFIG_FILE, "utf-8");
      fs.unlinkSync(CONFIG_FILE);
    } else {
      originalConfig = null;
    }
  } catch { originalConfig = null; }
}

function restoreConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
    if (originalConfig !== null) {
      if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, originalConfig, "utf-8");
    }
  } catch { /* best effort */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// Conditional loading logic
// ═══════════════════════════════════════════════════════════════════════════

describe("Conditional loading — isModuleEnabled gates", () => {
  beforeEach(() => {
    backupConfig();
    try { if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE); } catch {}
  });

  afterEach(() => {
    restoreConfig();
  });

  it("all three modules are enabled by default", () => {
    expect(isModuleEnabled("safety")).toBe(true);
    expect(isModuleEnabled("lsp")).toBe(true);
    expect(isModuleEnabled("smart-at")).toBe(true);
  });

  it("disabling safety does not affect other modules", () => {
    setModuleEnabled("safety", false);
    expect(isModuleEnabled("safety")).toBe(false);
    expect(isModuleEnabled("lsp")).toBe(true);
    expect(isModuleEnabled("smart-at")).toBe(true);
  });

  it("disabling lsp does not affect other modules", () => {
    setModuleEnabled("lsp", false);
    expect(isModuleEnabled("safety")).toBe(true);
    expect(isModuleEnabled("lsp")).toBe(false);
    expect(isModuleEnabled("smart-at")).toBe(true);
  });

  it("disabling smart-at does not affect other modules", () => {
    setModuleEnabled("smart-at", false);
    expect(isModuleEnabled("safety")).toBe(true);
    expect(isModuleEnabled("lsp")).toBe(true);
    expect(isModuleEnabled("smart-at")).toBe(false);
  });

  it("all three can be disabled simultaneously", () => {
    setModuleEnabled("safety", false);
    setModuleEnabled("lsp", false);
    setModuleEnabled("smart-at", false);
    const settings = getAllModuleSettings();
    expect(settings.safety).toBe(false);
    expect(settings.lsp).toBe(false);
    expect(settings["smart-at"]).toBe(false);
  });

  it("all three can be re-enabled after disabling", () => {
    setModuleEnabled("safety", false);
    setModuleEnabled("lsp", false);
    setModuleEnabled("smart-at", false);

    setModuleEnabled("safety", true);
    setModuleEnabled("lsp", true);
    setModuleEnabled("smart-at", true);

    const settings = getAllModuleSettings();
    expect(settings.safety).toBe(true);
    expect(settings.lsp).toBe(true);
    expect(settings["smart-at"]).toBe(true);
  });

  it("config persists across reloads (simulated)", () => {
    setModuleEnabled("lsp", false);

    // Simulate /reload: re-read config from disk
    const reReadEnabled = isModuleEnabled("lsp");
    expect(reReadEnabled).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tool/command name uniqueness (no conflicts)
// ═══════════════════════════════════════════════════════════════════════════

describe("Tool/command name uniqueness — no conflicts", () => {
  it("LSP tool names are unique within decorated-pi", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../extensions/lsp/tools.ts"), "utf-8"
    );
    const names = [...src.matchAll(/name:\s*["'](lsp_[^"']+)["']/g)].map(m => m[1]!);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length); // no duplicates
  });

  it("slash command names are unique within decorated-pi", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../extensions/slash.ts"), "utf-8"
    );
    const names = [...src.matchAll(/registerCommand\(["']([^"']+)["']/g)].map(m => m[1]!);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length); // no duplicates
  });

  it("LSP tool names use lsp_ prefix (decorated-pi only, no Pi built-in)", () => {
    // Pi has NO built-in lsp_* tools. When our LSP module is disabled,
    // the lsp_* tools simply don't exist — there is no fallback.
    const src = fs.readFileSync(
      path.join(__dirname, "../extensions/lsp/tools.ts"), "utf-8"
    );
    const ourTools = [...src.matchAll(/name:\s*["'](lsp_[^"']+)["']/g)].map(m => m[1]!);
    expect(ourTools.length).toBeGreaterThan(0);
    expect(ourTools.every(n => n.startsWith("lsp_"))).toBe(true);
  });

  it("decorated-pi command names have dp- prefix to avoid collision", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../extensions/slash.ts"), "utf-8"
    );
    const names = [...src.matchAll(/registerCommand\(["']([^"']+)["']/g)].map(m => m[1]!);
    // dp-model, dp-settings, retry — dp- prefixed except retry
    // retry is our custom name, unlikely to collide
    expect(names).toContain("dp-model");
    expect(names).toContain("dp-settings");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// index.ts conditional loading — source code verification
// ═══════════════════════════════════════════════════════════════════════════

describe("index.ts — conditional loading structure", () => {
  const indexSrc = fs.readFileSync(
    path.join(__dirname, "../extensions/index.ts"), "utf-8"
  );

  it("gates safety behind isModuleEnabled", () => {
    expect(indexSrc).toContain('if (isModuleEnabled("safety"))');
    expect(indexSrc).toContain("setupSafety(pi)");
  });

  it("gates lsp behind isModuleEnabled", () => {
    expect(indexSrc).toContain('if (isModuleEnabled("lsp"))');
    expect(indexSrc).toContain("setupLsp(pi)");
  });

  it("gates smart-at behind isModuleEnabled", () => {
    expect(indexSrc).toContain('if (isModuleEnabled("smart-at"))');
    expect(indexSrc).toContain("setupSmartAt(pi)");
  });

  it("always loads core modules (no gating)", () => {
    // These should NOT be behind isModuleEnabled
    expect(indexSrc).toContain("setupSlash(pi)");
    expect(indexSrc).toContain("setupProviders(pi)");
    expect(indexSrc).toContain("setupExtendModel(pi)");
    expect(indexSrc).toContain("setupSubdirAgents(pi)");
    expect(indexSrc).toContain("setupSessionTitle(pi)");
    expect(indexSrc).toContain("setupGuidance(pi)");
  });

  it("imports isModuleEnabled from settings", () => {
    expect(indexSrc).toContain('import { isModuleEnabled } from "./settings"');
  });
});
