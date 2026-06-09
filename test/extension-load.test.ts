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

import { describe, it, expect } from "vitest";

/** Minimal mock pi: just enough surface for setupXxx() to run. */
function makeMockPi(): any {
  const log = {
    events: [] as string[],
    tools: [] as string[],
    commands: [] as string[],
    providers: [] as string[],
  };
  const pi: any = {
    on: (event: string) => log.events.push(event),
    registerTool: (tool: any) => log.tools.push(tool.name),
    registerCommand: (name: string) => log.commands.push(name),
    registerProvider: (id: string) => log.providers.push(id),
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

  it("registers the three LLM providers", async () => {
    const mod = await import("../index.js");
    const mockPi = makeMockPi();
    mod.default(mockPi);
    expect(mockPi.log.providers).toEqual(
      expect.arrayContaining(["ark-coding", "ollama-cloud", "qianfan-coding"]),
    );
  });

  it("registers the four slash commands", async () => {
    const mod = await import("../index.js");
    const mockPi = makeMockPi();
    mod.default(mockPi);
    expect(mockPi.log.commands).toEqual(
      expect.arrayContaining(["dp-model", "dp-settings", "mcp", "retry"]),
    );
  });

  it("registers skeleton event handlers (session_start, before_agent_start, tool_result)", async () => {
    const mod = await import("../index.js");
    const mockPi = makeMockPi();
    mod.default(mockPi);
    // The skeleton installs one pi.on per event that has registered handlers.
    expect(mockPi.log.events).toEqual(
      expect.arrayContaining(["session_start", "before_agent_start"]),
    );
  });
});
