/**
 * MCP server configuration — builtin + global + project-level.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../settings.js";

export interface McpServerConfig {
  name: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
  source: "builtin" | "global" | "project";
}

/** Builtin servers — zero-config, always available unless overridden. */
export const BUILTIN_MCP_SERVERS: Omit<McpServerConfig, "source">[] = [
  {
    name: "context7",
    url: "https://mcp.context7.com/mcp",
    description: "Context7 documentation and code examples",
    enabled: true,
  },
  {
    name: "exa",
    url: "https://mcp.exa.ai/mcp",
    description: "Exa web search",
    enabled: true,
  },
];

// ── Project-level config discovery ─────────────────────────────────────────

function readMcpJson(filePath: string): Record<string, { url?: string; command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }> | null {
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

  // Builtin (lowest priority)
  for (const s of BUILTIN_MCP_SERVERS) {
    byName.set(s.name, { ...s, source: "builtin" });
  }

  // Global
  for (const s of loadGlobalMcpConfigs()) {
    byName.set(s.name, s);
  }

  // Project (highest priority)
  for (const s of loadProjectMcpConfigs(cwd)) {
    byName.set(s.name, s);
  }

  return [...byName.values()].filter((s) => s.enabled && (s.url || s.command));
}
