/**
 * MCP server configuration — builtin + global + project-level.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { loadConfig, isCodegraphModuleEnabled } from "../settings.js";
import type { DependencyStatus } from "../rtk";

export interface McpServerConfig {
  name: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  description?: string;
  enabled: boolean;
  source: "builtin" | "global" | "project";
}

/** Builtin servers — zero-config, always available unless overridden.
 *  The cross-source priority is `builtin < global < project`; the order
 *  WITHIN this array doesn't matter for resolution because each entry
 *  has a unique `name`. */
export const BUILTIN_MCP_SERVERS: Omit<McpServerConfig, "source">[] = [
  {
    name: "context7",
    url: "https://mcp.context7.com/mcp",
    enabled: true,
  },
  {
    name: "exa",
    url: "https://mcp.exa.ai/mcp",
    enabled: true,
  },
  {
    // Local code knowledge graph (colbymchenry/codegraph). Opt-in via
    // the decorated-pi module toggle (`modules.codegraph` / /dp-settings).
    // The `enabled: false` here is a placeholder — resolveMcpConfigs
    // overrides it with `isCodegraphModuleEnabled()` at resolve time,
    // so this literal value is never what ends up in the resolved list.
    name: "codegraph",
    command: "codegraph",
    args: ["serve", "--mcp"],
    enabled: false,
    description: "Local code knowledge graph (colbymchenry/codegraph). Enable via /dp-settings.",
  },
];

// ── Project-level config discovery ─────────────────────────────────────────

function readMcpJson(filePath: string): Record<string, { url?: string; command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean; description?: string }> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const servers = raw.mcpServers ?? raw["mcp-servers"];
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null;
    return servers as Record<string, { url?: string; command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }>;
  } catch {
    return null;
  }
}

/** Load project-level MCP configs from cwd only. */
export function loadProjectMcpConfigs(cwd: string): McpServerConfig[] {
  const configs: McpServerConfig[] = [];
  const seen = new Set<string>();

  const filePath = path.join(cwd, ".pi/agent/mcp.json");
  if (!fs.existsSync(filePath)) return [];
  const servers = readMcpJson(filePath);
  if (!servers) return [];

  for (const [name, entry] of Object.entries(servers)) {
    if (seen.has(name)) continue;
    seen.add(name);
    configs.push({
      name,
      url: entry.url,
      command: entry.command,
      args: entry.args,
      env: entry.env,
      enabled: entry.enabled !== false,
      description: entry.description,
      source: "project",
    });
  }

  return configs;
}

/** Load global MCP configs from ~/.pi/agent/decorated-pi.json. */
export function loadGlobalMcpConfigs(): McpServerConfig[] {
  const config = loadConfig();
  if (!config.mcpServers) return [];

  return Object.entries(config.mcpServers).map(([name, entry]) => ({
    name,
    url: entry.url,
    command: entry.command,
    args: entry.args,
    env: entry.env,
    description: (entry as any).description as string | undefined,
    enabled: entry.enabled !== false,
    source: "global" as const,
  }));
}

/** Returns true if the URL should use SSE transport (path ends with /sse). */
export function isSseUrl(url: string): boolean {
  return url.endsWith("/sse") || url.endsWith("/sse/");
}

/**
 * Merge all MCP configs: builtin → global → project.
 * Later sources override earlier ones for the same server name.
 */
