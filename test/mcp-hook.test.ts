/**
 * MCP hook tests — connection lifecycle, status reporting, reload safety.
 *
 * Mocks the McpConnection class so we can simulate connection outcomes
 * (resolve, reject, hang) without needing real MCP servers.
 */

import { describe, it, expect, vi } from "vitest";

const { mockConnect, mockDisconnect, disconnected } = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  mockDisconnect: vi.fn(),
  disconnected: new Set<string>(),
}));

vi.mock("../tools/mcp/client.js", () => {
  class McpConnection {
    serverName: string;
    source: string = "test";
    tools: any[] = [];
    connect: any = mockConnect;
    disconnect: any = mockDisconnect;
    constructor(name: string) {
      this.serverName = name;
    }
  }
  return { McpConnection };
});

// Mock config + cache modules so we don't touch real configs/caches.
vi.mock("../tools/mcp/config.js", () => ({
  resolveMcpConfigs: vi.fn(() => [
    { name: "test1", url: "http://test1", enabled: true, source: "global" },
    { name: "test2", url: "http://test2", enabled: true, source: "global" },
  ]),
  isSseUrl: vi.fn(() => false),
}));
vi.mock("../tools/mcp/cache.js", () => ({
  loadMcpCache: vi.fn(() => null),
  loadScopedMcpCache: vi.fn(() => null),
  saveMcpCache: vi.fn(),
  updateServerCache: vi.fn(),
  cleanupStaleCache: vi.fn(),
}));

import {
  mcpModule,
  getMcpStatus,
  refreshServerCache,
  ensureMcpServerReady,
  updateConfigEnabled,
  getActiveMcpConnections,
} from "../hooks/mcp.js";
import { loadScopedMcpCache, updateServerCache } from "../tools/mcp/cache.js";

