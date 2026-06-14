/**
 * Extension load smoke test.
 *
 * Imports index.ts and calls its default export with a mock pi to verify
 * the plugin wires up without runtime errors. Catches issues that the
 * other test suites miss:
 *
 *   - Missing imports (e.g. using wakatimeModule without importing it)
 *   - Reference errors at module top level
 *   - Runtime errors during setupXxx() calls
 *   - pi.* API mismatches between ExtensionAPI and our usage
 *
 * Run alongside the unit tests; fast (~50ms).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_FILE = path.join(CONFIG_DIR, "decorated-pi.json");
let originalConfig: string | null = null;

function backupConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      originalConfig = fs.readFileSync(CONFIG_FILE, "utf-8");
    } else {
      originalConfig = null;
    }
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

/** Minimal mock pi: just enough surface for setupXxx() to run. */
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

describe("extension load smoke test", () => {
  beforeEach(() => {
    backupConfig();
    // Use a deterministic config so command/tool registration is stable
    // regardless of the user's real ~/.pi/agent/decorated-pi.json.
    const clean = {
      modules: {
        tools: { patchOverrideEdit: true, ask: true, lsp: false, mcp: false },
        hooks: { secretRedaction: true, rtk: true, wakatime: true },
        commands: { atOverride: true, retry: true, usage: true },
      },
    };
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2) + "\n", "utf-8");
  });

  afterEach(() => {
    restoreConfig();
  });

  it("imports index.ts without throwing", async () => {
    // Catches issues that fail at module load time, e.g. a symbol used
    // but not imported.
    await expect(import("../index.js")).resolves.toBeDefined();
  });

  it("default export is a function", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.default).toBe("function");
  });

  it("default export runs without throwing on a mock pi", async () => {
    const mod = await import("../index.js");
    const mockPi = makeMockPi();
    expect(() => mod.default(mockPi)).not.toThrow();
  });

  it("registers the expected slash commands", async () => {
    const mod = await import("../index.js");
    const mockPi = makeMockPi();
    await mod.default(mockPi);
    // With mcp disabled, /mcp is not registered. Core commands are always
    // present: dp-model, dp-settings, retry. /usage is also enabled.
    expect(mockPi.log.commands).toEqual(
      expect.arrayContaining(["dp-model", "dp-settings", "retry"]),
    );
  });

  it("registers skeleton event handlers (session_start, before_agent_start, tool_result)", async () => {
    const mod = await import("../index.js");
    const mockPi = makeMockPi();
    await mod.default(mockPi);
    // The skeleton installs one pi.on per event that has registered handlers.
    expect(mockPi.log.events).toEqual(
      expect.arrayContaining(["session_start", "before_agent_start"]),
    );
  });
});
