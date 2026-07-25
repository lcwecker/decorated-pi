/**
 * mcp — MCP connection lifecycle (session_start → connect, session_shutdown → disconnect).
 *
 * Tool registration is in tools/mcp/; this hook only manages the
 * activeConnections array and cache persistence.
 *
 * All runtime state lives on a McpRuntime instance. The module-level
 * `defaultRuntime` + thin-wrapper exports keep the old call sites
 * (tools/mcp/index.ts, commands/mcp-status.ts, index.ts) working
 * without injection plumbing. Tests that need isolation create their
 * own McpRuntime instance.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { McpConnection } from "../tools/mcp/client.js";
import { resolveMcpConfigs, type McpServerConfig } from "../tools/mcp/config.js";
import { loadMcpCache, loadScopedMcpCache, updateServerCache, cleanupStaleCache, type McpToolCache } from "../tools/mcp/cache.js";
import { buildMcpTool } from "../tools/mcp/tool-definition.js";
import type { Module, Skeleton } from "./skeleton.js";

interface ServerStatus {
  name: string;
  url: string;
  source: string;
  state: "connecting" | "connected" | "failed" | "disabled" | "waiting reload";
  toolCount: number;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  error?: string;
}

/** Narrow interface that commands/mcp-status.ts consumes. The full
 *  McpRuntime class implements this; tests can pass a stub. */
export interface McpStatusService {
  getStatus(): ServerStatus[];
  refresh(name: string, registry: unknown): Promise<{ ok: boolean; error?: string }>;
  setEnabled(name: string, enabled: boolean): Promise<void>;
}

/** Narrow interface that tools/mcp/index.ts consumes for live-connection
 *  lookup during tool execute(). */
export interface McpConnectionLookup {
  findConnection(serverName: string): McpConnection | undefined;
}

function cacheScopeForSource(source: string): "global" | "project" {
  return source === "project" ? "project" : "global";
}

function canUseServer(config: McpServerConfig, cwd?: string): boolean {
  if (!config.canUseInProject) return true;
  return config.canUseInProject(cwd ?? process.cwd());
}

/**
 * Owns all MCP runtime state for one extension load: active connections,
 * server status map, configs, cwd, and a generation counter for reload
 * cancellation. Each instance is isolated, so reloads and parallel
 * sessions cannot share or leak state.
 */
export class McpRuntime implements McpStatusService, McpConnectionLookup {
  private activeConnections: McpConnection[] = [];
  private readonly serverStatuses = new Map<string, ServerStatus>();
  private configs: McpServerConfig[] = [];
  private cwd = "";
  /** Monotonic session generation. Bumped on startSession/teardown.
   *  In-flight async work captures the generation at await boundaries
   *  and aborts itself if it no longer matches. */
  private generation = 0;

  // ─── session lifecycle ────────────────────────────────────────────────

  /** Start a new session: tear down the old state, bump generation so
   *  any in-flight connectAll/refresh/ensureReady from the previous
   *  session aborts itself, then install the new cwd + configs. */
  async startSession(cwd: string): Promise<void> {
    await this.teardown();
    this.cwd = cwd;
    this.configs = resolveMcpConfigs(cwd).sort((a, b) => a.name.localeCompare(b.name));
    this.generation += 1;
  }

  async teardown(): Promise<void> {
    this.generation += 1; // invalidate in-flight work
    const conns = this.activeConnections;
    this.activeConnections = [];
    this.serverStatuses.clear();
    this.configs = [];
    this.cwd = "";
    await Promise.all(
      conns.map(async (conn) => {
        try { await conn.disconnect(); } catch { /* ignore */ }
      }),
    );
  }

  private isCurrent(gen: number): boolean {
    return gen === this.generation;
  }

  // ─── read accessors ────────────────────────────────────────────────────

  findConnection(serverName: string): McpConnection | undefined {
    return this.activeConnections.find(c => c.serverName === serverName);
  }

  getConfigs(): McpServerConfig[] {
    return this.configs;
  }

  getCwd(): string {
    return this.cwd;
  }