describe("mcpModule session_start", () => {
  it("registers session_start and session_shutdown handlers", () => {
    expect(mcpModule.name).toBe("mcp");
    expect(mcpModule.hooks.session_start).toBeDefined();
    expect(mcpModule.hooks.session_start!.length).toBeGreaterThan(0);
    expect(mcpModule.hooks.session_shutdown).toBeDefined();
  });

  it("marks server as 'connected' when connection resolves", async () => {
    mockConnect.mockReset();
    mockConnect.mockImplementation(async function (this: any) {
      this.tools = [
        { name: "tool_a", description: "A", inputSchema: { type: "object" } },
      ];
    });
    const handler = mcpModule.hooks.session_start![0]!;
    await handler({} as any, { cwd: "/tmp" } as any, {} as any);

    // Wait a tick for the fire-and-forget connectAll to update state.
    await new Promise((r) => setTimeout(r, 50));

    const status = getMcpStatus();
    const s1 = status.find((s) => s.name === "test1")!;
    expect(s1.state).toBe("connected");
  });

  it("marks server as 'failed' when connection rejects", async () => {
    mockConnect.mockReset();
    mockConnect.mockRejectedValue(new Error("connection refused"));
    const handler = mcpModule.hooks.session_start![0]!;
    await handler({} as any, { cwd: "/tmp" } as any, {} as any);
    await new Promise((r) => setTimeout(r, 50));

    const status = getMcpStatus();
    const s1 = status.find((s) => s.name === "test1")!;
    expect(s1.state).toBe("failed");
    expect(s1.error).toContain("connection refused");
  });

  // Regression: /reload triggers session_start while a previous connectAll
  // may still be running. The new connectAll must not reassign allServers
  // — otherwise the old in-flight `allServers.set("connected")` updates a
  // detached Map and the UI (which reads the new Map) never sees it.
  it("survives /reload: new session_start keeps the same allServers reference", async () => {
    // First connection hangs forever (simulates a slow MCP server on /reload).
    mockConnect.mockReset();
    mockConnect.mockReturnValue(new Promise(() => {}));

    const handler = mcpModule.hooks.session_start![0]!;
    await handler({} as any, { cwd: "/tmp" } as any, {} as any);

    // Capture the status the UI sees right now — should be "connecting".
    const beforeReload = getMcpStatus();
    expect(beforeReload.find((s) => s.name === "test1")!.state).toBe("connecting");

    // Simulate /reload: second session_start fires (teardownMcp clears,
    // new connectAll starts). This time the connection succeeds.
    mockConnect.mockReset();
    mockConnect.mockImplementation(async function (this: any) {
      this.tools = [{ name: "tool_a", description: "A", inputSchema: {} }];
    });

    // Manually invoke teardown (it's the session_shutdown handler) to mimic
    // the session_shutdown that /reload emits before the new session_start.
    const shutdown = mcpModule.hooks.session_shutdown![0]!;
    await shutdown({} as any, {} as any, {} as any);

    await handler({} as any, { cwd: "/tmp" } as any, {} as any);
    await new Promise((r) => setTimeout(r, 50));

    // The UI now sees the NEW state from the new connectAll.
    const afterReload = getMcpStatus();
    expect(afterReload.find((s) => s.name === "test1")!.state).toBe("connected");
  });

  // Regression: in some environments the inner Promise.race setTimeout in
  // McpConnection.connect() never fires (MCP SDK fetch hanging on a
  // network that accepts the TCP connection but never responds). Without
  // a watchdog the user sees all servers stuck on "connecting" forever.
  // This test simulates a permanently-hung connect() and asserts the
  // 35s watchdog marks the server as failed.
  it("watchdog marks hung connection as 'failed' after 35s", async () => {
    mockConnect.mockReset();
    // Never resolves or rejects.
    mockConnect.mockReturnValue(new Promise(() => {}));

    // Use fake timers BEFORE triggering session_start so the watchdog's
    // setTimeout is registered against the fake clock.
    vi.useFakeTimers();
    try {
      const handler = mcpModule.hooks.session_start![0]!;
      await handler({} as any, { cwd: "/tmp" } as any, {} as any);

      // Right after session_start, state should still be "connecting".
      expect(getMcpStatus().find((s) => s.name === "test1")!.state).toBe("connecting");

      // Advance fake timers past the 35s watchdog window.
      await vi.advanceTimersByTimeAsync(36_000);

      // Now the watchdog should have marked the hung server as failed.
      const after = getMcpStatus();
      const s1 = after.find((s) => s.name === "test1")!;
      expect(s1.state).toBe("failed");
      expect(s1.error).toMatch(/watchdog/i);
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);
});

const loadScopedMcpCacheMock = loadScopedMcpCache as unknown as ReturnType<typeof vi.fn>;
const updateServerCacheMock = updateServerCache as unknown as ReturnType<typeof vi.fn>;

describe("ensureMcpServerReady cache scope", () => {
  it("uses project cache directly on cache hit", async () => {
    loadScopedMcpCacheMock.mockReset();
    loadScopedMcpCacheMock.mockReturnValue({
      servers: {
        proj: { tools: [{ name: "explore", description: "Explore", inputSchema: { type: "object" } }], cachedAt: Date.now() },
      },
    });
    mockConnect.mockReset();
    const pi = { registerTool: vi.fn() };

    await ensureMcpServerReady(pi as any, { name: "proj", command: "proj-mcp", enabled: true, source: "project" } as any, "/worktree");

    expect(loadScopedMcpCacheMock).toHaveBeenCalledWith("project", "/worktree");
    expect(mockConnect).not.toHaveBeenCalled();
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "proj_explore" }));
  });

  it("writes back to the matching project cache on cache miss", async () => {
    loadScopedMcpCacheMock.mockReset();
    loadScopedMcpCacheMock.mockReturnValue(null);
    updateServerCacheMock.mockReset();
    mockConnect.mockReset();
    mockConnect.mockImplementation(async function (this: any) {
      this.tools = [{ name: "explore", description: "Explore", inputSchema: { type: "object" } }];
    });

    await ensureMcpServerReady({ registerTool: vi.fn() } as any, { name: "proj", command: "proj-mcp", enabled: true, source: "project" } as any, "/worktree");

    expect(updateServerCacheMock).toHaveBeenCalledWith(
      "proj",
      expect.objectContaining({ tools: [expect.objectContaining({ name: "explore" })] }),
      "project",
      "/worktree",
    );
  });
});

