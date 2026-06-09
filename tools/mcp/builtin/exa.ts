/**
 * exa builtin MCP server definition.
 */
import type { McpServerConfig } from "../config.js";

export const EXA_BUILTIN: Omit<McpServerConfig, "source"> = {
  name: "exa",
  url: "https://mcp.exa.ai/mcp",
  enabled: true,
};