  getStatus(): ServerStatus[] {
    const cache = loadMcpCache(this.cwd);
    const result: ServerStatus[] = [];
    for (const config of this.configs) {
      const connected = this.serverStatuses.get(config.name);
      if (connected) { result.push(connected); continue; }
      const cachedEntry = cache?.servers[config.name];
      // Not in serverStatuses: either disabled at startup (connectAll skipped it)
      // or was toggled enabled after startup and needs /reload.
      result.push({
        name: config.name, url: config.url ?? config.command ?? "(unknown)", source: config.source,
        state: config.enabled ? "waiting reload" : "disabled",
        toolCount: cachedEntry?.tools.length ?? 0, tools: cachedEntry?.tools ?? [],
      });
    }
    return result;
  }

  // ─── status mutation ──────────────────────────────────────────────────

  private markFailed(config: McpServerConfig, error: string): void {
    this.serverStatuses.set(config.name, {
      name: config.name,
      url: config.url ?? config.command ?? "(unknown)",
      source: config.source,
      state: "failed",
      toolCount: 0,
      tools: [],
      error,
    });
  }

  private markConnected(config: McpServerConfig, tools: McpToolCache[]): void {
    this.serverStatuses.set(config.name, {
      name: config.name,
      url: config.url ?? config.command ?? "(unknown)",
      source: config.source,
      state: "connected",
      toolCount: tools.length,
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }

  private markState(
    name: string,
    state: "disabled" | "waiting reload" | "connecting",
    config: { url?: string; command?: string; source: string } | undefined,
  ): void {
    this.serverStatuses.set(name, {
      name,
      url: config?.url ?? config?.command ?? "(unknown)",
      source: config?.source ?? "unknown",
      state,
      toolCount: 0,
      tools: [],
    });
  }

  // ─── connection management ────────────────────────────────────────────

  /** Connect all enabled configs that don't already have a live connection.
   *  Runs in the background from session_start; captures the generation
   *  so a /reload mid-connect causes the stale promise to abort cleanly. */
  async connectAll(
    configs: McpServerConfig[],
    registry: any,
    ctx?: any,
  ): Promise<{ schemaChanges: string[]; hasNewServer: boolean }> {
    const gen = this.generation;
    const cache = loadMcpCache(this.cwd);
    const schemaChanges: string[] = [];

    // Mutate in place — same trick as before, but now combined with
    // generation so a stale connectAll can't even reach the mutation.
    this.serverStatuses.clear();
    for (const s of configs) {
      this.markState(s.name, "connecting", s);
    }

    // Watchdog: the inner Promise.race in McpConnection.connect() has a
    // 30s setTimeout, but in some environments (MCP SDK fetch hanging,
    // event-loop pressure) that timer never fires and the connection
    // promise never settles. After 35s we force-mark any still-connecting
    // server as failed so the UI doesn't get stuck on "connecting" forever,
    // and we make connectAll() return so a subsequent /reload can start a
    // fresh connection attempt without racing a zombie Promise.all.
    let watchdogFired = false;
    const watchdog = new Promise<void>((resolve) => {
      setTimeout(() => {
        watchdogFired = true;
        if (!this.isCurrent(gen)) { resolve(); return; }
        for (const config of configs) {
          const server = this.serverStatuses.get(config.name);
          if (server && server.state === "connecting") {
            server.state = "failed";
            server.error = "Watchdog: connection did not settle within 35s (inner timeout missed)";
          }
        }
        resolve();
      }, 35_000);
    });

    // Connect SERIALLY, not via Promise.all. Three concurrent
    // conn.connect() calls in a Promise.all fan-out reliably hang in the
    // user's environment (likely the MCP SDK's HTTP transport is sensitive
    // to concurrent DNS / connection-pool state). refreshServerCache
    // (single, sequential) works fine — and pressing 'r' on a hung
    // server in the UI also recovers it, which is what pointed us here.
    let hasNewServer = false;
    for (const server of configs) {
      if (watchdogFired) break; // remaining servers are already failed
      if (!this.isCurrent(gen)) {
        // Session replaced mid-loop. Stop touching state; the new
        // session's connectAll owns the status map now.
        return { schemaChanges, hasNewServer };
      }

      if (!canUseServer(server, this.cwd || undefined)) {
        this.markFailed(server, "Project is missing required artefacts for this server");
        continue;
      }

      const conn = new McpConnection(server.name, server);
      conn.source = server.source;
      try {
        await conn.connect(30_000);
        // Session replaced while we were awaiting connect. Discard the
        // result so we don't pollute the new session's state.
        if (!this.isCurrent(gen)) {
          try { await conn.disconnect(); } catch { /* ignore */ }
          return { schemaChanges, hasNewServer };
        }
        if (watchdogFired) {
          try { await conn.disconnect(); } catch { /* ignore */ }
          return { schemaChanges, hasNewServer };
        }
        if (conn.tools.length === 0) {
          // Server connected but advertises no tools. Treat this as a
          // failed state and do NOT write an empty cache, otherwise a
          // subsequent /reload will keep using the empty cache forever.
          try { await conn.disconnect(); } catch { /* ignore */ }
          this.markFailed(server, "Server connected but returned no tools (e.g. codegraph without a .codegraph index)");
          continue;
        }
        this.activeConnections.push(conn);
        const actualTools = conn.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
        const cachedEntry = cache?.servers[server.name];
        if (cachedEntry && cachedEntry.tools.length > 0) {
          const cachedToolNames = new Set(cachedEntry.tools.map(t => t.name));
          const added = actualTools.filter(t => !cachedToolNames.has(t.name));
          const removed = cachedEntry.tools.filter(t => !cachedToolNames.has(t.name));
          const changed = actualTools.filter(t => {
            const cached = cachedEntry.tools.find(ct => ct.name === t.name);
            return cached && JSON.stringify(cached.inputSchema) !== JSON.stringify(t.inputSchema);
          });
          if (added.length > 0 || removed.length > 0 || changed.length > 0) {
            const parts: string[] = [];
            if (added.length) parts.push(`${added.length} added`);
            if (removed.length) parts.push(`${removed.length} removed`);
            if (changed.length) parts.push(`${changed.length} changed`);
            schemaChanges.push(`${server.name} (${parts.join(', ')})`);
          }
        }
        const tools: McpToolCache[] = conn.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
        this.markConnected(server, tools);
        updateServerCache(server.name, { tools, cachedAt: Date.now() }, cacheScopeForSource(server.source), this.cwd || undefined);
      } catch (err) {
        if (watchdogFired) return { schemaChanges, hasNewServer };
        if (!this.isCurrent(gen)) return { schemaChanges, hasNewServer };
        const msg = err instanceof Error ? err.message : String(err);
        this.markFailed(server, msg);
      }
    }

    // Watchdog is no longer raced with the work — the for-loop above is
    // already sequential and bounded by each conn.connect()'s own 30s
    // timeout. We still keep a 35s ceiling for any single server just in
    // case the inner timeout ever stops firing again.
    void watchdog;

    for (const server of configs) {
      const cachedEntry = cache?.servers[server.name];
      if (!cachedEntry || cachedEntry.tools.length === 0) { hasNewServer = true; break; }
    }
    return { schemaChanges, hasNewServer };
  }

  /** Re-connect a single server on user request ('r' in /mcp). Captures
   *  generation so a /reload mid-refresh aborts cleanly. */
  async refresh(name: string, registry: any): Promise<{ ok: boolean; error?: string }> {
    const gen = this.generation;
    const config = resolveMcpConfigs(this.cwd).find(s => s.name === name);
    if (!config) return { ok: false, error: `Server "${name}" not found in config.` };
    if (!canUseServer(config, this.cwd || undefined)) {
      const error = "Project is missing required artefacts for this server";
      this.markFailed(config, error);
      return { ok: false, error };
    }
    const existing = this.activeConnections.find(c => c.serverName === name);
    if (existing) {
      try { await existing.disconnect(); } catch { /* ignore */ }
      this.activeConnections = this.activeConnections.filter(c => c.serverName !== name);
    }
    const conn = new McpConnection(config.name, config);
    conn.source = config.source;
    try {
      await conn.connect(30_000);
      if (!this.isCurrent(gen)) {
        try { await conn.disconnect(); } catch { /* ignore */ }
        return { ok: false, error: "Session replaced" };
      }
      if (conn.tools.length === 0) {
        try { await conn.disconnect(); } catch { /* ignore */ }
        const error = "Server connected but returned no tools (e.g. codegraph without a .codegraph index)";
        this.markFailed(config, error);
        return { ok: false, error };
      }
      this.activeConnections.push(conn);
      const tools: McpToolCache[] = conn.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      this.markConnected(config, tools);
      updateServerCache(config.name, { tools, cachedAt: Date.now() }, cacheScopeForSource(config.source), this.cwd || undefined);
      return { ok: true };
    } catch (err) {
      if (!this.isCurrent(gen)) return { ok: false, error: "Session replaced" };
      const msg = err instanceof Error ? err.message : String(err);
      this.markFailed(config, msg);
      return { ok: false, error: msg };
    }
  }

  /** Toggle a server's enabled flag at runtime. Disabling tears down the
   *  live connection eagerly so teardown() on /reload doesn't hang on a
   *  zombie conn. */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const config = this.configs.find(c => c.name === name);
    if (config) config.enabled = enabled;

    if (!enabled) {
      // Tear down the live connection immediately so teardown() on
      // /reload doesn't have to deal with a zombie conn.
      const conn = this.activeConnections.find(c => c.serverName === name);
      if (conn) {
        try { await conn.disconnect(); } catch { /* ignore */ }
        this.activeConnections = this.activeConnections.filter(c => c.serverName !== name);
      }
      // Mark the server as disabled (or add it if absent).
      this.markState(name, "disabled", config ?? undefined);
      return;
    }

    // Re-enabling at runtime: the config is now enabled but tools aren't
    // registered until the next session_start. Mark it as waiting_reload
    // so the user sees exactly why the server isn't usable yet.
    this.markState(name, "waiting reload", config ?? undefined);
  }

  /** Ensure one MCP server is ready and its tools are registered with pi.
   *  Called from index.ts at load time for each enabled config.
   *
   *  Behavior:
   *    - Cache hit  → register tools from cache immediately (fast path).
   *    - Cache miss → connect synchronously, write the cache, then
   *      register the live tools.
   *    - Connection failure + no cache → no tools registered (per design).
   *
   *  Side effect: pushes a McpConnection into activeConnections so
   *  later `execute` calls (via buildMcpTool's findConnection callback)
   *  can find it.
   */
  async ensureServerReady(pi: ExtensionAPI, config: McpServerConfig, cwd?: string): Promise<void> {
    if (!canUseServer(config, cwd)) {
      this.markFailed(config, "Project is missing required artefacts for this server");
      return;
    }

    const gen = this.generation;
    const scope = cacheScopeForSource(config.source);
    const cache = loadScopedMcpCache(scope, cwd);
    const entry = cache?.servers[config.name];

    if (entry && entry.tools.length > 0) {
      for (const t of entry.tools) {
        try {
          pi.registerTool(buildMcpTool(config, t, (name) => this.findConnection(name)) as any);
        } catch { /* duplicate name; previous registration still in effect */ }
      }
      return;
    }

    if (this.activeConnections.find(c => c.serverName === config.name)) return;

    const conn = new McpConnection(config.name, config);
    conn.source = config.source;
    try {
      await conn.connect(30_000);
      if (!this.isCurrent(gen)) {
        // Session replaced while awaiting connect. Don't register tools
        // or mutate state — the new session owns both.
        try { await conn.disconnect(); } catch { /* ignore */ }
        return;
      }
      if (conn.tools.length === 0) {
        // Empty tool list means the server is not useful. Disconnect and
        // leave cache untouched so the next /reload retries the connection.
        try { await conn.disconnect(); } catch { /* ignore */ }
        this.markFailed(config, "Server connected but returned no tools (e.g. codegraph without a .codegraph index)");
        return;
      }
      this.activeConnections.push(conn);
      const tools: McpToolCache[] = conn.tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      this.markConnected(config, tools);
      updateServerCache(config.name, { tools, cachedAt: Date.now() }, scope, cwd);
      for (const t of tools) {
        try {
          pi.registerTool(buildMcpTool(config, t, (name) => this.findConnection(name)) as any);
        } catch { /* duplicate name */ }
      }
    } catch (err) {
      if (!this.isCurrent(gen)) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.markFailed(config, `No cache and initial connect failed: ${msg}`);
    }
  }
}

// ─── Module factory ──────────────────────────────────────────────────────

/** Build one isolated MCP module instance bound to a runtime. */
export function createMcpModule(runtime: McpRuntime): Module {
  return {
    name: "mcp",
    hooks: {
      session_start: [
        async (_event, ctx) => {
          await runtime.startSession(ctx.cwd);
          const configs = runtime.getConfigs();
          if (configs.length === 0) return;
          cleanupStaleCache(configs, runtime.getCwd());
          const enabledConfigs = configs.filter(s => s.enabled);

          // connectAll only needs to handle servers that weren't already
          // connected by index.ts's ensureServerReady. We don't
          // teardown first: the initial-sync connections are still
          // healthy and we don't want to disconnect + reconnect on
          // every session_start.
          const toConnect = enabledConfigs.filter(s => !runtime.findConnection(s.name));
          if (toConnect.length === 0) return;

          // connectAll runs in the background so the watchdog tests
          // that mock hung connections don't block session_start.
          //
          // Capture hasUI / notify synchronously: connectAll may resolve
          // after the session is replaced or reloaded, at which point `ctx`
          // is stale and its `hasUI` getter throws via assertActive.
          // Using the captured plain values avoids touching the stale ctx
          // in the .then callback.
          const hasUI = ctx.hasUI;
          const notify = ctx.ui?.notify?.bind(ctx.ui);
          void runtime.connectAll(toConnect, ctx.modelRegistry, ctx).then(({ schemaChanges }) => {
            if (schemaChanges.length > 0 && hasUI && notify) {
              notify(`mcp schema changed! please '/reload'`, "warning");
            }
          });
        },
      ],
      session_shutdown: [
        async () => { await runtime.teardown(); },
      ],
    },
  };
}

// ─── Module-level default runtime + thin-wrapper exports ─────────────────
//
// These keep tools/mcp/index.ts, commands/mcp-status.ts, and index.ts
// working without injection plumbing. They all delegate to a single
// module-level McpRuntime instance. Tests that need isolation create
// their own instance and call its methods directly.

const defaultRuntime = new McpRuntime();

export function getMcpStatus(): ServerStatus[] {
  return defaultRuntime.getStatus();
}

export async function refreshServerCache(serverName: string, registry: any): Promise<{ ok: boolean; error?: string }> {
  return defaultRuntime.refresh(serverName, registry);
}

export async function updateConfigEnabled(serverName: string, enabled: boolean): Promise<void> {
  return defaultRuntime.setEnabled(serverName, enabled);
}

export function getActiveMcpConnections(): McpConnection[] {
  // Return a snapshot so callers can't mutate internal state directly.
  return [...defaultRuntime["activeConnections"]];
}

export function getCachedMcpConfigs(): McpServerConfig[] {
  return defaultRuntime.getConfigs();
}

export async function ensureMcpServerReady(pi: ExtensionAPI, config: McpServerConfig, cwd?: string): Promise<void> {
  return defaultRuntime.ensureServerReady(pi, config, cwd);
}

export async function teardownMcp(): Promise<void> {
  return defaultRuntime.teardown();
}

/** @deprecated Use createMcpModule(runtime) for state isolation. */
export const mcpModule: Module = createMcpModule(defaultRuntime);

export function setupMcp(sk: Skeleton, _pi: ExtensionAPI): void {
  sk.register(mcpModule);
}
