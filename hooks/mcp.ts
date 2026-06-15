/**
 * mcp — MCP connection lifecycle (session_start → connect, session_shutdown → disconnect).
 *
 * Tool registration is in tools/mcp/; this hook only manages the
 * activeConnections array and cache persistence.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { McpConnection } from "../tools/mcp/client.js";
import { resolveMcpConfigs, type McpServerConfig } from "../tools/mcp/config.js";
import { loadMcpCache, loadScopedMcpCache, updateServerCache, cleanupStaleCache, type McpToolCache } from "../tools/mcp/cache.js";
import { buildMcpTool } from "../tools/mcp/tool-definition.js";
import type { Module, Skeleton } from "./skeleton.js";

let activeConnections: McpConnection[] = [];
let allServers = new Map<string, any>();
let cachedConfigs: McpServerConfig[] = [];
let cachedCwd = "";

interface ServerStatus {
  name: string;
  url: string;
  source: string;
  state: "connecting" | "connected" | "failed" | "disabled" | "waiting reload";
  toolCount: number;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  error?: string;
}

function cacheScopeForSource(source: string): "global" | "project" {
  return source === "project" ? "project" : "global";
}

function canUseServer(config: McpServerConfig, cwd?: string): boolean {
  if (!config.canUseInProject) return true;
  return config.canUseInProject(cwd ?? process.cwd());
}

function markServerFailed(config: McpServerConfig, error: string): void {
  allServers.set(config.name, {
    name: config.name,
    url: config.url ?? config.command ?? "(unknown)",
    source: config.source,
    state: "failed",
    toolCount: 0,
    tools: [],
    error,
  });
}

function markServerConnected(config: McpServerConfig, tools: McpToolCache[]): void {
  allServers.set(config.name, {
    name: config.name,
    url: config.url ?? config.command ?? "(unknown)",
    source: config.source,
    state: "connected",
    toolCount: tools.length,
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  });
}

function markServerState(
  name: string,
  state: "disabled" | "waiting reload" | "connecting",
  config: { url?: string; command?: string; source: string } | undefined,
): void {
  allServers.set(name, {
    name,
    url: config?.url ?? config?.command ?? "(unknown)",
    source: config?.source ?? "unknown",
    state,
    toolCount: 0,
    tools: [],
  });
}


async function connectAll(
  configs: McpServerConfig[],
  registry: any,
  ctx?: any,
): Promise<{ schemaChanges: string[]; hasNewServer: boolean }> {
  const cache = loadMcpCache(cachedCwd);
  const schemaChanges: string[] = [];

  // IMPORTANT: do NOT reassign `allServers`. After /reload, multiple
  // connectAll calls can race — if the new one reassigns, the old
  // in-flight connections' `allServers.set("connected")` updates a
  // detached Map that the UI never reads. Mutate in place instead so
  // every caller's updates are visible.
  allServers.clear();
  for (const s of configs) {
    markServerState(s.name, "connecting", s);
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
      for (const config of configs) {
        const server = allServers.get(config.name);
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

    if (!canUseServer(server, cachedCwd || undefined)) {
      markServerFailed(server, "Project is missing required artefacts for this server");
      continue;
    }

    const conn = new McpConnection(server.name, server);
    conn.source = server.source;
    try {
      await conn.connect(30_000);
      if (watchdogFired) {
        try { await conn.disconnect(); } catch { /* ignore */ }
        return { schemaChanges, hasNewServer };
      }
      if (conn.tools.length === 0) {
        // Server connected but advertises no tools. Treat this as a
        // failed state and do NOT write an empty cache, otherwise a
        // subsequent /reload will keep using the empty cache forever.
        try { await conn.disconnect(); } catch { /* ignore */ }
        markServerFailed(server, "Server connected but returned no tools (e.g. codegraph without a .codegraph index)");
        continue;
      }
      activeConnections.push(conn);
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
      markServerConnected(server, tools);
      updateServerCache(server.name, { tools, cachedAt: Date.now() }, cacheScopeForSource(server.source), cachedCwd || undefined);
    } catch (err) {
      if (watchdogFired) return { schemaChanges, hasNewServer };
      const msg = err instanceof Error ? err.message : String(err);
      markServerFailed(server, msg);
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

export function getMcpStatus(): ServerStatus[] {
  const cache = loadMcpCache(cachedCwd);
  const result: ServerStatus[] = [];
  for (const config of cachedConfigs) {
    const connected = allServers.get(config.name);
    if (connected) { result.push(connected); continue; }
    const cachedEntry = cache?.servers[config.name];
    // Not in allServers: either disabled at startup (connectAll skipped it)
    // or was toggled enabled after startup and needs /reload.
    result.push({
      name: config.name, url: config.url ?? config.command ?? "(unknown)", source: config.source,
      state: config.enabled ? "waiting reload" : "disabled",
      toolCount: cachedEntry?.tools.length ?? 0, tools: cachedEntry?.tools ?? [],
    });
  }
  return result;
}

export async function updateConfigEnabled(serverName: string, enabled: boolean): Promise<void> {
  const config = cachedConfigs.find(c => c.name === serverName);
  if (config) config.enabled = enabled;

  if (!enabled) {
    // Tear down the live connection immediately so teardownMcp() on
    // /reload doesn't have to deal with a zombie conn.
    const conn = activeConnections.find(c => c.serverName === serverName);
    if (conn) {
      try { await conn.disconnect(); } catch { /* ignore */ }
      activeConnections = activeConnections.filter(c => c.serverName !== serverName);
    }
    // Mark the server as disabled in allServers (or add it if absent).
    markServerState(serverName, "disabled", config ?? undefined);
    return;
  }

  // Re-enabling at runtime: the config is now enabled but tools aren't
  // registered until the next session_start. Mark it as waiting_reload
  // so the user sees exactly why the server isn't usable yet.
  markServerState(serverName, "waiting reload", config ?? undefined);
}

export async function refreshServerCache(serverName: string, registry: any): Promise<{ ok: boolean; error?: string }> {
  const config = resolveMcpConfigs(cachedCwd).find(s => s.name === serverName);
  if (!config) return { ok: false, error: `Server "${serverName}" not found in config.` };
  if (!canUseServer(config, cachedCwd || undefined)) {
    const error = "Project is missing required artefacts for this server";
    markServerFailed(config, error);
    return { ok: false, error };
  }
  const existing = activeConnections.find(c => c.serverName === serverName);
  if (existing) {
    try { await existing.disconnect(); } catch { /* ignore */ }
    activeConnections = activeConnections.filter(c => c.serverName !== serverName);
  }
  const conn = new McpConnection(config.name, config);
  conn.source = config.source;
  try {
    await conn.connect(30_000);
    if (conn.tools.length === 0) {
      try { await conn.disconnect(); } catch { /* ignore */ }
      const error = "Server connected but returned no tools (e.g. codegraph without a .codegraph index)";
      markServerFailed(config, error);
      return { ok: false, error };
    }
    activeConnections.push(conn);
    const tools: McpToolCache[] = conn.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    markServerConnected(config, tools);
    updateServerCache(config.name, { tools, cachedAt: Date.now() }, cacheScopeForSource(config.source), cachedCwd || undefined);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markServerFailed(config, msg);
    return { ok: false, error: msg };
  }
}

export function getActiveMcpConnections(): McpConnection[] {
  return activeConnections;
}

export function getCachedMcpConfigs(): McpServerConfig[] {
  return cachedConfigs;
}

/**
 * Ensure one MCP server is ready and its tools are registered with pi.
 *
 * Behavior:
 *   - Cache hit  → register tools from cache immediately (fast path).
 *   - Cache miss → connect synchronously, write the cache, then
 *     register the live tools.
 *   - Connection failure + no cache → no tools registered (per design).
 *
 * Side effect: pushes a McpConnection into `activeConnections` so
 * later `execute` calls (via buildMcpTool's findConnection callback)
 * can find it.
 */
export async function ensureMcpServerReady(pi: ExtensionAPI, config: McpServerConfig, cwd?: string): Promise<void> {
  if (!canUseServer(config, cwd)) {
    markServerFailed(config, "Project is missing required artefacts for this server");
    return;
  }

  const scope = cacheScopeForSource(config.source);
  const cache = loadScopedMcpCache(scope, cwd);
  const entry = cache?.servers[config.name];
  const findConnection = (name: string) => activeConnections.find(c => c.serverName === name);

  if (entry && entry.tools.length > 0) {
    for (const t of entry.tools) {
      try {
        pi.registerTool(buildMcpTool(config, t, findConnection) as any);
      } catch { /* duplicate name; previous registration still in effect */ }
    }
    return;
  }

  if (activeConnections.find(c => c.serverName === config.name)) return;

  const conn = new McpConnection(config.name, config);
  conn.source = config.source;
  try {
    await conn.connect(30_000);
    if (conn.tools.length === 0) {
      // Empty tool list means the server is not useful. Disconnect and
      // leave cache untouched so the next /reload retries the connection.
      try { await conn.disconnect(); } catch { /* ignore */ }
      markServerFailed(config, "Server connected but returned no tools (e.g. codegraph without a .codegraph index)");
      return;
    }
    activeConnections.push(conn);
    const tools: McpToolCache[] = conn.tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    markServerConnected(config, tools);
    updateServerCache(config.name, { tools, cachedAt: Date.now() }, scope, cwd);
    for (const t of tools) {
      try {
        pi.registerTool(buildMcpTool(config, t, findConnection) as any);
      } catch { /* duplicate name */ }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markServerFailed(config, `No cache and initial connect failed: ${msg}`);
  }
}

export const mcpModule: Module = {
  name: "mcp",
  hooks: {
    session_start: [
      async (_event, ctx) => {
        await teardownMcp();
        cachedCwd = ctx.cwd;
        const configs = resolveMcpConfigs(ctx.cwd).sort((a, b) => a.name.localeCompare(b.name));
        cachedConfigs = configs;
        if (configs.length === 0) return;
        cleanupStaleCache(configs, cachedCwd);
        const enabledConfigs = configs.filter(s => s.enabled);

        // connectAll only needs to handle servers that weren't already
        // connected by index.ts's ensureMcpServerReady. We don't
        // teardown first: the initial-sync connections are still
        // healthy and we don't want to disconnect + reconnect on
        // every session_start.
        const toConnect = enabledConfigs.filter(s => !activeConnections.find(c => c.serverName === s.name));
        if (toConnect.length === 0) return;

        // connectAll runs in the background so the watchdog tests
        // that mock hung connections don't block session_start.
        void connectAll(toConnect, ctx.modelRegistry, ctx).then(({ schemaChanges }) => {
          if (schemaChanges.length > 0 && ctx.hasUI) {
            ctx.ui.notify(`mcp schema changed! please '/reload'`, "warning");
          }
        });
      },
    ],
    session_shutdown: [
      async () => { await teardownMcp(); },
    ],
  },
};

export async function teardownMcp(): Promise<void> {
  await Promise.all(
    activeConnections.map(async (conn) => {
      try { await conn.disconnect(); } catch { /* ignore */ }
    }),
  );
  activeConnections = [];
  allServers.clear();
  cachedConfigs = [];
}

export function setupMcp(sk: Skeleton, _pi: ExtensionAPI): void {
  sk.register(mcpModule);
}
