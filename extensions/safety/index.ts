/**
 * Safety — Pi 集成层
 *
 * - Secret Redact: API Key / Token 自动掩码
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  detectSecrets,
  maskSecret,
} from "./detect.js";

type ToolTextContent = Extract<NonNullable<ToolResultEvent["content"]>[number], { type: "text" }>;

function summarizeCommand(command: string, maxLength = 48): string {
  const singleLine = command.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function formatRedactionContext(event: ToolResultEvent): string {
  if (event.toolName === "read") {
    const filePath = (event.input as any)?.path ?? (event.input as any)?.file ?? (event.input as any)?.file_path;
    return filePath ? `read ${filePath}` : "read";
  }
  if (event.toolName === "bash") {
    const command = (event.input as any)?.command;
    return typeof command === "string" && command.trim().length > 0
      ? `bash ${summarizeCommand(command)}`
      : "bash";
  }
  return event.toolName;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

export function setupSafety(pi: ExtensionAPI) {
  // ── Secret Redact (tool_result) ────────────────────────────────────────

  const handleToolResult = async (
    event: ToolResultEvent,
    ctx: ExtensionContext,
  ): Promise<{ content?: NonNullable<ToolResultEvent["content"]> } | void> => {
    if (!event.content || !Array.isArray(event.content)) return;

    // Scan read + bash tool output. Skip write/edit/patch because they mainly
    // produce diffs or generated file bodies, which are handled elsewhere and are
    // more prone to noisy false positives.
    if (event.toolName !== "read" && event.toolName !== "bash") return;

    const textParts: Array<{ index: number; text: string; item: ToolTextContent }> = [];
    for (let i = 0; i < event.content.length; i++) {
      const item = event.content[i];
      if (item.type === "text" && typeof item.text === "string" && item.text.length > 0) {
        textParts.push({ index: i, text: item.text, item });
      }
    }
    if (textParts.length === 0) return;

    let totalCount = 0;
    const counts: Record<"pattern" | "regex" | "entropy", number> = {
      pattern: 0,
      regex: 0,
      entropy: 0,
    };
    const newContent = [...event.content];

    const filePath = (event.input as any)?.path ?? (event.input as any)?.file ?? (event.input as any)?.file_path;

    for (const { index, text, item } of textParts) {
      const matches = detectSecrets(text, { filePath });
      if (matches.length === 0) continue;

      totalCount += matches.length;
      let redacted = text;
      for (const { start, end, source } of matches) {
        counts[source] += 1;
        const original = redacted.slice(start, end);
        redacted = redacted.slice(0, start) + maskSecret(original, source) + redacted.slice(end);
      }
      const updatedItem: ToolTextContent = { ...item, text: redacted };
      newContent[index] = updatedItem;
    }

    if (totalCount === 0) return;
    const label = totalCount === 1 ? "1 secret" : `${totalCount} secrets`;
    const breakdown: string[] = [];
    if (counts.pattern > 0) breakdown.push(`*:pattern=${counts.pattern}`);
    if (counts.regex > 0) breakdown.push(`#:regex=${counts.regex}`);
    if (counts.entropy > 0) breakdown.push(`?:entropy=${counts.entropy}`);
    const suffix = breakdown.length > 0 ? ` · ${breakdown.join(" ")}` : "";
    const contextLabel = formatRedactionContext(event);
    ctx.ui.notify(`🔒 [${contextLabel}] Redacted ${label}${suffix}`, "warning");
    return { content: newContent };
  };

  pi.on("tool_result", handleToolResult);
}
