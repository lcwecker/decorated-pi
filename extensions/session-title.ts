/**
 * Session Title — 自动从首条消息设置 session name
 *
 * Pi 在 resume 列表已经用 firstMessage 显示，但 footer 不显示。
 * 这个模块从 session entries 读取首条用户消息，设为 session name，
 * 让 footer 行1 和 terminal title 也能显示。
 * 用户手动 /rename 后不再覆盖。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function extractFirstMessage(entries: Array<{ type: string; message?: { role: string; content?: unknown } }>): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message || entry.message.role !== "user") continue;

    const content = entry.message.content;
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
