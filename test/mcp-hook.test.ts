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
  McpRuntime,
  createMcpModule,
} from "../hooks/mcp.js";
import { loadMcpCache, loadScopedMcpCache, updateServerCache } from "../tools/mcp/cache.js";

// Each describe creates its own runtime + module so tests can't leak state.
function makeMcpModule() {
  const runtime = new McpRuntime();
  const mod = createMcpModule(runtime);
  return { runtime, mod };
}

describe("mcpModule session_start", () => {
  it("registers session_start and session_shutdown handlers", () => {
    const { mod } = makeMcpModule();
    expect(mod.name).toBe("mcp");
    expect(mod.hooks.session_start).toBeDefined();
    expect(mod.hooks.session_start!.length).toBeGreaterThan(0);
    expect(mod.hooks.session_shutdown).toBeDefined();
  });

  it("marks server as 'connected' when connection resolves", async () => {
    const { runtime, mod } = makeMcpModule();
    mockConnect.mockReset();
    mockConnect.mockImplementation(async function (this: any) {
      this.tools = [
        { name: "tool_a", description: "A", inputSchema: { type: "object" } },
      ];
    });
    const handler = mod.hooks.session_start![0]!;
    await handler({} as any, { cwd: "/tmp" } as any, {} as any);

    // Wait a tick for the fire-and-forget connectAll to update state.
    await new Promise((r) => setTimeout(r, 50));

    const status = runtime.getStatus();
    const s1 = status.find((s) => s.name === "test1")!;
    expect(s1.state).toBe("connected");
  });

  it("marks server as 'failed' when connection rejects", async () => {
    const { runtime, mod } = makeMcpModule();
    mockConnect.mockReset();
    mockConnect.mockRejectedValue(new Error("connection refused"));
    const handler = mod.hooks.session_start![0]!;
    await handler({} as any, { cwd: "/tmp" } as any, {} as any);
    await new Promise((r) => setTimeout(r, 50));

    const status = runtime.getStatus();
    const s1 = status.find((s) => s.name === "test1")!;
    expect(s1.state).toBe("failed");
    expect(s1.error).toContain("connection refused");
  });

  // Regression: /reload triggers session_start while a previous connectAll
  // may still be running. Generation cancellation makes the stale
  // connectAll abort itself instead of polluting the new session.
  it("survives /reload: new session_start is not polluted by stale connectAll", async () => {
    const { runtime, mod } = makeMcpModule();
    // First connection hangs forever (simulates a slow MCP server on /reload).
    mockConnect.mockReset();
    mockConnect.mockReturnValue(new Promise(() => {}));

    const handler = mod.hooks.session_start![0]!;
    await handler({} as any, { cwd: "/tmp" } as any, {} as any);

    // Capture the status the UI sees right now — should be "connecting".
    const beforeReload = runtime.getStatus();
    expect(beforeReload.find((s) => s.name === "test1")!.state).toBe("connecting");

    // Simulate /reload: second session_start fires (teardown clears,
    // new connectAll starts). This time the connection succeeds.
    mockConnect.mockReset();
    mockConnect.mockImplementation(async function (this: any) {
      this.tools = [{ name: "tool_a", description: "A", inputSchema: {} }];
    });

    // Manually invoke teardown (it's the session_shutdown handler) to mimic
    // the session_shutdown that /reload emits before the new session_start.
    const shutdown = mod.hooks.session_shutdown![0]!;
    await shutdown({} as any, {} as any, {} as any);

    await handler({} as any, { cwd: "/tmp" } as any, {} as any);
    await new Promise((r) => setTimeout(r, 50));

    // The UI now sees the NEW state from the new connectAll.
    const afterReload = runtime.getStatus();
    expect(afterReload.find((s) => s.name === "test1")!.state).toBe("connected");
  });

  // Regression: in some environments the inner Promise.race setTimeout in
  // McpConnection.connect() never fires (MCP SDK fetch hanging on a
  // network that accepts the TCP connection but never responds). Without
  // a watchdog the user sees all servers stuck on "connecting" forever.
  // This test simulates a permanently-hung connect() and asserts the
  // 35s watchdog marks the server as failed.
  it("watchdog marks hung connection as 'failed' after 35s", async () => {
    const { runtime, mod } = makeMcpModule();
    mockConnect.mockReset();
    // Never resolves or rejects.
    mockConnect.mockReturnValue(new Promise(() => {}));

    // Use fake timers BEFORE triggering session_start so the watchdog's
    // setTimeout is registered against the fake clock.
    vi.useFakeTimers();
    try {
      const handler = mod.hooks.session_start![0]!;
      await handler({} as any, { cwd: "/tmp" } as any, {} as any);

      // Right after session_start, state should still be "connecting".
      expect(runtime.getStatus().find((s) => s.name === "test1")!.state).toBe("connecting");

      // Advance fake timers past the 35s watchdog window.
      await vi.advanceTimersByTimeAsync(36_000);

      // Now the watchdog should have marked the hung server as failed.
      const after = runtime.getStatus();
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

describe("ensureServerReady cache scope", () => {
  it("uses project cache directly on cache hit", async () => {
    const { runtime } = makeMcpModule();
    loadScopedMcpCacheMock.mockReset();
    loadScopedMcpCacheMock.mockReturnValue({
      servers: {
        proj: { tools: [{ name: "explore", description: "Explore", inputSchema: { type: "object" } }], cachedAt: Date.now() },
      },
    });
    mockConnect.mockReset();
    const pi = { registerTool: vi.fn() };

    await runtime.ensureServerReady(pi as any, { name: "proj", command: "proj-mcp", enabled: true, source: "project" } as any, "/worktree");

    expect(loadScopedMcpCacheMock).toHaveBeenCalledWith("project", "/worktree");
    expect(mockConnect).not.toHaveBeenCalled();
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "proj_explore" }));
  });

  it("disconnects a failed cache-miss connection", async () => {
    const { runtime } = makeMcpModule();
    loadScopedMcpCacheMock.mockReset();
    loadScopedMcpCacheMock.mockReturnValue(null);
    mockConnect.mockReset();
    mockDisconnect.mockReset();
    mockConnect.mockRejectedValue(new Error("list tools failed"));
    mockDisconnect.mockResolvedValue(undefined);

    await runtime.ensureServerReady(
      { registerTool: vi.fn() } as any,
      { name: "proj", command: "proj-mcp", enabled: true, source: "project" } as any,
      "/worktree",
    );

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it("writes back to the matching project cache on cache miss", async () => {
    const { runtime } = makeMcpModule();
    loadScopedMcpCacheMock.mockReset();
    loadScopedMcpCacheMock.mockReturnValue(null);
    updateServerCacheMock.mockReset();
    mockConnect.mockReset();
    mockConnect.mockImplementation(async function (this: any) {
      this.tools = [{ name: "explore", description: "Explore", inputSchema: { type: "object" } }];
    });

    await runtime.ensureServerReady({ registerTool: vi.fn() } as any, { name: "proj", command: "proj-mcp", enabled: true, source: "project" } as any, "/worktree");

    expect(updateServerCacheMock).toHaveBeenCalledWith(
      "proj",
      expect.objectContaining({ tools: [expect.objectContaining({ name: "explore" })] }),
      "project",
      "/worktree",
    );
  });
});

describe("setEnabled (close-time cleanup)", () => {
  // Regression: previously, disabling a server only flipped the UI state
  // to "disabled" but left the live McpConnection in activeConnections.
  // On /reload, teardown() would then have to disconnect that server.
  // If conn.disconnect() hangs (same root cause as the connect hang),
  // the Promise.all in teardown never resolves, session_shutdown
  // never returns, and /reload appears stuck. The fix: close the
  // connection eagerly at toggle time, so teardown has nothing to do.
  it("disables: disconnects and drops the McpConnection immediately", async () => {
    const { runtime, mod } = makeMcpModule();
    mockConnect.mockReset();
    mockDisconnect.mockReset();
    mockConnect.mockImplementation(async function (this: any) {
      this.tools = [{ name: "tool_a", description: "A", inputSchema: {} }];
    });
    mockDisconnect.mockImplementation(async function (this: any) {
      disconnected.add(this.serverName);
    });

    // First, do a session_start so test1 gets a live connection.
    const start = mod.hooks.session_start![0]!;
    await start({} as any, { cwd: "/tmp" } as any, {} as any);
    await new Promise((r) => setTimeout(r, 50));

    // Sanity: test1 is connected, and has an active connection.
    expect(runtime.getStatus().find((s) => s.name === "test1")!.state).toBe("connected");
    expect(runtime.findConnection("test1")).toBeDefined();

    // Now disable it. Connection must be torn down eagerly.
    await runtime.setEnabled("test1", false);

    // State flipped, conn dropped, disconnect was called.
    expect(runtime.getStatus().find((s) => s.name === "test1")!.state).toBe("disabled");
    expect(runtime.findConnection("test1")).toBeUndefined();
    expect(disconnected.has("test1")).toBe(true);
  });

  it("re-enables: state flips to waiting reload (needs /reload to take effect)", async () => {
    const { runtime, mod } = makeMcpModule();
    // Run session_start so the runtime has configs loaded.
    const start = mod.hooks.session_start![0]!;
    await start({} as any, { cwd: "/tmp" } as any, {} as any);
    await new Promise((r) => setTimeout(r, 50));

    await runtime.setEnabled("test1", true);
    // Tools aren't registered until the next session_start, so the UI
    // shows waiting reload — the user must /reload to actually connect.
    expect(runtime.getStatus().find((s) => s.name === "test1")!.state).toBe("waiting reload");
  });
});

describe("connectAll vs refresh (concurrency)", () => {
  // Regression: in the user's environment, /reload and session_start
  // initial connectAll would hang all servers on "connecting" forever.
  // Pressing 'r' (refresh) on the same server would connect
  // fine. The only meaningful difference between the two paths is that
  // connectAll fans out into Promise.all([...]) over multiple servers,
  // while refresh runs a single conn.connect().
  //
  // This test reproduces that: mockConnect succeeds on the first call
  // per McpConnection instance but only when not invoked in the same
  // microtask burst as another connect. (In the real bug, the SDK
  // fetch is sensitive to concurrent DNS / connection-pool state.)
  it("refresh of a single server works even after connectAll hung", async () => {
    const { runtime, mod } = makeMcpModule();
    mockConnect.mockReset();
    // Make every connect hang forever.
    mockConnect.mockReturnValue(new Promise(() => {}));

    const start = mod.hooks.session_start![0]!;
    await start({} as any, { cwd: "/tmp" } as any, {} as any);

    // After connectAll's fan-out, all servers are "connecting".
    await new Promise((r) => setTimeout(r, 50));
    for (const s of runtime.getStatus()) {
      expect(s.state).toBe("connecting");
    }

    // Now flip the mock: subsequent connect() calls succeed quickly.
    mockConnect.mockReset();
    mockConnect.mockImplementation(async function (this: any) {
      this.tools = [{ name: "tool_a", description: "A", inputSchema: {} }];
    });

    // refresh (single, non-fanned-out) succeeds.
    const result = await runtime.refresh("test1", undefined as any);
    expect(result.ok).toBe(true);
    expect(runtime.getStatus().find((s) => s.name === "test1")!.state).toBe("connected");
  }, 10_000);
});

// ─── Regression: stale ctx after session replacement ───────────────────────
//
// connectAll runs fire-and-forget in the session_start handler. If the
// session is replaced (new/resume/fork) or reloaded while a connection
// is still in flight, the captured `ctx` is stale by the time `.then`
// runs. Accessing `ctx.hasUI` throws via assertActive, which used to
// crash pi as an uncaughtException.
describe("mcpModule session_start — stale ctx in background connectAll", () => {
  it("does not throw uncaught when ctx goes stale before .then runs", async () => {
    const { runtime, mod } = makeMcpModule();
    // Cache has an old tool list for test1; the new connection returns a
    // different list → schemaChanges.length > 0 → the .then body runs.
    vi.mocked(loadMcpCache).mockReturnValueOnce({
      servers: {
        test1: {
          tools: [{ name: "tool_old", description: "old", inputSchema: {} }],
          cachedAt: 1,
        },
      },
    } as any);

    mockConnect.mockReset();
    mockConnect.mockImplementation(async function (this: any) {
      this.tools = [{ name: "tool_a", description: "A", inputSchema: {} }];
    });

    // Simulate the real lifecycle: ctx is live during the synchronous
    // part of session_start, then goes stale while the background
    // connectAll is still in flight. hasUI returns true synchronously,
    // throws after `goStale()` flips the switch.
    let stale = false;
    const staleError = new Error(
      "This extension ctx is stale after session replacement or reload.",
    );
    const staleCtx = {
      cwd: "/tmp",
      modelRegistry: {},
      get hasUI() { if (stale) throw staleError; return true; },
      ui: { notify: vi.fn() },
    };

    // Capture unhandled rejections so the test process doesn't crash.
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => { unhandled.push(err); };
    process.on("unhandledRejection", onUnhandled);

    try {
      const handler = mod.hooks.session_start![0]!;
      await handler({} as any, staleCtx as any, {} as any);

      // Session replacement happens here: the synchronous part of
      // session_start already captured hasUI=true, but the background
      // connectAll is still running. Flip ctx to stale so that when
      // .then runs, accessing ctx.hasUI would throw.
      stale = true;

      // Let the fire-and-forget connectAll + .then settle.
      await new Promise((r) => setTimeout(r, 80));

      // The .then body must not touch the stale ctx. If it did, the
      // assertActive throw would surface as an unhandled rejection and
      // crash pi (the original bug).
      expect(unhandled).toEqual([]);
      // Verify the runtime is functional and the connect succeeded.
      expect(runtime.getStatus().find((s) => s.name === "test1")!.state).toBe("connected");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("McpRuntime generation cancellation", () => {
  async function connectRuntime(runtime: McpRuntime, cwd = "/old") {
    mockConnect.mockReset();
    mockDisconnect.mockReset();
    mockConnect.mockImplementation(async function (this: any) {
      this.tools = [{ name: "tool", description: "", inputSchema: {} }];
    });
    await runtime.startSession(cwd);
    await runtime.connectAll(runtime.getConfigs(), undefined);
  }

  it("a stale overlapping startSession cannot overwrite the newer cwd", async () => {
    const runtime = new McpRuntime();
    await connectRuntime(runtime);

    let releaseDisconnect!: () => void;
    let firstDisconnect = true;
    mockDisconnect.mockImplementation(() => {
      if (!firstDisconnect) return Promise.resolve();
      firstDisconnect = false;
      return new Promise<void>((resolve) => { releaseDisconnect = resolve; });
    });

    const staleStart = runtime.startSession("/stale");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await runtime.startSession("/current")).toBe(true);

    releaseDisconnect();
    expect(await staleStart).toBe(false);
    expect(runtime.getCwd()).toBe("/current");
  });

  it("stale refresh cannot remove a new session's same-name connection", async () => {
    const runtime = new McpRuntime();
    await connectRuntime(runtime);

    let releaseDisconnect!: () => void;
    let firstDisconnect = true;
    mockDisconnect.mockImplementation(() => {
      if (!firstDisconnect) return Promise.resolve();
      firstDisconnect = false;
      return new Promise<void>((resolve) => { releaseDisconnect = resolve; });
    });

    const staleRefresh = runtime.refresh("test1", undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.startSession("/new");
    await runtime.connectAll(runtime.getConfigs(), undefined);
    const newConnection = runtime.findConnection("test1");

    releaseDisconnect();
    expect(await staleRefresh).toEqual({ ok: false, error: "Session replaced" });
    expect(runtime.findConnection("test1")).toBe(newConnection);
    expect(runtime.getStatus().find((s) => s.name === "test1")!.state).toBe("connected");
  });

  it("stale disable cannot remove or overwrite a new session's connection", async () => {
    const runtime = new McpRuntime();
    await connectRuntime(runtime);

    let releaseDisconnect!: () => void;
    let firstDisconnect = true;
    mockDisconnect.mockImplementation(() => {
      if (!firstDisconnect) return Promise.resolve();
      firstDisconnect = false;
      return new Promise<void>((resolve) => { releaseDisconnect = resolve; });
    });

    const staleDisable = runtime.setEnabled("test1", false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.startSession("/new");
    await runtime.connectAll(runtime.getConfigs(), undefined);
    const newConnection = runtime.findConnection("test1");

    releaseDisconnect();
    await staleDisable;
    expect(runtime.findConnection("test1")).toBe(newConnection);
    expect(runtime.getStatus().find((s) => s.name === "test1")!.state).toBe("connected");
  });

  it("disconnects a connection whose connect attempt rejects", async () => {
    const runtime = new McpRuntime();
    await runtime.startSession("/tmp");
    mockConnect.mockReset();
    mockDisconnect.mockReset();
    mockConnect.mockRejectedValue(new Error("list tools failed"));
    mockDisconnect.mockResolvedValue(undefined);

    await runtime.connectAll(runtime.getConfigs(), undefined);

    expect(mockDisconnect).toHaveBeenCalled();
    expect(runtime.getStatus().find((s) => s.name === "test1")!.state).toBe("failed");
  });

  it("teardown stops waiting after the disconnect timeout", async () => {
    const runtime = new McpRuntime();
    await connectRuntime(runtime);
    mockDisconnect.mockReset();
    mockDisconnect.mockReturnValue(new Promise(() => {}));

    vi.useFakeTimers();
    try {
      const teardown = runtime.teardown();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(teardown).resolves.toBeUndefined();
      expect(runtime.getStatus()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // When /reload fires session_start while an old connectAll is still
  // awaiting conn.connect(), the old promise must not pollute the new
  // session's state once it resolves. Generation cancellation makes the
  // stale connectAll abort itself.
  it("stale connectAll does not pollute new session after reload", async () => {
    const runtime = new McpRuntime();
    const mod = createMcpModule(runtime);

    // Track the old connect promise so we can resolve it later.
    let oldConnectResolve: () => void = () => {};
    mockConnect.mockReset();
    mockConnect.mockReturnValue(new Promise<void>((resolve) => {
      oldConnectResolve = resolve;
    }));

    // First session_start — connectAll hangs on the old connect.
    const start = mod.hooks.session_start![0]!;
    await start({} as any, { cwd: "/tmp" } as any, {} as any);
    await new Promise((r) => setTimeout(r, 30));
    expect(runtime.getStatus().find((s) => s.name === "test1")!.state).toBe("connecting");

    // Reload: teardown + new session_start. Bumps generation.
    await runtime.teardown();
    // New connectAll uses a fast mock that succeeds.
    mockConnect.mockReset();
    mockConnect.mockImplementation(async function (this: any) {
      this.tools = [{ name: "tool_new", description: "new", inputSchema: {} }];
    });
    await runtime.startSession("/tmp");
    await mod.hooks.session_start![0]!({} as any, { cwd: "/tmp" } as any, {} as any);
    await new Promise((r) => setTimeout(r, 50));

    // New session is connected with the NEW tool.
    const status = runtime.getStatus();
    expect(status.find((s) => s.name === "test1")!.state).toBe("connected");
    expect(runtime.findConnection("test1")!.tools[0].name).toBe("tool_new");

    // Now let the OLD connect resolve. It must NOT overwrite the new state.
    oldConnectResolve();
    await new Promise((r) => setTimeout(r, 50));

    // State is still the new session's, not corrupted by the stale promise.
    expect(runtime.getStatus().find((s) => s.name === "test1")!.state).toBe("connected");
    expect(runtime.findConnection("test1")!.tools[0].name).toBe("tool_new");
  }, 10_000);
});
