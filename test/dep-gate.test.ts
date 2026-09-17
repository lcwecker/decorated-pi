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

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import { agentDir, agentDirFile } from "./agent-dir.js";

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

// Isolated by test/setup-agent-dir.ts — never the developer's real agent dir.
const CONFIG_DIR = agentDir();
const CONFIG_FILE = agentDirFile("decorated-pi.json");
const MCP_FILE = agentDirFile("mcp.json");

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
    registerMessageRenderer: () => {},
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
    const clean = {
      modules: {
        tools: { patchOverrideEdit: true, ask: true, lsp: true, mcp: true },
        hooks: { wakatime: false },
        commands: { retry: false, usage: false },
      },
    };
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2) + "\n", "utf-8");

    // Keep the MCP loop offline. The isolated agent dir has a cold MCP cache,
    // so the two builtin URL servers would otherwise attempt a real network
    // connection on every import. This spec only cares about the codegraph
    // binary gate, so disabling them changes nothing it asserts.
    fs.writeFileSync(
      MCP_FILE,
      JSON.stringify(
        { mcpServers: { context7: { enabled: false }, exa: { enabled: false } } },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
  });

  it("LSP module: bundled TypeScript 7 makes diagnostics available", async () => {
    const mod = await import("../index.js");
    const mockPi = makeMockPi();
    await mod.default(mockPi);

    expect(mockPi.log.tools).toContain("lsp_diagnostics");
  });

  it("MCP module: codegraph tools not registered when codegraph binary is missing", async () => {
    const mod = await import("../index.js");
    const mockPi = makeMockPi();
    await mod.default(mockPi);

    // codegraph uses a command (binary) and its tool names start with
    // `codegraph_`. With the binary missing, those tools must NOT be
    // registered. context7/exa are disabled in this spec's mcp.json so the
    // import stays offline.
    const codegraphTools = mockPi.log.tools.filter((t: string) => t.startsWith("codegraph_"));
    expect(codegraphTools).toEqual([]);
  });
});
