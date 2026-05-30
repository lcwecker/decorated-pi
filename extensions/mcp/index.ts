import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { McpConnection } from "./client.js";
import {
  resolveMcpConfigs,
  loadMcpCache, updateServerCache, cleanupStaleCache,
  type McpServerConfig, type McpToolCache,
} from "./builtin.js";

export interface McpServerStatus {
  name: string;
  url: string;
  source: string;
  state: "connecting" | "connected" | "failed" | "disabled";
  toolCount: number;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  error?: string;
}

let activeConnections: McpConnection[] = [];
let allServers = new Map<string, McpServerStatus>();
let cachedConfigs: McpServerConfig[] = [];
let connectPromise: Promise<void> | null = null;
let cachedCwd = "";

const MCP_RESULT_FOLD_LINES = 45;

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return lines.slice(0, end);
}

function collapseMcpText(text: string, maxLines = MCP_RESULT_FOLD_LINES) {
  const lines = trimTrailingEmptyLines(text.split("\n"));
  const totalLines = lines.length;
  const displayLines = lines.slice(0, maxLines);
  const remainingLines = Math.max(0, totalLines - maxLines);
  return { totalLines, displayLines, remainingLines };
}

function getTextContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((c): c is { type: "text"; text?: string } => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function formatMcpResultText(text: string, expanded: boolean, theme: any): string {
  const { totalLines, displayLines, remainingLines } = collapseMcpText(
    text,
    expanded ? Number.MAX_SAFE_INTEGER : MCP_RESULT_FOLD_LINES,
  );
  let rendered = displayLines.join("\n") ? theme.fg("toolOutput", displayLines.join("\n")) : "";
  if (!expanded && remainingLines > 0) {
    rendered += `${theme.fg("muted", `\n... (${remainingLines} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")})`;
  }
  return rendered;
}

function renderMcpResult(result: any, options: { expanded: boolean }, theme: any, context: any) {
  const component = context.lastComponent ?? new Text("", 0, 0);
  component.setText(formatMcpResultText(getTextContent(result), options.expanded, theme));
  return component;
}

// ── config helpers ────────────────────────────────────────────────────────

export function updateConfigEnabled(serverName: string, enabled: boolean): void {
  const config = cachedConfigs.find(c => c.name === serverName);
  if (config) config.enabled = enabled;
  const server = allServers.get(serverName);
  if (server) {
    if (!enabled) {
      // Stash the real connection state, set to disabled
      server.state = "disabled";
    } else {
      // Re-enable: if there's still an active connection, restore it
      const conn = activeConnections.find(c => c.serverName === serverName);
      server.state = conn ? "connected" : "connecting";
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

function makeToolName(serverName: string, toolName: string): string {
  return `${serverName}_${toolName}`;
}

function makeToolLabel(serverName: string, toolName: string, desc?: string): string {
  return `MCP ${serverName}: ${toolName}${desc ? ` (${desc.slice(0, 20)})` : ""}`;
}

// ── cache helpers ─────────────────────────────────────────────────────────

function cacheScopeForSource(source: string): "global" | "project" {
  return source === "project" ? "project" : "global";
}

// ── register cached tools ─────────────────────────────────────────────────

function registerCachedTools(pi: ExtensionAPI, configs: McpServerConfig[]): void {
  const cache = loadMcpCache(cachedCwd);
  if (!cache) return;

  for (const config of configs) {
    if (!config.enabled) continue;
    const entry = cache.servers[config.name];
    if (!entry || entry.tools.length === 0) continue;

    for (const t of entry.tools) {
      const toolName = makeToolName(config.name, t.name);
      const desc = t.description || `${t.name} (MCP tool)`;
      pi.registerTool({
        name: toolName,
        label: makeToolLabel(config.name, t.name, t.description),
        description: desc,
        promptSnippet: desc || `MCP tool ${config.name}/${t.name}`,
        renderResult: renderMcpResult,
        parameters: t.inputSchema,
        execute: async (_id, params, _signal, _update, _ctx) => {
          const conn = activeConnections.find(c => c.serverName === config.name);
          if (!conn) {
            return {
              content: [{ type: "text", text: `MCP server "${config.name}" is not connected.` }],
              isError: true,
              details: {},
            };
          }
          try {
            const text = await conn.callTool(t.name, params as Record<string, unknown>);
            return { content: [{ type: "text", text }], isError: false, details: {} };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text", text: `MCP call failed on "${config.name}/${t.name}": ${msg}` }],
              isError: true,
              details: {},
            };
          }
        },
      });
    }
  }
}

// ── connect ───────────────────────────────────────────────────────────────

async function connectAll(configs: McpServerConfig[], ui?: { notify: (msg: string, type: string) => void }): Promise<void> {
  // Load current cache for comparison
  const cache = loadMcpCache(cachedCwd);
  const schemaChanges: string[] = [];

  allServers = new Map(
    configs.map((s) => [
      s.name,
      {
        name: s.name,
        url: s.url ?? s.command ?? "(unknown)",
        source: s.source,
        state: "connecting" as const,
        toolCount: 0,
        tools: [],
      },
    ]),
  );

  connectPromise = Promise.all(
    configs.map(async (server) => {
      const conn = new McpConnection(server.name, server);
      conn.source = server.source;

      try {
        await conn.connect(30_000);
        activeConnections.push(conn);

        const actualTools = conn.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));

        // Check if schema changed
        const cachedEntry = cache?.servers[server.name];
        if (cachedEntry && cachedEntry.tools.length > 0) {
          const cachedToolNames = new Set(cachedEntry.tools.map(t => t.name));
          const actualToolNames = new Set(actualTools.map(t => t.name));
          const added = actualTools.filter(t => !cachedToolNames.has(t.name));
          const removed = cachedEntry.tools.filter(t => !actualToolNames.has(t.name));
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

        allServers.set(server.name, {
          name: server.name,
          url: server.url ?? server.command ?? "(unknown)",
          source: server.source,
          state: "connected",
          toolCount: conn.tools.length,
          tools: actualTools,
        });

        // Update cache with this server's tools
        const tools: McpToolCache[] = conn.tools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        updateServerCache(
          server.name,
          { tools, cachedAt: Date.now() },
          cacheScopeForSource(server.source),
          cachedCwd || undefined,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allServers.set(server.name, {
          name: server.name,
          url: server.url ?? server.command ?? "(unknown)",
          source: server.source,
          state: "failed",
          toolCount: 0,
          tools: [],
          error: msg,
        });
      }
    }),
  ).then(() => undefined);

  await connectPromise;
  connectPromise = null;

  // Notify about schema changes
  if (schemaChanges.length > 0 && ui) {
    ui.notify(`MCP schema updated: ${schemaChanges.join('; ')}. Run /reload to apply.`, "warning");
  }
}

// ── setup ─────────────────────────────────────────────────────────────────

export function setupMcp(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    await teardownMcp();
    cachedCwd = ctx.cwd;

    const configs = resolveMcpConfigs(ctx.cwd).sort((a, b) => a.name.localeCompare(b.name));
    cachedConfigs = configs;
    if (configs.length === 0) return;

    // Clean stale cache entries for removed servers
    cleanupStaleCache(configs, cachedCwd);

    const enabledConfigs = configs.filter(s => s.enabled);

    // Register tools from cache — prompt-stable, works even if MCP is down
    registerCachedTools(pi, enabledConfigs);

    // Connect in background, pass UI for schema change notifications
    void connectAll(enabledConfigs, ctx.hasUI ? ctx.ui : undefined);
  });

  pi.on("session_shutdown", () => {
    void teardownMcp();
  });
}

export function getMcpStatus(): McpServerStatus[] {
  const cache = loadMcpCache(cachedCwd);
  const result: McpServerStatus[] = [];
  for (const config of cachedConfigs) {
    const connected = allServers.get(config.name);
    if (connected) {
      result.push(connected);
    } else {
      const cachedEntry = cache?.servers[config.name];
      result.push({
        name: config.name,
        url: config.url ?? config.command ?? "(unknown)",
        source: config.source,
        state: config.enabled ? "connecting" : "disabled",
        toolCount: cachedEntry?.tools.length ?? 0,
        tools: cachedEntry?.tools ?? [],
      });
    }
  }
  return result;
}

// ── refresh single server cache ───────────────────────────────────────────

export const __mcpIndexTest = { collapseMcpText };

export async function refreshServerCache(
  serverName: string,
  registry: any,
): Promise<{ ok: boolean; error?: string }> {
  const config = resolveMcpConfigs(cachedCwd).find(s => s.name === serverName);
  if (!config) return { ok: false, error: `Server "${serverName}" not found in config.` };

  // Disconnect existing connection for this server
  const existing = activeConnections.find(c => c.serverName === serverName);
  if (existing) {
    try { await existing.disconnect(); } catch { /* ignore */ }
    activeConnections = activeConnections.filter(c => c.serverName !== serverName);
  }

  const conn = new McpConnection(config.name, config);
  conn.source = config.source;

  try {
    await conn.connect(30_000);
    activeConnections.push(conn);

    allServers.set(config.name, {
      name: config.name,
      url: config.url ?? config.command ?? "(unknown)",
      source: config.source,
      state: "connected",
      toolCount: conn.tools.length,
      tools: conn.tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });

    const tools: McpToolCache[] = conn.tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    updateServerCache(
      config.name,
      { tools, cachedAt: Date.now() },
      cacheScopeForSource(config.source),
      cachedCwd || undefined,
    );

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    allServers.set(config.name, {
      name: config.name,
      url: config.url ?? config.command ?? "(unknown)",
      source: config.source,
      state: "failed",
      toolCount: 0,
      tools: [],
      error: msg,
    });
    return { ok: false, error: msg };
  }
}

async function teardownMcp(): Promise<void> {
  await Promise.all(
    activeConnections.map(async (conn) => {
      try {
        await conn.disconnect();
      } catch {
        // Silently ignore disconnect errors.
      }
    }),
  );
  activeConnections = [];
  allServers = new Map();
  cachedConfigs = [];
}
