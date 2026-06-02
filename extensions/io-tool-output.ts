/**
 * Shared tool-output externalization helpers.
 *
 * Used by `setupIO` (for read / bash) and `maybeExternalizeMcpResult` (for MCP tools).
 * Each writes to the same temp dir; MCP also adds a 2KB preview, while read / bash
 * emit a single-line placeholder.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export const TOOL_OUTPUT_TEMP_DIR = path.join(os.tmpdir(), "decorated-pi-results");

/** Write content to a temp file under TOOL_OUTPUT_TEMP_DIR.
 *  Returns the file path, or undefined on failure (e.g., /tmp full). */
export function writeOutputToTemp(
  toolName: string,
  toolCallId: string,
  content: string,
): string | undefined {
  try {
    if (!fs.existsSync(TOOL_OUTPUT_TEMP_DIR)) {
      fs.mkdirSync(TOOL_OUTPUT_TEMP_DIR, { recursive: true });
    }
    const id = toolCallId ? toolCallId.slice(0, 12) : randomBytes(8).toString("hex");
    const filePath = path.join(TOOL_OUTPUT_TEMP_DIR, `${toolName}-${id}.txt`);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  } catch {
    return undefined;
  }
}
