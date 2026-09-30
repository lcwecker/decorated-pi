/**
 * externalize — large tool_result → temp file.
 *
 * Keeps the messages segment small so the prompt cache stays warm across turns.
 * Applies to the first text part above OUTPUT_EXTERNALIZE_THRESHOLD bytes of any
 * tool pi leaves uncapped — read, MCP tools, the pack's own fetch and search
 * tools. The built-in bash tool is left alone: pi captures shell output itself
 * (50 KB / 2000 lines tail, with the full text in a spill file), so a second
 * copy here would only compete with it. The tool name is preserved
 * in the temp filename so users can correlate the truncation with the
 * call that produced it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { Module } from "./skeleton.js";

export const TOOL_OUTPUT_TEMP_DIR = path.join(
    os.tmpdir(),
    "decorated-pi-results",
);
export const OUTPUT_EXTERNALIZE_THRESHOLD = 30_000;

/** Write content to a temp file under TOOL_OUTPUT_TEMP_DIR.
 *  Returns the file path, or undefined on failure (e.g., /tmp full).
 *  Exported so other modules can write to the same location. */
export function writeOutputToTemp(
    toolName: string,
    toolCallId: string,
    content: string,
): string | undefined {
    try {
        if (!fs.existsSync(TOOL_OUTPUT_TEMP_DIR))
            fs.mkdirSync(TOOL_OUTPUT_TEMP_DIR, { recursive: true });
        const id = toolCallId
            ? toolCallId.slice(0, 12)
            : randomBytes(8).toString("hex");
        const filePath = path.join(
            TOOL_OUTPUT_TEMP_DIR,
            `${toolName}-${id}.txt`,
        );
        fs.writeFileSync(filePath, content, "utf-8");
        return filePath;
    } catch {
        return undefined;
    }
}

/**
 * Tools whose output pi already captures and spills. The built-in bash tool
 * hands the model a 50 KB / 2000-line tail and writes the full text to a spill
 * file, so externalizing it here would add a second copy of the same output and
 * take the captured tail away from the model in exchange for a path.
 */
export const PI_SPILLED_TOOLS = new Set(["bash"]);

/** Externalize a tool_result event if content is above the threshold.
 *  Returns the modified event, or undefined to leave the original untouched. */
export function maybeExternalizeToolResult(event: any): any | undefined {
    if (PI_SPILLED_TOOLS.has(event.toolName)) return undefined;
    if (!Array.isArray(event.content) || event.content.length === 0)
        return undefined;
    const [first, ...rest] = event.content;
    if (!first || first.type !== "text" || typeof first.text !== "string")
        return undefined;
    const text = first.text;
    if (text.length <= OUTPUT_EXTERNALIZE_THRESHOLD) return undefined;

    const filePath = writeOutputToTemp(event.toolName, event.toolCallId, text);
    if (!filePath) return undefined;

    // Replace the oversized part in place and keep the remaining ones: a mixed
    // result (long text plus an image, or a second text part) must not lose the
    // parts the model still needs.
    return {
        ...event,
        content: [
            {
                type: "text" as const,
                text: `[Output too long, saved to ${filePath}.]`,
            },
            ...rest,
        ],
    };
}

/** Delete output files left over from earlier days. The directory is a scratch
 *  area for the current day's spills, so keeping one day bounds its growth
 *  while never deleting a file a live session might still cite. Best-effort:
 *  a missing directory is a no-op. Returns how many files were removed. */
export function pruneOldOutputs(now: Date = new Date()): number {
    let entries: string[];
    try {
        entries = fs.readdirSync(TOOL_OUTPUT_TEMP_DIR);
    } catch {
        return 0;
    }
    const startOfToday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
    ).getTime();
    let removed = 0;
    for (const entry of entries) {
        const filePath = path.join(TOOL_OUTPUT_TEMP_DIR, entry);
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) continue;
            if (stat.mtimeMs >= startOfToday) continue;
            fs.unlinkSync(filePath);
            removed++;
        } catch {
            // Entry raced away or is unreadable — nothing to prune.
        }
    }
    return removed;
}

export const externalizeModule: Module = {
    name: "externalize",
    hooks: {
        // session_start (startup / resume / reload): drop earlier days' spills.
        // A readdir of a small directory is cheap enough to run every session.
        session_start: [
            () => {
                pruneOldOutputs();
            },
        ],
        tool_result: [
            (event) => {
                return maybeExternalizeToolResult(event);
            },
        ],
    },
};
