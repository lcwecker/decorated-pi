/**
 * externalize — large tool_result → temp file.
 *
 * Keeps the messages segment small so the prompt cache stays warm across turns.
 * Applies to ANY tool whose first text content exceeds OUTPUT_EXTERNALIZE_THRESHOLD
 * bytes — read, bash, MCP tools, all the same. The tool name is preserved
 * in the temp filename so users can correlate the truncation with the
 * call that produced it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { Module } from "./skeleton.js";

export const TOOL_OUTPUT_TEMP_DIR = path.join(os.tmpdir(), "decorated-pi-results");
export const OUTPUT_EXTERNALIZE_THRESHOLD = 30_000;

/** Write content to a temp file under TOOL_OUTPUT_TEMP_DIR.
 *  Returns the file path, or undefined on failure (e.g., /tmp full).
 *  Exported so other modules (e.g. tools/mcp/externalize.ts) can
 *  write to the same location. */
export function writeOutputToTemp(
  toolName: string,
  toolCallId: string,
  content: string,
): string | undefined {
  try {
    if (!fs.existsSync(TOOL_OUTPUT_TEMP_DIR)) fs.mkdirSync(TOOL_OUTPUT_TEMP_DIR, { recursive: true });
    const id = toolCallId ? toolCallId.slice(0, 12) : randomBytes(8).toString("hex");
    const filePath = path.join(TOOL_OUTPUT_TEMP_DIR, `${toolName}-${id}.txt`);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  } catch {
    return undefined;
  }
}

/** Externalize a tool_result event if content is above the threshold.
 *  Returns the modified event, or undefined to leave the original untouched. */
export function maybeExternalizeToolResult(event: any): any | undefined {
  if (!Array.isArray(event.content) || event.content.length === 0) return undefined;
  const first = event.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") return undefined;
  const text = first.text;
  if (text.length <= OUTPUT_EXTERNALIZE_THRESHOLD) return undefined;

  const filePath = writeOutputToTemp(event.toolName, event.toolCallId, text);
  if (!filePath) return undefined;

  return {
    ...event,
    content: [{
      type: "text" as const,
      text: `[Output truncated: ${text.length.toLocaleString()} chars. Full output: ${filePath}]`,
    }],
  };
}

export const externalizeModule: Module = {
  name: "externalize",
  hooks: {
    tool_result: [
      (event) => {
        return maybeExternalizeToolResult(event);
      },
    ],
  },
};
