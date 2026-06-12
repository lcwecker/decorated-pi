/**
 * Pure MCP tool-definition helpers.
 *
 * No hook/module state lives here. Callers provide `findConnection`
 * so both hooks/mcp.ts and tools/mcp/index.ts can share the same tool
 * factory without importing each other.
 */

import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { McpConnection } from "./client.js";
import type { McpServerConfig } from "./config.js";

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
  execute: (id: string, params: any, signal: any, update: any, ctx: any) => Promise<any>;
} {
  const toolName = makeToolName(config.name, toolEntry.name);
  const desc = toolEntry.description || `${toolEntry.name} (MCP tool)`;
  return {
    name: toolName,
    label: makeToolLabel(config.name, toolEntry.name, toolEntry.description),
    description: desc,
    promptSnippet: desc || `MCP tool ${config.name}/${toolEntry.name}`,
    renderResult: renderMcpResult,
    parameters: toolEntry.inputSchema,
    execute: async (_id: string, params: any, _signal: any, _update: any, _ctx: any) => {
      const conn = findConnection(config.name);
      if (!conn) {
        return {
          content: [{ type: "text", text: `MCP server "${config.name}" is not connected. Use /reload to retry.` }],
          isError: false,
          details: {},
        };
      }
      try {
        const text = await conn.callTool(toolEntry.name, params ?? {});
        return { content: [{ type: "text", text }], isError: false, details: {} };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `MCP tool "${toolName}" error: ${msg}` }], isError: true, details: {} };
      }
    },
  };
}

export const __mcpToolDefinitionTest = { collapseMcpText, buildMcpTool };
