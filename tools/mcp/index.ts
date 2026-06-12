/**
 * mcp tool registration — reads cache, registers tools dynamically.
 * Connection lifecycle is in hooks/mcp.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadMcpCache, type McpCache } from "./cache.js";
import { resolveMcpConfigs, type McpServerConfig } from "./config.js";
import { buildMcpTool, __mcpToolDefinitionTest } from "./tool-definition.js";
import { getActiveMcpConnections } from "../../hooks/mcp.js";

export function registerMcpToolsFromCache(pi: ExtensionAPI, cache: McpCache, configs: McpServerConfig[]): void {
  for (const config of configs) {
    if (!config.enabled) continue;
    const entry = cache.servers[config.name];
    if (!entry || entry.tools.length === 0) continue;
    for (const t of entry.tools) {
      try {
        pi.registerTool(buildMcpTool(config, t, (name) => getActiveMcpConnections().find(c => c.serverName === name)) as any);
      } catch {
        // pi-core may throw on duplicate name (e.g. on /reload when the
        // same tool is re-registered). The previous registration is
        // still in effect, so silently ignore.
      }
    }
  }
}

export function registerMcpTools(pi: ExtensionAPI, cwd: string): void {
  const cache = loadMcpCache(cwd);
  if (!cache) return;
  const configs = resolveMcpConfigs(cwd).filter(s => s.enabled);
  registerMcpToolsFromCache(pi, cache, configs);
}

// Re-exports
export { McpConnection } from "./client.js";
export { buildMcpTool } from "./tool-definition.js";
export { getActiveMcpConnections, getCachedMcpConfigs, getMcpStatus, updateConfigEnabled, refreshServerCache } from "../../hooks/mcp.js";
export type { McpServerConfig } from "./config.js";
export type { McpCache } from "./cache.js";

// Test exports
export const __mcpIndexTest = __mcpToolDefinitionTest;
