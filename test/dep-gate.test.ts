/**
 * Dependency gate tests for the index.ts tool registration flow.
 *
 * The dep gate is in index.ts: tools whose dependencies are not met
 * are NOT registered with pi. These tests verify that behavior by
 * importing index.ts with a mock pi and inspecting what was registered.
 *
 * The MCP module hands pi's built-in MCP extension the servers the pack
 * ships. context7 is a hosted URL and is always handed over; codegraph is
 * handed over only in a project that has an index *and* a CLI on disk, and the
 * same condition produces its dependency-gate entry. The LSP dep gate is
 * checked against whether at least one LSP server is available.
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

// This spec runs the real index.ts, whose MCP block migrates the project's
// legacy server list. Keeping that off the repository root is the point: the
// migration has its own spec (test/mcp.test.ts) against temp directories, so a
// developer with a `<repo>/.pi/agent/mcp.json` never sees this suite rewrite
// their working tree. The handover itself stays real below.
vi.mock("../tools/mcp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/mcp.js")>();
  return { ...actual, migrateProjectMcpConfig: vi.fn() };
});

// Isolated by test/setup-agent-dir.ts — never the developer's real agent dir.
const CONFIG_DIR = agentDir();
const CONFIG_FILE = agentDirFile("decorated-pi.json");

function makeMockPi(): any {
  const log = {
    events: [] as string[],
    tools: [] as string[],
    commands: [] as string[],
    mcpServers: [] as Array<{ name: string; config: any }>,
  };
  const pi: any = {
    on: (event: string) => log.events.push(event),
    registerTool: (tool: any) => log.tools.push(tool.name),
    registerCommand: (name: string) => log.commands.push(name),
    registerMcpServer: (name: string, config: any) => log.mcpServers.push({ name, config }),
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
  });

  it("LSP module: bundled TypeScript 7 makes the navigation tools available", async () => {
    const mod = await import("../index.js");
    const mockPi = makeMockPi();
    await mod.default(mockPi);

    for (const tool of ["lsp_definition", "lsp_references", "lsp_document_symbols", "lsp_rename"]) {
      expect(mockPi.log.tools).toContain(tool);
    }
  });

  it("MCP module: the pack hands its builtin servers to pi's MCP extension", async () => {
    const mod = await import("../index.js");
    const mockPi = makeMockPi();
    await mod.default(mockPi);

    // `accessSync` is mocked to fail above, so no binary resolves: context7 is
    // hosted and always handed over, codegraph needs its CLI before it is
    // offered — the same gate its dependency-gate entry reports on, even in an
    // indexed checkout like this one. The old self-hosted client registered
    // codegraph_* tools itself; pi names the tools of a registered server
    // mcp__<server>__<tool>, so none appear here.
    expect(mockPi.log.mcpServers.map((s: any) => s.name)).toEqual(["context7"]);
    expect(mockPi.log.mcpServers[0].config.url).toBe("https://mcp.context7.com/mcp");
    expect(mockPi.log.tools.filter((t: string) => t.startsWith("codegraph_"))).toEqual([]);
  });
});
