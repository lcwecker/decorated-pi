/**
 * Safety — Pi 集成层
 *
 * - Command Guard:   拦截危险 bash 命令
 * - Redirect Guard:  bash 覆盖写入提示确认
 * - Protected Paths: write/edit/read 保护路径提示确认
 * - Write Guard:     覆盖非空文件禁止 write
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

    // Gate 2: write/edit 写入保护路径
    if (event.toolName === "write" || event.toolName === "edit") {
      const filePath = (event.input as any).path ?? (event.input as any).file ?? (event.input as any).file_path;
      if (filePath) {
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
            return { block: true, reason: "Overwriting a non-empty file is dangerous, use the edit tool instead!" };
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

    // Only scan read tool output — other tools (bash, write, edit) are either
    // covered by path guards or produce git/diff noise that causes false positives.
    if (event.toolName !== "read") return;

    const textParts: Array<{ index: number; text: string; item: ToolTextContent }> = [];
    for (let i = 0; i < event.content.length; i++) {
      const item = event.content[i];
      if (item.type === "text" && typeof item.text === "string" && item.text.length > 0) {
        textParts.push({ index: i, text: item.text, item });
      }
    }
    if (textParts.length === 0) return;

    let totalCount = 0;
    const newContent = [...event.content];

    for (const { index, text, item } of textParts) {
      const matches = detectSecrets(text);
      if (matches.length === 0) continue;

      totalCount += matches.length;
      let redacted = text;
      for (const { start, end } of matches) {
        const original = redacted.slice(start, end);
        redacted = redacted.slice(0, start) + maskSecret(original) + redacted.slice(end);
      }
      const updatedItem: ToolTextContent = { ...item, text: redacted };
      newContent[index] = updatedItem;
    }

    if (totalCount === 0) return;
    const label = totalCount === 1 ? "1 secret" : `${totalCount} secrets`;
    ctx.ui.notify(`🔒 Redacted ${label} in ${event.toolName} output`, "warning");
    return { content: newContent };
  };

  pi.on("tool_result", handleToolResult);
}