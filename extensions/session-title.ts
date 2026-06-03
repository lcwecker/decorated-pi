/**
 * Session Title — 自动从首条消息设置 session name
 *
 * Pi 在 resume 列表已经用 firstMessage 显示，但 footer 不显示。
 * 这个模块从 session entries 读取首条用户消息，设为 session name，
 * 让 footer 行1 和 terminal title 也能显示。
 * 用户手动 /rename 后不再覆盖。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Maximum length of the auto-derived session title. Single-line TUI footers
 *  break easily, so we cap in addition to newline truncation. */
export const MAX_SESSION_TITLE_LENGTH = 80;

interface SessionEntryLike {
  type: string;
  message?: { role: string; content?: unknown };
}

function pickFirstUserText(content: unknown): string | undefined {
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        return part.text.trim();
      }
    }
  }
  return undefined;
}

/** Extract a single-line title from the first user message.
 *  Truncates at the first newline and caps length to keep the TUI footer safe. */
export function extractFirstMessage(entries: SessionEntryLike[]): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message || entry.message.role !== "user") continue;

    const raw = pickFirstUserText(entry.message.content);
    if (!raw) continue;

    // Truncate at first newline to avoid breaking TUI footer layout.
    const nl = raw.indexOf("\n");
    const oneLine = (nl === -1 ? raw : raw.slice(0, nl)).trim();
    if (!oneLine) continue;

    // Cap length to keep footer/terminal title rows short.
    if (oneLine.length <= MAX_SESSION_TITLE_LENGTH) return oneLine;
    return oneLine.slice(0, MAX_SESSION_TITLE_LENGTH - 1) + "…";
  }
  return undefined;
}

export function setupSessionTitle(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.sessionManager.getSessionName()) return;

    const title = extractFirstMessage(ctx.sessionManager.getBranch());
    if (title) {
      pi.setSessionName(title);
    }
  });
}