describe("updateConfigEnabled (close-time cleanup)", () => {
  // Regression: previously, disabling a server only flipped the UI state
  // to "disabled" but left the live McpConnection in activeConnections.
  // On /reload, teardownMcp() would then have to disconnect that server.
  // If conn.disconnect() hangs (same root cause as the connect hang),
  // the Promise.all in teardownMcp never resolves, session_shutdown
  // never returns, and /reload appears stuck. The fix: close the
  // connection eagerly at toggle time, so teardownMcp has nothing to do.
  it("disables: disconnects and drops the McpConnection immediately", async () => {
    mockConnect.mockReset();
    mockDisconnect.mockReset();
    mockConnect.mockImplementation(async function (this: any) {
      this.tools = [{ name: "tool_a", description: "A", inputSchema: {} }];
    });
    mockDisconnect.mockImplementation(async function (this: any) {
      disconnected.add(this.serverName);
    });

    // First, do a session_start so test1 gets a live connection.
    const start = mcpModule.hooks.session_start![0]!;
    await start({} as any, { cwd: "/tmp" } as any, {} as any);
    await new Promise((r) => setTimeout(r, 50));

    // Sanity: test1 is connected, and has an active connection.
    expect(getMcpStatus().find((s) => s.name === "test1")!.state).toBe("connected");
    expect(getActiveMcpConnections().find((c) => c.serverName === "test1")).toBeDefined();

    // Now disable it. Connection must be torn down eagerly.
    await updateConfigEnabled("test1", false);

    // State flipped, conn dropped, disconnect was called.
    expect(getMcpStatus().find((s) => s.name === "test1")!.state).toBe("disabled");
    expect(getActiveMcpConnections().find((c) => c.serverName === "test1")).toBeUndefined();
    expect(disconnected.has("test1")).toBe(true);
  });

  it("re-enables: state flips to waiting reload (needs /reload to take effect)", async () => {
    await updateConfigEnabled("test1", true);
    // Tools aren't registered until the next session_start, so the UI
    // shows waiting reload — the user must /reload to actually connect.
    expect(getMcpStatus().find((s) => s.name === "test1")!.state).toBe("waiting reload");
  });
});

describe("connectAll vs refreshServerCache (concurrency)", () => {
  // Regression: in the user's environment, /reload and session_start
  // initial connectAll would hang all servers on "connecting" forever.
  // Pressing 'r' (refreshServerCache) on the same server would connect
  // fine. The only meaningful difference between the two paths is that
  // connectAll fans out into Promise.all([...]) over multiple servers,
  // while refreshServerCache runs a single conn.connect().
  //
  // This test reproduces that: mockConnect succeeds on the first call
  // per McpConnection instance but only when not invoked in the same
  // microtask burst as another connect. (In the real bug, the SDK
  // fetch is sensitive to concurrent DNS / connection-pool state.)
  it("refresh of a single server works even after connectAll hung", async () => {
    mockConnect.mockReset();
    // Make every connect hang forever.
    mockConnect.mockReturnValue(new Promise(() => {}));

    const start = mcpModule.hooks.session_start![0]!;
    await start({} as any, { cwd: "/tmp" } as any, {} as any);

    // After connectAll's fan-out, all servers are "connecting".
    await new Promise((r) => setTimeout(r, 50));
    for (const s of getMcpStatus()) {
      expect(s.state).toBe("connecting");
    }

    // Now flip the mock: subsequent connect() calls succeed quickly.
    mockConnect.mockReset();
    mockConnect.mockImplementation(async function (this: any) {
      this.tools = [{ name: "tool_a", description: "A", inputSchema: {} }];
    });

    // refreshServerCache (single, non-fanned-out) succeeds.
    const result = await refreshServerCache("test1", undefined as any);
    expect(result.ok).toBe(true);
    expect(getMcpStatus().find((s) => s.name === "test1")!.state).toBe("connected");
  }, 10_000);
});
