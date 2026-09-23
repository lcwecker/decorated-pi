/**
 * Pure MCP tool-definition helpers.
 *
 * No hook/module state lives here. Callers provide `findConnection`
 * so both hooks/mcp.ts and tools/mcp/index.ts can share the same tool
 * factory without importing each other. Result rendering is the shared
 * folded-text renderer, so MCP tools and the native web tools look alike.
 */

import type { McpConnection } from "./client.js";
import type { McpServerConfig } from "./config.js";
import { collapseToolText, renderToolTextResult } from "../../utils/tool-output.js";

/** Kept as a local name: the MCP specs reach it through __mcpToolDefinitionTest. */
const collapseMcpText = collapseToolText;
const renderMcpResult = renderToolTextResult;

function makeToolName(serverName: string, toolName: string): string {
  return `${serverName}_${toolName}`;
}

function makeToolLabel(serverName: string, toolName: string, desc?: string): string {
  return `MCP ${serverName}: ${toolName}${desc ? ` (${desc.slice(0, 20)})` : ""}`;
}

export function buildMcpTool(
  config: McpServerConfig,
  toolEntry: { name: string; description?: string; inputSchema?: Record<string, unknown> },
  findConnection: (serverName: string) => McpConnection | undefined,
): {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  renderResult: (result: any, options: { expanded: boolean }, theme: any, context: any) => any;
  parameters: Record<string, unknown> | undefined;
  execute: (id: string, params: any, signal: AbortSignal | undefined, update: any, ctx: any) => Promise<any>;
} {
  const toolName = makeToolName(config.name, toolEntry.name);
  const desc = toolEntry.description || `${toolEntry.name} (MCP tool)`;
  return {
    name: toolName,
    label: makeToolLabel(config.name, toolEntry.name, toolEntry.description),
    description: desc,
    promptSnippet: desc || `MCP tool ${config.name}/${toolEntry.name}`,
    renderResult: renderMcpResult,
    parameters: toolEntry.inputSchema ?? { type: "object", properties: {} },
    execute: async (_id: string, params: any, signal: AbortSignal | undefined, _update: any, _ctx: any) => {
      const conn = findConnection(config.name);
      if (!conn) {
        return {
          content: [{ type: "text", text: `MCP server "${config.name}" is not connected. Use /reload to retry.` }],
          isError: false,
          details: {},
        };
      }
      try {
        const text = await conn.callTool(toolEntry.name, params ?? {}, signal);
        return { content: [{ type: "text", text }], isError: false, details: {} };
      } catch (err) {
        if (signal?.aborted) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `MCP tool "${toolName}" error: ${msg}` }], isError: true, details: {} };
      }
    },
  };
}

export const __mcpToolDefinitionTest = { collapseMcpText, buildMcpTool };
