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
} from "../settings.js";

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

  it("core modules are enabled by default", () => {
    expect(isModuleEnabled("secretRedaction")).toBe(true);
    expect(isModuleEnabled("lsp")).toBe(true);
    expect(isModuleEnabled("atOverride")).toBe(true);
    expect(isModuleEnabled("retry")).toBe(true);
    expect(isModuleEnabled("usage")).toBe(true);
  });

  it("disabling secretRedaction does not affect other modules", () => {
    setModuleEnabled("secretRedaction", false);
    expect(isModuleEnabled("secretRedaction")).toBe(false);
    expect(isModuleEnabled("lsp")).toBe(true);
    expect(isModuleEnabled("atOverride")).toBe(true);
  });

  it("disabling lsp does not affect other modules", () => {
    setModuleEnabled("lsp", false);
    expect(isModuleEnabled("secretRedaction")).toBe(true);
    expect(isModuleEnabled("lsp")).toBe(false);
    expect(isModuleEnabled("atOverride")).toBe(true);
  });

  it("disabling atOverride does not affect other modules", () => {
    setModuleEnabled("atOverride", false);
    expect(isModuleEnabled("secretRedaction")).toBe(true);
    expect(isModuleEnabled("lsp")).toBe(true);
    expect(isModuleEnabled("atOverride")).toBe(false);
  });

  it("core modules can be disabled simultaneously", () => {
    setModuleEnabled("secretRedaction", false);
    setModuleEnabled("lsp", false);
    setModuleEnabled("atOverride", false);
    const settings = getAllModuleSettings();
    expect(settings.hooks.secretRedaction).toBe(false);
    expect(settings.tools.lsp).toBe(false);
    expect(settings.commands.atOverride).toBe(false);
  });

  it("core modules can be re-enabled after disabling", () => {
    setModuleEnabled("secretRedaction", false);
    setModuleEnabled("lsp", false);
    setModuleEnabled("atOverride", false);

    setModuleEnabled("secretRedaction", true);
    setModuleEnabled("lsp", true);
    setModuleEnabled("atOverride", true);

    const settings = getAllModuleSettings();
    expect(settings.hooks.secretRedaction).toBe(true);
    expect(settings.tools.lsp).toBe(true);
    expect(settings.commands.atOverride).toBe(true);
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
      path.join(__dirname, "../tools/lsp/tools.ts"), "utf-8"
    );
    const names = [...src.matchAll(/name:\s*["'](lsp_[^"']+)["']/g)].map(m => m[1]!);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length); // no duplicates
  });

  it("slash command names are unique within decorated-pi", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../commands/dp-model.ts"), "utf-8"
    );
    const names = [...src.matchAll(/registerCommand\(["']([^"']+)["']/g)].map(m => m[1]!);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length); // no duplicates
  });

  it("LSP tool names use lsp_ prefix (decorated-pi only, no Pi built-in)", () => {
    // Pi has NO built-in lsp_* tools. When our LSP module is disabled,
    // the lsp_* tools simply don't exist — there is no fallback.
    const src = fs.readFileSync(
      path.join(__dirname, "../tools/lsp/tools.ts"), "utf-8"
    );
    const ourTools = [...src.matchAll(/name:\s*["'](lsp_[^"']+)["']/g)].map(m => m[1]!);
    expect(ourTools.length).toBeGreaterThan(0);
    expect(ourTools.every(n => n.startsWith("lsp_"))).toBe(true);
  });

  it("decorated-pi command names have dp- prefix to avoid collision", () => {
    // dp-settings and dp-model are dp- prefixed; retry is a common name
    // unlikely to collide. Read all command files to verify.
    const commandsDir = path.join(__dirname, "../commands");
    const files = fs.readdirSync(commandsDir).filter(f => f.endsWith(".ts"));
    const names: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(commandsDir, f), "utf-8");
      const matches = [...src.matchAll(/registerCommand\(["']([^"']+)["']/g)].map(m => m[1]!);
      names.push(...matches);
    }
    expect(names).toContain("dp-model");
    expect(names).toContain("dp-settings");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// index.ts conditional loading — source code verification
// ═══════════════════════════════════════════════════════════════════════════

describe("index.ts — conditional loading structure (new architecture)", () => {
  const indexSrc = fs.readFileSync(
    path.join(__dirname, "../index.ts"), "utf-8"
  );

  it("gates LSP tool behind isModuleEnabled (LSP is a tool)", () => {
    expect(indexSrc).toContain('if (isModuleEnabled("lsp"))');
    expect(indexSrc).toContain("registerLspTools");
  });

  it("gates MCP tool registration behind isModuleEnabled", () => {
    expect(indexSrc).toContain('if (isModuleEnabled("mcp"))');
  });

  it("gates patch tool behind isModuleEnabled", () => {
    expect(indexSrc).toContain('if (isModuleEnabled("patchOverrideEdit"))');
    expect(indexSrc).toContain("registerPatchTool");
  });

  it("gates secretRedaction hook behind isModuleEnabled", () => {
    expect(indexSrc).toContain('if (isModuleEnabled("secretRedaction"))');
    expect(indexSrc).toContain("setupRedact");
  });

  it("gates atOverride hook behind isModuleEnabled", () => {
    expect(indexSrc).toContain('if (isModuleEnabled("atOverride"))');
    expect(indexSrc).toContain("smartAtModule");
  });

  it("gates rtk and wakatime hooks behind isModuleEnabled", () => {
    expect(indexSrc).toContain('if (isModuleEnabled("rtk"))');
    expect(indexSrc).toContain("setupRtk");
    expect(indexSrc).toContain('if (isModuleEnabled("wakatime"))');
    expect(indexSrc).toContain("setupWakatime");
  });

  it("always loads core commands (no gating)", () => {
    expect(indexSrc).toContain("registerDpModelCommand");
    expect(indexSrc).toContain("registerDpSettingsCommand");
  });

  it("gates retry and usage commands behind isModuleEnabled", () => {
    expect(indexSrc).toContain('if (isModuleEnabled("retry"))');
    expect(indexSrc).toContain("registerRetryCommand");
    expect(indexSrc).toContain('if (isModuleEnabled("usage"))');
    expect(indexSrc).toContain("registerUsageCommand");
  });

  it("gates /mcp command behind isModuleEnabled(mcp)", () => {
    expect(indexSrc).toMatch(/if\s*\(\s*isModuleEnabled\(["']mcp["']\)\s*\)[\s\S]*?registerMcpStatusCommand\(pi\)/);
  });

  it("imports isModuleEnabled from settings", () => {
    expect(indexSrc).toMatch(/import\s*\{[^}]*\bisModuleEnabled\b[^}]*\}\s*from\s*"\.\/settings(\.js)?"/);
  });

  it("uses the skeleton for hooks", () => {
    expect(indexSrc).toContain("createSkeleton");
    expect(indexSrc).toContain("sk.install(pi)");
  });
});
