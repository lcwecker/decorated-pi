/**
 * redact — secret redaction on read/bash tool_result.
 *
 * Detects API keys, tokens, passwords in tool output and replaces them with
 * mask characters before the result enters the model context. Notifies the
 * user via ctx.ui.notify with the count of redactions.
 *
 * Implementation is split into helper modules under hooks/redact/ to keep
 * this file focused on the hook itself.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Module, Skeleton } from "./skeleton.js";
import { detectSecrets, maskSecret } from "./redact/detect.js";

type TextContent = { type: "text"; text: string };

function summarizeCommand(command: string, maxLength = 48): string {
  const singleLine = command.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function formatRedactionContext(toolName: string, input: any): string {
  if (toolName === "read") {
    const filePath = input?.path ?? input?.file ?? input?.file_path;
    return filePath ? `read ${filePath}` : "read";
  }
  if (toolName === "bash") {
    const command = input?.command;
    return typeof command === "string" && command.trim().length > 0
      ? `bash ${summarizeCommand(command)}` : "bash";
  }
  return toolName;
}

export const redactModule: Module = {
  name: "redact",
  hooks: {
    tool_result: [
      (event, ctx) => {
        if (event.toolName !== "read" && event.toolName !== "bash") return;
        if (!event.content || !Array.isArray(event.content)) return;

        const textParts: Array<{ index: number; item: TextContent; text: string }> = [];
        for (let i = 0; i < event.content.length; i++) {
          const item = event.content[i];
          if (item.type === "text" && typeof item.text === "string" && item.text.length > 0) {
            textParts.push({ index: i, item: item as TextContent, text: item.text });
          }
        }
        if (textParts.length === 0) return;

        let totalCount = 0;
        const counts: Record<"pattern" | "regex" | "entropy", number> = { pattern: 0, regex: 0, entropy: 0 };
        const newContent = [...event.content];
        const filePath = (event.input as any)?.path ?? (event.input as any)?.file ?? (event.input as any)?.file_path;

        for (const { index, text, item } of textParts) {
          const matches = detectSecrets(text, { filePath });
          if (matches.length === 0) continue;
          totalCount += matches.length;
          let redacted = text;
          for (const { start, end, source } of matches.sort((a, b) => b.start - a.start)) {
            counts[source] += 1;
            const original = redacted.slice(start, end);
            redacted = redacted.slice(0, start) + maskSecret(original, source) + redacted.slice(end);
          }
          newContent[index] = { ...item, text: redacted };
        }

        if (totalCount === 0) return;
        const label = totalCount === 1 ? "1 secret" : `${totalCount} secrets`;
        const breakdown: string[] = [];
        if (counts.pattern > 0) breakdown.push(`*:pattern=${counts.pattern}`);
        if (counts.regex > 0) breakdown.push(`#:regex=${counts.regex}`);
        if (counts.entropy > 0) breakdown.push(`?:entropy=${counts.entropy}`);
        const suffix = breakdown.length > 0 ? ` · ${breakdown.join(" ")}` : "";
        const contextLabel = formatRedactionContext(event.toolName, event.input);
        if (ctx.hasUI) ctx.ui.notify(`🔒 [${contextLabel}] Redacted ${label}${suffix}`, "warning");
        return { ...event, content: newContent };
      },
    ],
  },
};

export function setupRedact(sk: Skeleton): void {
  sk.register(redactModule);
}

/**
 * System-prompt guidance for the redact hook — tells the LLM that
 * masked values are real redactions (not "sk-xxx" literal strings),
 * so it shouldn't try to read or reconstruct them.
 */
export const REDACT_GUIDANCE = [
  "### Secret Masking, redacted values are real redactions",
  "- When you see masked secret values (e.g. `sk-***...***` where `*`, `#`, or `?` are mask characters), the real value has been redacted by the system. Do not attempt to read or guess it. If you need the secret, use tools like `jq` or `grep` to extract it from the original source file.",
].join("\n");
