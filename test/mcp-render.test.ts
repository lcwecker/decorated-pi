import { describe, expect, it, vi } from "vitest";
import { __mcpIndexTest } from "../tools/mcp/index.js";
import type { McpServerConfig } from "../tools/mcp/config.js";
import { TOOL_RESULT_FOLD_LINES } from "../utils/tool-output.js";

const FOLD = TOOL_RESULT_FOLD_LINES;

describe("mcp tool result folding", () => {
  it("does not fold at the fold length", () => {
    const text = Array.from({ length: FOLD }, (_, i) => `line ${i + 1}`).join("\n");
    const result = __mcpIndexTest.collapseMcpText(text);
    expect(result.totalLines).toBe(FOLD);
    expect(result.displayLines).toHaveLength(FOLD);
    expect(result.remainingLines).toBe(0);
  });

  it("folds past the fold length", () => {
    const text = Array.from({ length: FOLD + 5 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = __mcpIndexTest.collapseMcpText(text);
    expect(result.totalLines).toBe(FOLD + 5);
    expect(result.displayLines).toHaveLength(FOLD);
    expect(result.displayLines.at(-1)).toBe(`line ${FOLD}`);
    expect(result.remainingLines).toBe(5);
  });

  it("ignores trailing empty lines when counting fold length", () => {
    const text = `${Array.from({ length: FOLD + 1 }, (_, i) => `line ${i + 1}`).join("\n")}\n\n\n`;
    const result = __mcpIndexTest.collapseMcpText(text);
    expect(result.totalLines).toBe(FOLD + 1);
    expect(result.displayLines).toHaveLength(FOLD);
    expect(result.remainingLines).toBe(1);
  });

  it("keeps the fold tighter than the old value", () => {
    // The collapsed view exists for context economy: at 45 lines it was long
    // enough to read past without ever expanding.
    expect(FOLD).toBeLessThan(45);
  });
});

// ─── buildMcpTool ────────────────────────────────────────────────────────────

const SAMPLE_CONFIG: McpServerConfig = {
  name: "codegraph",
  command: "codegraph",
  args: ["serve", "--mcp"],
  enabled: true,
  source: "builtin",
};

describe("buildMcpTool", () => {
  it("builds a tool definition with `${server}_${tool}` naming", () => {
    const tool = __mcpIndexTest.buildMcpTool(SAMPLE_CONFIG, { name: "explore", description: "Explore the graph", inputSchema: { type: "object" } }, () => undefined);
    expect(tool.name).toBe("codegraph_explore");
    expect(tool.label).toBe("MCP codegraph: explore (Explore the graph)");
    expect(tool.description).toBe("Explore the graph");
    expect(tool.promptSnippet).toBe("Explore the graph");
    expect(tool.parameters).toEqual({ type: "object" });
  });

  it("falls back to a generic description when none provided", () => {
    const tool = __mcpIndexTest.buildMcpTool(SAMPLE_CONFIG, { name: "explore" }, () => undefined);
    expect(tool.description).toBe("explore (MCP tool)");
    expect(tool.promptSnippet).toBe("explore (MCP tool)");
  });

  it("execute returns an error message when no connection is found", async () => {
    const tool = __mcpIndexTest.buildMcpTool(SAMPLE_CONFIG, { name: "explore" }, () => undefined);
    const result = await tool.execute("id1", { q: "test" }, undefined, () => {}, {});
    expect(result.isError).toBe(false);
    expect((result.content[0] as { text: string }).text).toMatch(/not connected/);
  });

  it("execute forwards the call to the connection and returns its result", async () => {
    const conn = { callTool: vi.fn(async () => "raw tool output") };
    const tool = __mcpIndexTest.buildMcpTool(SAMPLE_CONFIG, { name: "explore" }, () => conn as any);
    const result = await tool.execute("id1", { q: "test" }, undefined, () => {}, {});
    expect(conn.callTool).toHaveBeenCalledWith("explore", { q: "test" }, undefined);
    expect((result.content[0] as { text: string }).text).toBe("raw tool output");
    expect(result.isError).toBe(false);
  });

  it("execute defaults params to {} when not provided", async () => {
    const conn = { callTool: vi.fn(async () => "ok") };
    const tool = __mcpIndexTest.buildMcpTool(SAMPLE_CONFIG, { name: "explore" }, () => conn as any);
    await tool.execute("id1", undefined, undefined, () => {}, {});
    expect(conn.callTool).toHaveBeenCalledWith("explore", {}, undefined);
  });

  it("execute returns the error message when the connection throws", async () => {
    const conn = { callTool: vi.fn(async () => { throw new Error("server unavailable"); }) };
    const tool = __mcpIndexTest.buildMcpTool(SAMPLE_CONFIG, { name: "explore" }, () => conn as any);
    const result = await tool.execute("id1", {}, undefined, () => {}, {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/codegraph_explore.*error.*server unavailable/);
  });

  it("execute handles non-Error throws", async () => {
    const conn = { callTool: vi.fn(async () => { throw "string error"; }) };
    const tool = __mcpIndexTest.buildMcpTool(SAMPLE_CONFIG, { name: "explore" }, () => conn as any);
    const result = await tool.execute("id1", {}, undefined, () => {}, {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/string error/);
  });
});
