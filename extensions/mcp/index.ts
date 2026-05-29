import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { McpConnection } from "./client.js";
import {
  resolveMcpConfigs, saveProjectMcpDescription,
  loadMcpCache, updateServerCache, cleanupStaleCache,
  type McpServerConfig, type McpToolCache,
} from "./builtin.js";
import {
  getMcpBrokerModelKey, getCompactModelKey,
  getMcpDescription, setMcpDescription,
  parseModelKey,
} from "../settings.js";

export interface McpServerStatus {
  name: string;
  url: string;
  source: string;
  description?: string;
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

function serverDescription(s: McpServerConfig): string | undefined {
  return s.description || getMcpDescription(s.name, cachedCwd);
}

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

// ── auto-summary ──────────────────────────────────────────────────────────

async function autoDescribeServer(
  conn: McpConnection,
  serverName: string,
  registry: any,
): Promise<string> {
  const descs = conn.tools.map(t => `- ${t.name}: ${t.description || "(no description)"}`).join("\n");

  const prompt = `Describe what this MCP server is and what it does, based on the tools it exposes. Start with action verbs directly, like a capability summary.

Server: "${serverName}"
Tools:
${descs}

Respond with ONLY one short sentence. No quotes.`;

  return await summarizeWithBroker(registry, prompt) || `${serverName} MCP server (${conn.tools.length} tools)`;
}

async function summarizeWithBroker(registry: any, prompt: string): Promise<string | undefined> {
  if (!registry) return undefined;

  const brokerKey = getMcpBrokerModelKey() || getCompactModelKey();
  const model = brokerKey
    ? (() => {
        const parsed = parseModelKey(brokerKey);
        return parsed ? registry.find(parsed.provider, parsed.modelId) : undefined;
      })()
    : undefined;

  if (!model) return undefined;

  try {
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) return undefined;

    const { complete } = await import("@earendil-works/pi-ai");
    const resp = await complete(model, {
      systemPrompt: "You are a concise MCP server description generator.",
      messages: [{
        role: "user" as const,
        content: [{ type: "text" as const, text: prompt }],
        timestamp: Date.now(),
      }],
    }, {
      maxTokens: 128,
      apiKey: auth.apiKey ?? "",
      headers: auth.headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (resp.stopReason === "error") return undefined;
    return resp.content
      .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
      .map((c: any) => c.text).join(" ").trim() || undefined;
  } catch {
    return undefined;
  }
}

// ── regenerate (exported for TUI) ─────────────────────────────────────────

export async function regenerateServerDescription(serverName: string, registry: any): Promise<string | undefined> {
  const conn = activeConnections.find(c => c.serverName === serverName);
  if (!conn) return undefined;

  const desc = await autoDescribeServer(conn, serverName, registry);
  if (desc) {
    setMcpDescription(serverName, desc, cachedCwd || undefined);
    if (cachedCwd) saveProjectMcpDescription(cachedCwd, serverName, desc);
    const s = allServers.get(serverName);
    if (s) s.description = desc;
  }
  return desc;
}

function truncateAtWord(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const truncated = str.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > 0 ? truncated.slice(0, lastSpace) + "..." : truncated + "...";
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
        promptSnippet: truncateAtWord(desc, 100) || `MCP tool ${config.name}/${t.name}`,
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

async function connectAll(configs: McpServerConfig[], registry: any): Promise<void> {
  allServers = new Map(
    configs.map((s) => [
      s.name,
      {
        name: s.name,
        url: s.url ?? s.command ?? "(unknown)",
        source: s.source,
        description: serverDescription(s),
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

        let desc = serverDescription(server);
        if (!desc) {
          desc = await autoDescribeServer(conn, server.name, registry);
          if (desc) {
            if (server.source === "project") saveProjectMcpDescription(cachedCwd, server.name, desc);
            else setMcpDescription(server.name, desc);
          }
        }

        allServers.set(server.name, {
          name: server.name,
          url: server.url ?? server.command ?? "(unknown)",
          source: server.source,
          description: desc,
          state: "connected",
          toolCount: conn.tools.length,
          tools: conn.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });

        // Update cache with this server's tools
        const tools: McpToolCache[] = conn.tools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        updateServerCache(
          server.name,
          { description: desc, tools, cachedAt: Date.now() },
          cacheScopeForSource(server.source),
          cachedCwd || undefined,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allServers.set(server.name, {
          name: server.name,
          url: server.url ?? server.command ?? "(unknown)",
          source: server.source,
          description: serverDescription(server),
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

    const needSummary = enabledConfigs.filter(s => !serverDescription(s));

    if (needSummary.length === 0) {
      // All servers have descriptions — connect in background, update cache
      void connectAll(enabledConfigs, ctx.modelRegistry);
      return;
    }

    // Some servers lack description — connect and auto-summarize synchronously
    await connectAll(enabledConfigs, ctx.modelRegistry);
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
        description: serverDescription(config),
        state: config.enabled ? "connecting" : "disabled",
        toolCount: cachedEntry?.tools.length ?? 0,
        tools: cachedEntry?.tools ?? [],
      });
    }
  }
  return result;
}

// ── refresh single server cache ───────────────────────────────────────────

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

    let desc = serverDescription(config);
    if (!desc) {
      desc = await autoDescribeServer(conn, config.name, registry);
      if (desc) {
        if (config.source === "project") saveProjectMcpDescription(cachedCwd, config.name, desc);
        else setMcpDescription(config.name, desc);
      }
    }

    allServers.set(config.name, {
      name: config.name,
      url: config.url ?? config.command ?? "(unknown)",
      source: config.source,
      description: desc,
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
      { description: desc, tools, cachedAt: Date.now() },
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
      description: serverDescription(config),
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
