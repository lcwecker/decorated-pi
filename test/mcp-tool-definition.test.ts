/**
 * tools/mcp/tool-definition.ts + tools/mcp/index.ts — tool factory and
 * cache-based tool registration.
 *
 * - buildMcpTool: builds a pi ToolDefinition from an MCP tool entry
 * - registerMcpToolsFromCache: registers tools from a cache, skipping
 *   duplicates and disabled servers
 * - registerMcpTools: loads cache + configs, then calls the above
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "mcp-tool-def-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const baseConfig = {
  name: "exa",
  url: "https://mcp.exa.ai/mcp",
  enabled: true,
  source: "builtin" as const,
};

// ─── buildMcpTool ─────────────────────────────────────────────────────────

describe("buildMcpTool", () => {
  it("prefixes the tool name with the server name", async () => {
    const { buildMcpTool } = await import("../tools/mcp/tool-definition.js");
    const tool = buildMcpTool(
      { ...baseConfig, name: "exa" },
      { name: "web_search" },
      () => undefined,
    );
    expect(tool.name).toBe("exa_web_search");
  });

  it("uses entry description when present", async () => {
    const { buildMcpTool } = await import("../tools/mcp/tool-definition.js");
    const tool = buildMcpTool(
      baseConfig,
      { name: "fetch", description: "Fetch a URL" },
      () => undefined,
    );
    expect(tool.description).toBe("Fetch a URL");
    expect(tool.promptSnippet).toBe("Fetch a URL");
    expect(tool.label).toContain("MCP exa");
    expect(tool.label).toContain("fetch");
  });

  it("falls back to a generated description when entry has none", async () => {
    const { buildMcpTool } = await import("../tools/mcp/tool-definition.js");
    const tool = buildMcpTool(
      baseConfig,
      { name: "ping" },
      () => undefined,
    );
    expect(tool.description).toBe("ping (MCP tool)");
    expect(tool.promptSnippet).toBe("ping (MCP tool)");
  });

  it("exposes the input schema from the entry", async () => {
    const { buildMcpTool } = await import("../tools/mcp/tool-definition.js");
    const schema = { type: "object", properties: { q: { type: "string" } } };
    const tool = buildMcpTool(baseConfig, { name: "x", inputSchema: schema }, () => undefined);
    expect(tool.parameters).toEqual(schema);
  });

  it("execute returns 'not connected' error when findConnection returns undefined", async () => {
    const { buildMcpTool } = await import("../tools/mcp/tool-definition.js");
    const tool = buildMcpTool(baseConfig, { name: "x" }, () => undefined);
    const result = await tool.execute("id", {}, undefined, undefined, {});
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("not connected");
    expect(result.content[0].text).toContain("/reload");
  });

  it("execute calls the connection's callTool and returns text", async () => {
    const { buildMcpTool } = await import("../tools/mcp/tool-definition.js");
    const conn = { callTool: vi.fn().mockResolvedValue("the result") };
    const tool = buildMcpTool(baseConfig, { name: "x" }, () => conn as any);
    const result = await tool.execute("id", { q: "hi" }, undefined, undefined, {});
    expect(conn.callTool).toHaveBeenCalledWith("x", { q: "hi" });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe("the result");
  });

  it("execute catches callTool errors and returns them as isError", async () => {
    const { buildMcpTool } = await import("../tools/mcp/tool-definition.js");
    const conn = { callTool: vi.fn().mockRejectedValue(new Error("server crash")) };
    const tool = buildMcpTool(baseConfig, { name: "x" }, () => conn as any);
    const result = await tool.execute("id", {}, undefined, undefined, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("server crash");
  });

  it("execute handles non-Error thrown values", async () => {
    const { buildMcpTool } = await import("../tools/mcp/tool-definition.js");
    const conn = { callTool: vi.fn().mockRejectedValue("string error") };
    const tool = buildMcpTool(baseConfig, { name: "x" }, () => conn as any);
    const result = await tool.execute("id", {}, undefined, undefined, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("string error");
  });

  it("execute passes empty params when params is undefined", async () => {
    const { buildMcpTool } = await import("../tools/mcp/tool-definition.js");
    const conn = { callTool: vi.fn().mockResolvedValue("ok") };
    const tool = buildMcpTool(baseConfig, { name: "x" }, () => conn as any);
    await tool.execute("id", undefined, undefined, undefined, {});
    expect(conn.callTool).toHaveBeenCalledWith("x", {});
  });
});

// ─── renderResult (truncation) ────────────────────────────────────────────

describe("buildMcpTool.renderResult", () => {
  // keyHint reads a global theme; provide a stub for the truncation hint.
  beforeEach(async () => {
    const kb = await import("../hooks/skeleton.js");
    // Mock keyHint to avoid reading global theme
    const { keyHint } = await import("@earendil-works/pi-coding-agent" as any).catch(() => ({ keyHint: (s: string) => s }));
    // Fallback: keyHint may not be exported, use a stub function
  });

  it("truncates long output and shows a 'more lines' hint", async () => {
    // Mock the keyHint import to avoid reading the global theme
    vi.doMock("@earendil-works/pi-coding-agent", async () => {
      const actual = await vi.importActual<any>("@earendil-works/pi-coding-agent");
      return {
        ...actual,
        keyHint: (_: string, label: string) => label,
      };
    });
    vi.resetModules();
    const { buildMcpTool } = await import("../tools/mcp/tool-definition.js");
    const tool = buildMcpTool(baseConfig, { name: "x" }, () => undefined);

    // Mock a theme with fg() that just returns the string
    const theme = { fg: (_: string, s: string) => s };
    const component = { setText: vi.fn() };
    const ctx = { lastComponent: component };

    const longText = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
    tool.renderResult(
      { content: [{ type: "text", text: longText }] },
      { expanded: false },
      theme,
      ctx,
    );

    expect(component.setText).toHaveBeenCalled();
    const out = component.setText.mock.calls[0][0];
    expect(out).toContain("line 1");
    expect(out).toContain("line 45"); // MCP_RESULT_FOLD_LINES = 45
    expect(out).not.toContain("line 46"); // truncated
    expect(out).toContain("more lines");
    vi.doUnmock("@earendil-works/pi-coding-agent");
  });

  it("shows the full text when expanded is true", async () => {
    vi.doMock("@earendil-works/pi-coding-agent", async () => {
      const actual = await vi.importActual<any>("@earendil-works/pi-coding-agent");
      return {
        ...actual,
        keyHint: (_: string, label: string) => label,
      };
    });
    vi.resetModules();
    const { buildMcpTool } = await import("../tools/mcp/tool-definition.js");
    const tool = buildMcpTool(baseConfig, { name: "x" }, () => undefined);
    const theme = { fg: (_: string, s: string) => s };
    const component = { setText: vi.fn() };
    const ctx = { lastComponent: component };

    const longText = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    tool.renderResult(
      { content: [{ type: "text", text: longText }] },
      { expanded: true },
      theme,
      ctx,
    );
    const out = component.setText.mock.calls[0][0];
    expect(out).toContain("line 100");
    vi.doUnmock("@earendil-works/pi-coding-agent");
  });

  it("ignores non-text content blocks", async () => {
    vi.doMock("@earendil-works/pi-coding-agent", async () => {
      const actual = await vi.importActual<any>("@earendil-works/pi-coding-agent");
      return {
        ...actual,
        keyHint: (_: string, label: string) => label,
      };
    });
    vi.resetModules();
    const { buildMcpTool } = await import("../tools/mcp/tool-definition.js");
    const tool = buildMcpTool(baseConfig, { name: "x" }, () => undefined);
    const theme = { fg: (_: string, s: string) => s };
    const component = { setText: vi.fn() };
    const ctx = { lastComponent: component };

    tool.renderResult(
      {
        content: [
          { type: "text", text: "ok" },
          { type: "image", data: "..." },
        ],
      },
      { expanded: true },
      theme,
      ctx,
    );
    const out = component.setText.mock.calls[0][0];
    expect(out).toBe("ok");
    vi.doUnmock("@earendil-works/pi-coding-agent");
  });
});

// ─── registerMcpToolsFromCache ────────────────────────────────────────────

describe("registerMcpToolsFromCache", () => {
  it("registers tools for each enabled server in the cache", async () => {
    const { registerMcpToolsFromCache } = await import("../tools/mcp/index.js");
    const pi = { registerTool: vi.fn() };
    const cache = {
      version: 1,
      servers: {
        exa: {
          tools: [
            { name: "web_search", description: "Search", inputSchema: {} },
            { name: "fetch", description: "Fetch", inputSchema: {} },
          ],
          cachedAt: 0,
        },
      },
    };
    const configs = [
      { name: "exa", url: "x", enabled: true, source: "builtin" as const },
    ];
    registerMcpToolsFromCache(pi as any, cache, configs);
    expect(pi.registerTool).toHaveBeenCalledTimes(2);
    expect(pi.registerTool.mock.calls[0][0].name).toBe("exa_web_search");
    expect(pi.registerTool.mock.calls[1][0].name).toBe("exa_fetch");
  });

  it("skips disabled servers", async () => {
    const { registerMcpToolsFromCache } = await import("../tools/mcp/index.js");
    const pi = { registerTool: vi.fn() };
    const cache = {
      version: 1,
      servers: {
        exa: { tools: [{ name: "search", description: "", inputSchema: {} }], cachedAt: 0 },
      },
    };
    const configs = [
      { name: "exa", url: "x", enabled: false, source: "builtin" as const },
    ];
    registerMcpToolsFromCache(pi as any, cache, configs);
    expect(pi.registerTool).not.toHaveBeenCalled();
  });

  it("skips servers not in the cache", async () => {
    const { registerMcpToolsFromCache } = await import("../tools/mcp/index.js");
    const pi = { registerTool: vi.fn() };
    const cache = { version: 1, servers: {} };
    const configs = [
      { name: "missing", url: "x", enabled: true, source: "builtin" as const },
    ];
    registerMcpToolsFromCache(pi as any, cache, configs);
    expect(pi.registerTool).not.toHaveBeenCalled();
  });

  it("skips servers with empty tool list", async () => {
    const { registerMcpToolsFromCache } = await import("../tools/mcp/index.js");
    const pi = { registerTool: vi.fn() };
    const cache = {
      version: 1,
      servers: { exa: { tools: [], cachedAt: 0 } },
    };
    const configs = [
      { name: "exa", url: "x", enabled: true, source: "builtin" as const },
    ];
    registerMcpToolsFromCache(pi as any, cache, configs);
    expect(pi.registerTool).not.toHaveBeenCalled();
  });

  it("swallows duplicate-registration errors", async () => {
    const { registerMcpToolsFromCache } = await import("../tools/mcp/index.js");
    const pi = {
      registerTool: vi.fn(() => {
        throw new Error("duplicate tool name");
      }),
    };
    const cache = {
      version: 1,
      servers: { exa: { tools: [{ name: "x", description: "", inputSchema: {} }], cachedAt: 0 } },
    };
    const configs = [
      { name: "exa", url: "x", enabled: true, source: "builtin" as const },
    ];
    // Should not throw
    expect(() => registerMcpToolsFromCache(pi as any, cache, configs)).not.toThrow();
  });
});

// ─── registerMcpTools (top-level) ─────────────────────────────────────────

describe("registerMcpTools", () => {
  it("loads cache, resolves configs, and registers cached tools", async () => {
    vi.resetModules();
    vi.doMock("../tools/mcp/cache.js", () => ({
      loadMcpCache: vi.fn(() => ({
        version: 1,
        servers: {
          exa: { tools: [{ name: "web_search", description: "Search", inputSchema: {} }], cachedAt: 0 },
        },
      })),
    }));
    vi.doMock("../tools/mcp/config.js", () => ({
      resolveMcpConfigs: vi.fn(() => [
        { name: "exa", url: "x", enabled: true, source: "builtin" as const },
      ]),
      isSseUrl: vi.fn(),
    }));

    const { registerMcpTools } = await import("../tools/mcp/index.js");
    const pi = { registerTool: vi.fn() };
    registerMcpTools(pi as any, tmpRoot);

    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    expect(pi.registerTool.mock.calls[0][0].name).toBe("exa_web_search");

    vi.doUnmock("../tools/mcp/cache.js");
    vi.doUnmock("../tools/mcp/config.js");
  });

  it("does nothing when there is no cache", async () => {
    vi.resetModules();
    vi.doMock("../tools/mcp/cache.js", () => ({
      loadMcpCache: vi.fn(() => null),
    }));
    vi.doMock("../tools/mcp/config.js", () => ({
      resolveMcpConfigs: vi.fn(() => [
        { name: "exa", url: "x", enabled: true, source: "builtin" as const },
      ]),
      isSseUrl: vi.fn(),
    }));

    const { registerMcpTools } = await import("../tools/mcp/index.js");
    const pi = { registerTool: vi.fn() };
    registerMcpTools(pi as any, tmpRoot);

    expect(pi.registerTool).not.toHaveBeenCalled();

    vi.doUnmock("../tools/mcp/cache.js");
    vi.doUnmock("../tools/mcp/config.js");
  });

  it("does nothing when all enabled servers have no cached tools", async () => {
    vi.resetModules();
    vi.doMock("../tools/mcp/cache.js", () => ({
      loadMcpCache: vi.fn(() => ({
        version: 1,
        servers: { exa: { tools: [], cachedAt: 0 } },
      })),
    }));
    vi.doMock("../tools/mcp/config.js", () => ({
      resolveMcpConfigs: vi.fn(() => [
        { name: "exa", url: "x", enabled: true, source: "builtin" as const },
      ]),
      isSseUrl: vi.fn(),
    }));

    const { registerMcpTools } = await import("../tools/mcp/index.js");
    const pi = { registerTool: vi.fn() };
    registerMcpTools(pi as any, tmpRoot);

    expect(pi.registerTool).not.toHaveBeenCalled();

    vi.doUnmock("../tools/mcp/cache.js");
    vi.doUnmock("../tools/mcp/config.js");
  });
});