export function resolveMcpConfigs(cwd: string): McpServerConfig[] {
  const byName = new Map<string, McpServerConfig>();

  // Builtin (lowest priority). The codegraph entry's `enabled` flag is
  // computed at resolve time from the dp-settings module toggle — see
  // `isCodegraphModuleEnabled`. We don't probe `.codegraph/codegraph.db`
  // here; if the project hasn't been initialised yet, the tools will
  // error at call time, which the system-prompt guidance handles.
  for (const s of BUILTIN_MCP_SERVERS) {
    if (s.name === "codegraph") {
      byName.set(s.name, { ...s, enabled: isCodegraphModuleEnabled(), source: "builtin" });
    } else {
      byName.set(s.name, { ...s, source: "builtin" });
    }
  }

  // Global — preserve url/command/description from builtin if not overridden
  for (const s of loadGlobalMcpConfigs()) {
    const existing = byName.get(s.name);
    if (existing) {
      byName.set(s.name, {
        ...existing,
        ...s,
        url: s.url ?? existing.url,
        command: s.command ?? existing.command,
        args: s.args ?? existing.args,
        env: s.env ?? existing.env,
        description: s.description ?? existing.description,
        source: "global",
      });
    } else {
      byName.set(s.name, s);
    }
  }

  // Project (highest priority) — same preservation logic
  for (const s of loadProjectMcpConfigs(cwd)) {
    const existing = byName.get(s.name);
    if (existing) {
      byName.set(s.name, {
        ...existing,
        ...s,
        url: s.url ?? existing.url,
        command: s.command ?? existing.command,
        args: s.args ?? existing.args,
        env: s.env ?? existing.env,
        description: s.description ?? existing.description,
        source: "project",
      });
    } else {
      byName.set(s.name, s);
    }
  }

  return [...byName.values()].filter((s) => s.url || s.command);
}

export function collectMcpDependencyStatuses(cwd: string): DependencyStatus[] {
  const seen = new Set<string>();
  const statuses: DependencyStatus[] = [];
  for (const cfg of resolveMcpConfigs(cwd)) {
    if (!cfg.enabled || !cfg.command || seen.has(cfg.command)) continue;
    seen.add(cfg.command);
    statuses.push({
      module: `mcp:${cfg.name}`,
      label: cfg.command,
      state: commandExists(cfg.command) ? "ok" : "missing",
      detail: `Install the MCP server command for \"${cfg.name}\" or update its config.`,
    });
  }
  return statuses;
}

function commandExists(command: string): boolean {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return fs.existsSync(command);
  }
  const result = process.platform === "win32"
    ? spawnSync("where", [command], { encoding: "utf-8" })
    : spawnSync(process.env.SHELL || "sh", ["-lc", `command -v '${command.replace(/'/g, `'"'"'`)}'`], { encoding: "utf-8" });
  return result.status === 0;
}

/** Write auto-generated description back to project mcp.json. */
export function saveProjectMcpDescription(cwd: string, name: string, description: string): void {
  const filePath = path.join(cwd, ".pi/agent/mcp.json");
  const servers = readMcpJson(filePath);
  if (!servers || !servers[name]) return;
  servers[name] = { ...servers[name], description };
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ mcpServers: servers }, null, 2) + "\n", "utf-8");
}

// ── Metadata cache (tool descriptions + schemas) ──────────────────────────

export interface McpToolCache {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerCache {
  description?: string;
  tools: McpToolCache[];
  cachedAt: number;
}

export interface McpCache {
  servers: Record<string, McpServerCache>;
}

function globalCachePath(): string {
  return path.join(os.homedir(), ".pi/agent/mcp-cache.json");
}

function projectCachePath(cwd: string): string {
  return path.join(cwd, ".pi/agent/mcp-cache.json");
}

function readCacheFile(p: string): McpCache | null {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as McpCache;
  } catch {
    return null;
  }
}

function writeCacheFile(p: string, cache: McpCache): void {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf-8");
  fs.renameSync(tmp, p);
}

/** Load merged cache: global + project. */
export function loadMcpCache(cwd?: string): McpCache | null {
  const merged: McpCache = { servers: {} };

  const globalCache = readCacheFile(globalCachePath());
  if (globalCache) {
    merged.servers = { ...merged.servers, ...globalCache.servers };
  }

  if (cwd) {
    const projectCache = readCacheFile(projectCachePath(cwd));
    if (projectCache) {
      merged.servers = { ...merged.servers, ...projectCache.servers };
    }
  }

  return merged;
}

/** Save cache to global or project scope. */
export function saveMcpCache(cache: McpCache, scope: "global" | "project", cwd?: string): void {
  const p = scope === "project" && cwd ? projectCachePath(cwd) : globalCachePath();
  writeCacheFile(p, cache);
}

