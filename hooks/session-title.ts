/**
 * session-title — auto-derive session name from the first user message.
 * Skips if user already manually /renamed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Module } from "./skeleton.js";

export const MAX_SESSION_TITLE_LENGTH = 80;

interface SessionEntryLike {
  type: string;
  message?: { role: string; content?: unknown };
}

function pickFirstUserText(content: unknown): string | undefined {
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        return part.text.trim();
      }
    }
  }
  return undefined;
}

/** Extract a single-line title from the first user message. */
export function extractFirstMessage(entries: SessionEntryLike[]): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message || entry.message.role !== "user") continue;
    const raw = pickFirstUserText(entry.message.content);
    if (!raw) continue;
    const nl = raw.indexOf("\n");
    const oneLine = (nl === -1 ? raw : raw.slice(0, nl)).trim();
    if (!oneLine) continue;
    if (oneLine.length <= MAX_SESSION_TITLE_LENGTH) return oneLine;
    return oneLine.slice(0, MAX_SESSION_TITLE_LENGTH - 1) + "…";
  }
  return undefined;
}

function normalizeTitle(text: string): string | undefined {
  const nl = text.indexOf("\n");
  const oneLine = (nl === -1 ? text : text.slice(0, nl)).trim();
  if (!oneLine) return undefined;
  if (oneLine.length <= MAX_SESSION_TITLE_LENGTH) return oneLine;
  return oneLine.slice(0, MAX_SESSION_TITLE_LENGTH - 1) + "…";
}

function trySetSessionName(ctx: any, pi: ExtensionAPI): void {
  if (ctx.sessionManager.getSessionName()) return;
  const title = extractFirstMessage(ctx.sessionManager.getBranch());
  if (title) (pi as any).setSessionName(title);
}

export const sessionTitleModule: Module = {
  name: "session-title",
  hooks: {
    session_start: [
      (_event, ctx, pi) => {
        trySetSessionName(ctx, pi);
      },
    ],
    input: [
      (event, ctx, pi) => {
        // Skip if already named, not a fresh interactive message,
        // or stream steering/follow-up messages.
        if (ctx.sessionManager.getSessionName()) return;
        if (event.source === "extension") return;
        if (event.streamingBehavior) return;
        const text = typeof event.text === "string" ? event.text.trim() : "";
        const title = normalizeTitle(text);
        if (title) (pi as any).setSessionName(title);
      },
    ],
  },
};
