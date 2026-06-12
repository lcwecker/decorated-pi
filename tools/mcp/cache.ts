/**
 * MCP server metadata cache — persisted tool descriptions and schemas.
 * Stored at `~/.pi/agent/mcp-cache.json` (global) and `<cwd>/.pi/agent/mcp-cache.json` (project).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { McpServerConfig } from "./config.js";

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

function scopedCachePath(scope: "global" | "project", cwd?: string): string {
  return scope === "project" && cwd ? projectCachePath(cwd) : globalCachePath();
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

export function loadScopedMcpCache(scope: "global" | "project", cwd?: string): McpCache | null {
  return readCacheFile(scopedCachePath(scope, cwd));
}

/** Save cache to global or project scope. */
export function saveMcpCache(cache: McpCache, scope: "global" | "project", cwd?: string): void {
  writeCacheFile(scopedCachePath(scope, cwd), cache);
}

/** Update a single server's entry in the appropriate cache. */
export function updateServerCache(
  serverName: string,
  entry: McpServerCache,
  scope: "global" | "project",
  cwd?: string,
): void {
  const p = scopedCachePath(scope, cwd);
  const existing = readCacheFile(p) || { servers: {} };
  existing.servers[serverName] = entry;
  writeCacheFile(p, existing);
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