/** Update a single server's entry in the appropriate cache. */
export function updateServerCache(
  serverName: string,
  entry: McpServerCache,
  scope: "global" | "project",
  cwd?: string,
): void {
  const p = scope === "project" && cwd ? projectCachePath(cwd) : globalCachePath();
  const existing = readCacheFile(p) || { servers: {} };
  existing.servers[serverName] = entry;
  writeCacheFile(p, existing);
}

// ── Enable / Disable helpers ────────────────────────────────────────────

function readMcpJsonSafe(filePath: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Toggle a server's enabled state in the appropriate config file. */
export function toggleMcpServerEnabled(
  serverName: string,
  enabled: boolean,
  scope: "global" | "project",
  cwd?: string,
): boolean {
  try {
    if (scope === "project" && cwd) {
      const filePath = path.join(cwd, ".pi/agent/mcp.json");
      const raw = readMcpJsonSafe(filePath) || { mcpServers: {} };
      const servers = raw.mcpServers ?? {};
      servers[serverName] = { ...(servers[serverName] || {}), enabled };
      raw.mcpServers = servers;
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    } else {
      const { loadConfig } = require("../settings.js");
      const config = loadConfig();
      config.mcpServers = config.mcpServers || {};
      config.mcpServers[serverName] = { ...(config.mcpServers[serverName] || {}), enabled };
      const configPath = path.join(os.homedir(), ".pi/agent/decorated-pi.json");
      const dir = path.dirname(configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    }
    return true;
  } catch {
    return false;
  }
}

function cleanupOneCache(p: string, names: Set<string>): void {
  const cache = readCacheFile(p);
  if (!cache) return;
  let changed = false;
  for (const name of Object.keys(cache.servers)) {
    if (!names.has(name)) {
      delete cache.servers[name];
      changed = true;
    }
  }
  if (changed) writeCacheFile(p, cache);
}

export function cleanupStaleCache(configs: McpServerConfig[], cwd?: string): void {
  const names = new Set(configs.map(c => c.name));
  cleanupOneCache(globalCachePath(), names);
  if (cwd) {
    const projectCache = projectCachePath(cwd);
    const projectMcpJson = path.join(cwd, ".pi/agent/mcp.json");
    // If project mcp.json doesn't exist, remove project cache entirely
    if (!fs.existsSync(projectMcpJson)) {
      if (fs.existsSync(projectCache)) {
        fs.unlinkSync(projectCache);
      }
    } else {
      cleanupOneCache(projectCache, names);
    }
  }
}

// ── Large result externalization ────────────────────────────────────────

export const EXTERNALIZE_THRESHOLD = 50_000; // 50KB
export const EXTERNALIZE_PREVIEW_SIZE = 2_000; // 2KB preview
import { writeOutputToTemp } from "../io-tool-output.js";

/**
 * If content exceeds threshold, save to temp file and return preview + path.
 * Otherwise return original content unchanged.
 * Falls back to returning full text if file write fails.
 */
export function maybeExternalizeMcpResult(
  text: string,
  toolName: string,
  toolCallId: string,
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  if (text.length <= EXTERNALIZE_THRESHOLD) {
    return { content: [{ type: "text", text }], details: {} };
  }

  const filePath = writeOutputToTemp(toolName, toolCallId, text);
  if (!filePath) {
    return { content: [{ type: "text", text }], details: {} };
  }
  const preview = text.slice(0, EXTERNALIZE_PREVIEW_SIZE);
  return {
    content: [{ type: "text", text: `${preview}\n\n[Truncated: ${text.length.toLocaleString()} chars total. Full output saved to: ${filePath}]` }],
    details: {
      fullOutputPath: filePath,
      truncation: { truncated: true, outputChars: EXTERNALIZE_PREVIEW_SIZE, totalChars: text.length, maxBytes: EXTERNALIZE_THRESHOLD },
    },
  };
}
