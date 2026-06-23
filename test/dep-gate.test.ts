/**
 * Dependency gate tests for the index.ts tool registration flow.
 *
 * The dep gate is in index.ts: tools whose dependencies are not met
 * are NOT registered with pi. These tests verify that behavior by
 * importing index.ts with a mock pi and inspecting what was registered.
 *
 * The MCP dep gate is checked against the binary command existence.
 * The LSP dep gate is checked against whether at least one LSP server
 * is available.
 *
 * Both gates consult `utils/which.ts`, which uses `fs.accessSync(X_OK)`
 * to stat candidates on $PATH. We mock `node:fs.accessSync` to throw
 * ENOENT so every binary looks missing, and keep `node:child_process`'s
 * `spawnSync` failing too as a defensive belt-and-suspenders.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: () => ({ status: 1, stdout: "", stderr: "" }),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    // Simulate "binary not on PATH" for the dep gate. `which()` checks
    // executability via accessSync(X_OK); throwing ENOENT here makes
    // every binary look missing. existsSync stays real so test setup
    // (reading ~/.pi/agent/decorated-pi.json) still works.
    accessSync: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };
});

const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_FILE = path.join(CONFIG_DIR, "decorated-pi.json");
let originalConfig: string | null = null;

function backupConfig() {
  try {
    originalConfig = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, "utf-8") : null;
  } catch { originalConfig = null; }
}

function restoreConfig() {
  try {
    if (originalConfig === null) {
      if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
    } else {
      if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, originalConfig, "utf-8");
    }
  } catch { /* best effort */ }
}

function makeMockPi(): any {
  const log = {
    events: [] as string[],
    tools: [] as string[],
    commands: [] as string[],
  };
  const pi: any = {
    on: (event: string) => log.events.push(event),
    registerTool: (tool: any) => log.tools.push(tool.name),
    registerCommand: (name: string) => log.commands.push(name),
    getActiveTools: () => ["read", "bash", "write", "edit", "grep", "find", "ls"],
    setActiveTools: () => {},
    sendMessage: () => {},
    setSessionName: () => {},
    appendEntry: () => {},
  };
  Object.defineProperty(pi, "log", { value: log, enumerable: true });
  return pi as ReturnType<typeof makeMockPi>;
}

describe("index.ts dep gate", () => {
  beforeEach(() => {
    backupConfig();
    const clean = {
      modules: {
        tools: { patchOverrideEdit: true, ask: true, lsp: true, mcp: true },
        hooks: { secretRedaction: true, rtk: false, wakatime: false },
        commands: { atOverride: false, retry: false, usage: false },
      },
    };
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2) + "\n", "utf-8");
  });

  afterEach(() => {
    restoreConfig();
  });

  it("LSP module: no tools register when no LSP server binary is available", async () => {
    const mod = await import("../index.js");
    const mockPi = makeMockPi();
    await mod.default(mockPi);

    // lsp_diagnostics should NOT be among registered tools.
    expect(mockPi.log.tools).not.toContain("lsp_diagnostics");
  });

  it("MCP module: codegraph tools not registered when codegraph binary is missing", async () => {
    const mod = await import("../index.js");
    const mockPi = makeMockPi();
    await mod.default(mockPi);

    // codegraph uses a command (binary) and its tool names start with
    // `codegraph_`. With the binary missing, those tools must NOT be
    // registered. context7/exa (URL-based) have no binary dep and
    // would still be registered — that's expected and correct.
    const codegraphTools = mockPi.log.tools.filter((t: string) => t.startsWith("codegraph_"));
    expect(codegraphTools).toEqual([]);
  });
});
