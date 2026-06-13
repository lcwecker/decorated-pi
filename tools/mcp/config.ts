/**
 * MCP server configuration — type, discovery, resolution, toggle.
 *
 * Sources (in priority order): builtin → global → project. The first
 * hit sets defaults; later sources can override specific fields.
 *
 * Persistence locations:
 *   - global: `~/.pi/agent/mcp.json` (under `mcpServers`)
 *   - project: `<cwd>/.pi/agent/mcp.json` (under `mcpServers`)
 *
 * Legacy: global MCP servers used to live in `~/.pi/agent/decorated-pi.json`
 * under `mcpServers`. `loadGlobalMcpConfigs()` automatically migrates that
 * data to `~/.pi/agent/mcp.json` on first read.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { isModuleEnabled } from "../../settings.js";
import type { DependencyStatus } from "../../hooks/skeleton.js";
import { BUILTIN_MCP_SERVERS } from "./builtin/index.js";

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

function globalMcpJsonPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "mcp.json");
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

/**
 * One-time migration: older versions stored global MCP servers in
 * `~/.pi/agent/decorated-pi.json` under `mcpServers`. Move that data to
 * the dedicated `~/.pi/agent/mcp.json` file so global and project configs
 * are symmetric.
 *
 * Rules:
 *   - Only runs when the legacy file has at least one `mcpServers` entry.
 *   - For each legacy server name, if `mcp.json` already has an entry with
 *     the same name, the legacy entry is skipped (new file wins).
 *   - Idempotent: after running once, the legacy file no longer has
 *     `mcpServers`, so a second call is a no-op.
 */
export function migrateLegacyGlobalMcpConfig(): void {
  const legacyPath = path.join(os.homedir(), ".pi", "agent", "decorated-pi.json");
  const newPath = globalMcpJsonPath();

  let legacy: Record<string, any> | null = null;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
  } catch {
    return;
  }
  if (!legacy || !legacy.mcpServers || typeof legacy.mcpServers !== "object") return;
  if (Object.keys(legacy.mcpServers).length === 0) return;

  // Load existing new file (if any). If it is corrupt, leave everything
  // alone — safer than clobbering.
  let newConfig: Record<string, any> = { mcpServers: {} };
  if (fs.existsSync(newPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(newPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        newConfig = parsed;
        if (!newConfig.mcpServers || typeof newConfig.mcpServers !== "object") {
          newConfig.mcpServers = {};
        }
      }
    } catch {
      return;
    }
  }

  // Merge: only add legacy entries that don't already exist in the new file.
  for (const [name, entry] of Object.entries(legacy.mcpServers)) {
    if (!(name in newConfig.mcpServers)) {
      newConfig.mcpServers[name] = entry;
    }
  }

  const dir = path.dirname(newPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(newPath, JSON.stringify(newConfig, null, 2) + "\n", "utf-8");

  delete legacy.mcpServers;
  fs.writeFileSync(legacyPath, JSON.stringify(legacy, null, 2) + "\n", "utf-8");
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

/** Load global MCP configs from ~/.pi/agent/mcp.json. */
export function loadGlobalMcpConfigs(): McpServerConfig[] {
  const servers = readMcpJson(globalMcpJsonPath());
  if (!servers) return [];

  return Object.entries(servers).map(([name, entry]) => ({
    name,
    url: entry.url,
    command: entry.command,
    args: entry.args,
    env: entry.env,
    description: entry.description,
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
  // The mcp module switch is the master switch. When it is off, no MCP
  // server config is considered active — this keeps the chain simple:
  // mcp off → all servers off → no codegraph guidance.
  if (!isModuleEnabled("mcp")) return [];

  const byName = new Map<string, McpServerConfig>();

  // Builtin (lowest priority). Use the builtin's own `enabled` default.
  // Servers can be enabled via the `/mcp` command or by editing mcp.json.
  for (const s of BUILTIN_MCP_SERVERS) {
    byName.set(s.name, { ...s, source: "builtin" });
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
      const filePath = globalMcpJsonPath();
      const raw = readMcpJsonSafe(filePath) || { mcpServers: {} };
      const servers = raw.mcpServers ?? {};
      servers[serverName] = { ...(servers[serverName] || {}), enabled };
      raw.mcpServers = servers;
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    }
    return true;
  } catch {
    return false;
  }
}
