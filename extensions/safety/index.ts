/**
 * Safety — Pi 集成层
 *
 * - Command Guard:   拦截危险 bash 命令
 * - Redirect Guard:  bash 覆盖写入提示确认
 * - Protected Paths: write/edit/patch/read 保护路径提示确认
 * - Write Guard:     覆盖非空文件禁止 write (提示使用 patch)
 * - Secret Redact:   API Key / Token 自动掩码
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { resolve } from "node:path";
import {
  checkProtectedPath,
  collectBashDangers,
  formatBashDangers,
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
  // ── Command Guard + Protected Paths + Write Guard (tool_call) ─────────

  pi.on("tool_call", async (event, ctx) => {

    // Gate 1: 危险命令 + 覆盖写入 + 读取保护路径
    if (event.toolName === "bash") {
      const command = (event.input as { command?: string }).command;
      if (command) {
        const dangers = collectBashDangers(command, ctx.cwd);
        if (dangers.length > 0) {
          const message = formatBashDangers(dangers)!;
          if (!ctx.hasUI) {
            return { block: true, reason: `⚠ ${message} (non-interactive)` };
          }
          const choice = await ctx.ui.select(
            `⚠️  ${message}\n\nAllow execution?`,
            ["Block", "Allow once"],
          );
          if (!choice || choice === "Block") {
            return { block: true, reason: `⚠ ${message}` };
          }
        }
      }
    }

    // Gate 2: write/edit/patch 写入保护路径
    if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "patch") {
      // For write/edit, path is a single field; for patch, check all patches[].path
      const filePaths: string[] = event.toolName === "patch"
        ? (event.input as any).patches?.filter((p: any) => p?.path).map((p: any) => p.path) ?? []
        : [(event.input as any).path ?? (event.input as any).file ?? (event.input as any).file_path].filter(Boolean);
      for (const filePath of filePaths) {
        const danger = checkProtectedPath(filePath);
        if (danger) {
          if (!ctx.hasUI) {
            return { block: true, reason: `🔒 ${danger}\nmay contain sensitive information` };
          }
          const choice = await ctx.ui.select(
            `🔒 ${danger}\nmay contain sensitive information\n\nProceed?`,
            ["Block", "Allow once"],
          );
          if (!choice || choice === "Block") {
            return { block: true, reason: `🔒 ${danger}\nmay contain sensitive information` };
          }
          break; // User approved — skip remaining paths
        }
      }
    }

    // Gate 3: 写保护（已有内容的文件禁止 write，直接返回信息给 agent）
    if (event.toolName === "write") {
      const filePath = (event.input as any).path ?? (event.input as any).file ?? (event.input as any).file_path;
      if (filePath) {
        try {
          const abs = resolve(ctx.cwd, filePath);
          if (fs.existsSync(abs) && fs.readFileSync(abs, "utf8").length > 0) {
            return { block: true, reason: "Overwriting a non-empty file is dangerous, use the patch tool instead!" };
          }
        } catch { /* file doesn't exist */ }
      }
    }

    // Gate 4: read 工具读取保护路径（bash 读取已在 Gate 1 处理）
    if (event.toolName === "read") {
      const filePath = (event.input as any).path ?? (event.input as any).file ?? (event.input as any).file_path;
      if (filePath) {
        const danger = checkProtectedPath(filePath);
        if (danger) {
          if (!ctx.hasUI) {
            return { block: true, reason: `🔒 Reading protected file: ${danger}\nmay contain sensitive information` };
          }
          const choice = await ctx.ui.select(
            `🔒 Reading protected file: ${danger}\nmay contain sensitive information\n\nProceed?`,
            ["Block", "Allow once"],
          );
          if (!choice || choice === "Block") {
            return { block: true, reason: `🔒 Reading protected file: ${danger}\nmay contain sensitive information` };
          }
        }
      }
    }
  });

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
