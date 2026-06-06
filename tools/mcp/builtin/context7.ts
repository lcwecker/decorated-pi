/**
 * context7 builtin MCP server definition.
 */
import type { McpServerConfig } from "../builtin.js";

export const CONTEXT7_BUILTIN: Omit<McpServerConfig, "source"> = {
  name: "context7",
  url: "https://mcp.context7.com/mcp",
  enabled: true,
};
