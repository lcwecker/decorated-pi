/**
 * MCP Client — Unit Tests
 *
 * Covers tools/mcp/client.ts (McpConnection wrapper around @modelcontextprotocol/sdk).
 * Mocks the SDK's Client class and three transport classes so we can
 * exercise the connection lifecycle, tool listing, and call/disconnect
 * paths without spawning real servers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { McpServerConfig } from "../tools/mcp/config.js";

// ─── SDK mocks ────────────────────────────────────────────────────────────

const mockClientInstances: Array<{
  connect: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}> = [];

const transportInstances: Array<{ kind: string; url?: string; command?: string }> = [];

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  return {
    Client: class MockClient {
      connect = vi.fn().mockResolvedValue(undefined);
      listTools = vi.fn().mockResolvedValue({ tools: [] });
      callTool = vi.fn().mockResolvedValue({ content: [] });
      close = vi.fn().mockResolvedValue(undefined);
      constructor(_opts: unknown) {
        mockClientInstances.push(this);
      }
    },
  };
});

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockHttp {
    constructor(public url: URL) {
      transportInstances.push({ kind: "http", url: url.toString() });
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSse {
    constructor(public url: URL) {
      transportInstances.push({ kind: "sse", url: url.toString() });
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdio {
    constructor(public opts: { command: string; args?: string[]; env?: Record<string, string> }) {
      transportInstances.push({ kind: "stdio", command: opts.command });
    }
  },
}));

// Import after mocks are registered
const { McpConnection } = await import("../tools/mcp/client.js");

// ─── Helpers ──────────────────────────────────────────────────────────────

function baseConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "test",
    enabled: true,
    source: "builtin",
    ...overrides,
  };
}

beforeEach(() => {
  mockClientInstances.length = 0;
  transportInstances.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Constructor ──────────────────────────────────────────────────────────

describe("McpConnection — constructor", () => {
  it("stores serverName and config", () => {
    const cfg = baseConfig({ command: "x" });
    const conn = new McpConnection("myserver", cfg);
    expect(conn.serverName).toBe("myserver");
    expect(conn.config).toBe(cfg);
    expect(conn.tools).toEqual([]);
    expect(conn.connected).toBe(false);
  });

  it("constructs an SDK Client with a server-specific name", () => {
    new McpConnection("foo", baseConfig({ command: "x" }));
    expect(mockClientInstances).toHaveLength(1);
  });
});

// ─── connect() — transport selection ──────────────────────────────────────

describe("McpConnection — connect()", () => {
  it("uses StdioClientTransport when config has command", async () => {
    const conn = new McpConnection("stdio1", baseConfig({
      command: "node",
      args: ["server.js"],
      env: { FOO: "bar" },
    }));
    await conn.connect();
    expect(transportInstances[0]).toMatchObject({ kind: "stdio", command: "node" });
    expect(conn.connected).toBe(true);
    expect(conn.transport).toBeDefined();
  });

  it("uses StreamableHTTPClientTransport for non-/sse URLs", async () => {
    const conn = new McpConnection("http1", baseConfig({
      url: "https://example.com/mcp",
    }));
    await conn.connect();
    expect(transportInstances[0]).toMatchObject({ kind: "http", url: "https://example.com/mcp" });
    expect(conn.connected).toBe(true);
  });

  it("uses SSEClientTransport when URL ends with /sse", async () => {
    const conn = new McpConnection("sse1", baseConfig({
      url: "https://example.com/sse",
    }));
    await conn.connect();
    expect(transportInstances[0]).toMatchObject({ kind: "sse", url: "https://example.com/sse" });
    expect(conn.connected).toBe(true);
  });

  it("uses SSEClientTransport when URL ends with /sse/ (trailing slash)", async () => {
    const conn = new McpConnection("sse2", baseConfig({
      url: "https://example.com/sse/",
    }));
    await conn.connect();
    expect(transportInstances[0].kind).toBe("sse");
  });

  it("throws when neither url nor command is configured", async () => {
    const conn = new McpConnection("invalid", baseConfig());
    await expect(conn.connect()).rejects.toThrow(/no url or command configured/);
    expect(conn.connected).toBe(false);
  });

  it("calls client.connect(transport) for stdio", async () => {
    const conn = new McpConnection("stdio-c", baseConfig({ command: "bin" }));
    await conn.connect();
    const client = mockClientInstances[0];
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.connect.mock.calls[0][0]).toBeDefined();
  });

  it("populates this.tools from listTools() result", async () => {
    const conn = new McpConnection("list-test", baseConfig({ command: "bin" }));
    const client = mockClientInstances[mockClientInstances.length - 1];
    client.listTools.mockResolvedValueOnce({
      tools: [
        { name: "echo", description: "Echo input", inputSchema: { type: "object" } },
        { name: "no-desc" },
      ],
    });
    await conn.connect();
    expect(conn.tools).toEqual([
      { name: "echo", description: "Echo input", inputSchema: { type: "object" } },
      { name: "no-desc", description: "", inputSchema: { type: "object", properties: {} } },
    ]);
  });

  it("handles missing description with empty string", async () => {
    const conn = new McpConnection("desc-test", baseConfig({ command: "bin" }));
    const client = mockClientInstances[mockClientInstances.length - 1];
    client.listTools.mockResolvedValueOnce({
      tools: [{ name: "x" }],
    });
    await conn.connect();
    expect(conn.tools[0].description).toBe("");
  });

  it("handles missing inputSchema with default empty object schema", async () => {
    const conn = new McpConnection("schema-test", baseConfig({ command: "bin" }));
    const client = mockClientInstances[mockClientInstances.length - 1];
    client.listTools.mockResolvedValueOnce({
      tools: [{ name: "x", description: "d" }],
    });
    await conn.connect();
    expect(conn.tools[0].inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("handles missing tools array (undefined) gracefully", async () => {
    const conn = new McpConnection("undef-tools", baseConfig({ command: "bin" }));
    const client = mockClientInstances[mockClientInstances.length - 1];
    client.listTools.mockResolvedValueOnce({});
    await conn.connect();
    expect(conn.tools).toEqual([]);
  });

  it("rejects with a timeout error if connect hangs past timeoutMs", async () => {
    const conn = new McpConnection("hang", baseConfig({ command: "bin" }));
    const client = mockClientInstances[mockClientInstances.length - 1];
    // Make client.connect never resolve
    client.connect.mockReturnValueOnce(new Promise(() => {}));
    await expect(conn.connect(50)).rejects.toThrow(/timed out after 50ms/);
    expect(conn.connected).toBe(false);
  });
});

// ─── callTool() ───────────────────────────────────────────────────────────

describe("McpConnection — callTool()", () => {
  it("throws if not connected", async () => {
    const conn = new McpConnection("nc", baseConfig({ command: "bin" }));
    await expect(conn.callTool("echo", { x: 1 })).rejects.toThrow(/not connected/);
  });

  it("forwards name and arguments to client.callTool", async () => {
    const conn = new McpConnection("fwd", baseConfig({ command: "bin" }));
    await conn.connect();
    const client = mockClientInstances[mockClientInstances.length - 1];
    client.callTool.mockResolvedValueOnce({ content: [] });
    await conn.callTool("echo", { msg: "hi" });
    expect(client.callTool).toHaveBeenCalledWith({
      name: "echo",
      arguments: { msg: "hi" },
    });
  });

  it("joins multiple text content blocks with newlines", async () => {
    const conn = new McpConnection("join", baseConfig({ command: "bin" }));
    await conn.connect();
    const client = mockClientInstances[mockClientInstances.length - 1];
    client.callTool.mockResolvedValueOnce({
      content: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
        { type: "text", text: "line3" },
      ],
    });
    expect(await conn.callTool("echo", {})).toBe("line1\nline2\nline3");
  });

  it("filters out non-text content blocks", async () => {
    const conn = new McpConnection("filter", baseConfig({ command: "bin" }));
    await conn.connect();
    const client = mockClientInstances[mockClientInstances.length - 1];
    client.callTool.mockResolvedValueOnce({
      content: [
        { type: "text", text: "ok" },
        { type: "image", data: "..." },
        { type: "text", text: "ok2" },
      ],
    });
    expect(await conn.callTool("echo", {})).toBe("ok\nok2");
  });

  it("returns '(empty result)' when no text content", async () => {
    const conn = new McpConnection("empty", baseConfig({ command: "bin" }));
    await conn.connect();
    const client = mockClientInstances[mockClientInstances.length - 1];
    client.callTool.mockResolvedValueOnce({ content: [] });
    expect(await conn.callTool("echo", {})).toBe("(empty result)");
  });

  it("returns '(empty result)' when content has only non-text", async () => {
    const conn = new McpConnection("imageonly", baseConfig({ command: "bin" }));
    await conn.connect();
    const client = mockClientInstances[mockClientInstances.length - 1];
    client.callTool.mockResolvedValueOnce({ content: [{ type: "image", data: "x" }] });
    expect(await conn.callTool("echo", {})).toBe("(empty result)");
  });

  it("throws when isError=true and text is present", async () => {
    const conn = new McpConnection("err", baseConfig({ command: "bin" }));
    await conn.connect();
    const client = mockClientInstances[mockClientInstances.length - 1];
    client.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "something went wrong" }],
    });
    await expect(conn.callTool("bad", {})).rejects.toThrow("something went wrong");
  });

  it("throws with a generic message when isError=true and no text", async () => {
    const conn = new McpConnection("err2", baseConfig({ command: "bin" }));
    await conn.connect();
    const client = mockClientInstances[mockClientInstances.length - 1];
    client.callTool.mockResolvedValueOnce({ isError: true, content: [] });
    await expect(conn.callTool("bad", {})).rejects.toThrow(/returned an error/);
  });

  it("ignores text content without a string .text", async () => {
    const conn = new McpConnection("notstr", baseConfig({ command: "bin" }));
    await conn.connect();
    const client = mockClientInstances[mockClientInstances.length - 1];
    client.callTool.mockResolvedValueOnce({
      content: [{ type: "text" }, { type: "text", text: undefined }],
    });
    expect(await conn.callTool("echo", {})).toBe("(empty result)");
  });
});

// ─── disconnect() ─────────────────────────────────────────────────────────

describe("McpConnection — disconnect()", () => {
  it("is a no-op when not connected", async () => {
    const conn = new McpConnection("nc-disc", baseConfig({ command: "bin" }));
    await conn.disconnect();
    expect(mockClientInstances[0].close).not.toHaveBeenCalled();
  });

  it("calls client.close() once when connected", async () => {
    const conn = new McpConnection("disc", baseConfig({ command: "bin" }));
    await conn.connect();
    const client = mockClientInstances[mockClientInstances.length - 1];
    await conn.disconnect();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(conn.connected).toBe(false);
  });

  it("subsequent disconnect calls are no-ops", async () => {
    const conn = new McpConnection("disc2", baseConfig({ command: "bin" }));
    await conn.connect();
    const client = mockClientInstances[mockClientInstances.length - 1];
    await conn.disconnect();
    await conn.disconnect();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("swallows errors from client.close()", async () => {
    const conn = new McpConnection("swallow", baseConfig({ command: "bin" }));
    await conn.connect();
    const client = mockClientInstances[mockClientInstances.length - 1];
    client.close.mockRejectedValueOnce(new Error("boom"));
    await expect(conn.disconnect()).resolves.toBeUndefined();
    expect(conn.connected).toBe(false);
  });
});
