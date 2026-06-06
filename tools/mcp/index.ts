/**
 * mcp tool registration — reads cache, registers tools dynamically.
 * Connection lifecycle is in hooks/mcp.ts.
 */

import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { McpConnection } from "./client.js";
import { loadMcpCache, type McpCache } from "./cache.js";
import { resolveMcpConfigs, type McpServerConfig } from "./config.js";
import { getActiveMcpConnections } from "../../hooks/mcp.js";

const MCP_RESULT_FOLD_LINES = 45;

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return lines.slice(0, end);
}

function collapseMcpText(text: string, maxLines = MCP_RESULT_FOLD_LINES) {
  const lines = trimTrailingEmptyLines(text.split("\n"));
  return {
    totalLines: lines.length,
    displayLines: lines.slice(0, maxLines),
    remainingLines: Math.max(0, lines.length - maxLines),
  };
}

function getTextContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((c): c is { type: "text"; text?: string } => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function formatMcpResultText(text: string, expanded: boolean, theme: any): string {
  const { totalLines, displayLines, remainingLines } = collapseMcpText(text, expanded ? Number.MAX_SAFE_INTEGER : MCP_RESULT_FOLD_LINES);
  const lastLine = displayLines[displayLines.length - 1] || "";
  let outputLines = [...displayLines];
  let truncationMsg = "";
  if (lastLine.startsWith("[Truncated: ") && lastLine.endsWith("]")) {
    truncationMsg = lastLine;
    outputLines = outputLines.slice(0, -1);
  }
  const outputText = outputLines.join("\n");
  let rendered = outputText ? theme.fg("toolOutput", outputText) : "";
  if (truncationMsg) rendered += (rendered ? "\n" : "") + theme.fg("warning", truncationMsg);
  if (!expanded && remainingLines > 0) {
    rendered += `${theme.fg("muted", `\n... (${remainingLines} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")})`;
  }
  return rendered;
}

function renderMcpResult(result: any, options: { expanded: boolean }, theme: any, context: any) {
  const component = context.lastComponent ?? new Text("", 0, 0);
  component.setText(formatMcpResultText(getTextContent(result), options.expanded, theme));
  return component;
}

function makeToolName(serverName: string, toolName: string): string {
  return `${serverName}_${toolName}`;
}

function makeToolLabel(serverName: string, toolName: string, desc?: string): string {
  return `MCP ${serverName}: ${toolName}${desc ? ` (${desc.slice(0, 20)})` : ""}`;
}

export function registerMcpToolsFromCache(pi: ExtensionAPI, cache: McpCache, configs: McpServerConfig[]): void {
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
        promptSnippet: desc || `MCP tool ${config.name}/${t.name}`,
        renderResult: renderMcpResult,
        parameters: t.inputSchema,
        execute: async (_id: string, params: any, _signal: any, _update: any, _ctx: any) => {
          const conn = getActiveMcpConnections().find(c => c.serverName === config.name);
          if (!conn) {
            return {
              content: [{ type: "text", text: `MCP server "${config.name}" is not connected. Use /reload to retry.` }],
              isError: false,
              details: {},
            };
          }
          try {
            const text = await conn.callTool(t.name, params ?? {});
            return { content: [{ type: "text", text }], isError: false, details: {} };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `MCP tool "${toolName}" error: ${msg}` }], isError: true, details: {} };
          }
        },
      });
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
export { getActiveMcpConnections, getCachedMcpConfigs, getMcpStatus, updateConfigEnabled, refreshServerCache } from "../../hooks/mcp.js";
export type { McpServerConfig } from "./config.js";
export type { McpCache } from "./cache.js";

// Test exports
export const __mcpIndexTest = { collapseMcpText };
