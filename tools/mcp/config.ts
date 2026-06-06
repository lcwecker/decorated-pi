/**
 * MCP server configuration — type, discovery, resolution, toggle.
 *
 * Sources (in priority order): builtin → global → project. The first
 * hit sets defaults; later sources can override specific fields.
 *
 * Persistence locations:
 *   - global: `~/.pi/agent/decorated-pi.json` (under `mcpServers`)
 *   - project: `<cwd>/.pi/agent/mcp.json` (under `mcpServers`)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../../settings.js";
import type { DependencyStatus } from "../../hooks/rtk.js";
import { BUILTIN_MCP_SERVERS, codegraphEnabled } from "./builtin/index.js";

export { BUILTIN_MCP_SERVERS } from "./builtin/index.js";

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
  // computed at resolve time from the dp-settings module toggle.
  for (const s of BUILTIN_MCP_SERVERS) {
    if (s.name === "codegraph") {
      byName.set(s.name, { ...s, enabled: codegraphEnabled(), source: "builtin" });
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
