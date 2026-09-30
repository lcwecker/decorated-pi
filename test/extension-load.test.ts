/**
 * Extension load smoke test.
 *
 * Imports index.ts and calls its default export with a mock pi to verify
 * the plugin wires up without runtime errors. Catches issues that the
 * other test suites miss:
 *
 *   - Missing imports referenced by the entry point
 *   - Reference errors at module top level
 *   - Runtime errors during setupXxx() calls
 *   - pi.* API mismatches between ExtensionAPI and our usage
 *
 * Run alongside the unit tests; fast (~50ms).
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import { agentDir, agentDirFile } from "./agent-dir.js";

// Isolated by test/setup-agent-dir.ts — never the developer's real agent dir.
const CONFIG_DIR = agentDir();
const CONFIG_FILE = agentDirFile("decorated-pi.json");

/** Minimal mock pi: just enough surface for setupXxx() to run, plus the
 *  handler registry and a live active-tool list so a test can dispatch an
 *  event the way pi would. */
function makeMockPi(): any {
  const log = {
    events: [] as string[],
    tools: [] as string[],
    commands: [] as string[],
    activeTools: ["read", "bash", "write", "edit", "grep", "find", "ls"],
    handlers: {} as Record<string, Array<(event: any, ctx: any) => any>>,
  };
  const pi: any = {
    on: (event: string, handler: any) => {
      log.events.push(event);
      (log.handlers[event] ??= []).push(handler);
    },
    registerTool: (tool: any) => log.tools.push(tool.name),
    registerCommand: (name: string) => log.commands.push(name),
    registerMessageRenderer: () => {},
    getActiveTools: () => [...log.activeTools],
    setActiveTools: (names: string[]) => {
      log.activeTools = [...names];
    },
    sendMessage: () => {},
    setSessionName: () => {},
    appendEntry: () => {},
  };
  Object.defineProperty(pi, "log", { value: log, enumerable: true });
  return pi as ReturnType<typeof makeMockPi>;
}

/** A config naming every module switch, so a test never inherits a default
 *  that reaches the network or a language server. */
function moduleConfig(patchOverrideEdit: boolean) {
  return {
    modules: {
      tools: {
        patchOverrideEdit,
        ask: false,
        lsp: false,
        mcp: false,
        websearch: false,
        webFetch: false,
      },
      hooks: { wakatime: false, tps: false },
      commands: { retry: false, usage: false },
    },
  };
}

function writeConfig(config: unknown): void {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/** A session_start ctx carrying the surface our handlers touch. */
function makeCtx(): any {
  return {
    cwd: process.cwd(),
    hasUI: false,
    mode: "print",
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getSessionName: () => null,
    },
  };
}

/** Run the skeleton's session_start handler the way pi does. */
async function dispatchSessionStart(pi: any): Promise<void> {
  for (const handler of pi.log.handlers["session_start"] ?? []) {
    await handler({ type: "session_start", reason: "startup" }, makeCtx());
  }
}

describe("extension load smoke test", () => {
  beforeEach(() => {
    // Use a deterministic config so command/tool registration is stable.
    const clean = {
      modules: {
        tools: { patchOverrideEdit: true, ask: true, lsp: false, mcp: false },
        hooks: { wakatime: true },
        commands: { retry: true, usage: true },
      },
    };
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2) + "\n", "utf-8");
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

// ═══════════════════════════════════════════════════════════════════════════
// The native `edit` tool belongs to whoever replaces it
// ═══════════════════════════════════════════════════════════════════════════

describe("native edit ownership follows the patch switch", () => {
  it("registers patch and drops native edit when patchOverrideEdit is on", async () => {
    writeConfig(moduleConfig(true));
    const mod = await import("../index.js");
    const pi = makeMockPi();
    await mod.default(pi);
    await dispatchSessionStart(pi);

    expect(pi.log.tools).toContain("patch");
    expect(pi.log.activeTools).not.toContain("edit");
  });

  it("leaves native edit active when patchOverrideEdit is off", async () => {
    writeConfig(moduleConfig(false));
    const mod = await import("../index.js");
    const pi = makeMockPi();
    await mod.default(pi);
    await dispatchSessionStart(pi);

    // No replacement is registered, so dropping `edit` would leave the agent
    // without a targeted editor.
    expect(pi.log.tools).not.toContain("patch");
    expect(pi.log.activeTools).toContain("edit");
  });
});
