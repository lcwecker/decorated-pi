/**
 * thinking-label-strip — remove stray <thinking></thinking> tags from
 * assistant thinking blocks.
 *
 * Some models wrap their own reasoning text in literal <thinking></thinking>
 * tags inside the `thinking` field of a ThinkingContent block. The tag
 * itself is noise — pi already marks the block as type "thinking", so the
 * tag is redundant. When it leaks into the context it confuses downstream
 * consumers (compaction, other models that echo it back) and pollutes the
 * session transcript.
 *
 * This hook intercepts `message_end` for assistant messages and strips
 * every <thinking></thinking> pair from each ThinkingContent block's text,
 * preserving the reasoning between the tags. The edit is persistent: the
 * stored message is replaced, so the context sent to subsequent LLM calls
 * no longer contains the literal tag.
 */

import type { Module } from "./skeleton.js";

const THINKING_OPEN = "<thinking>";
const THINKING_CLOSE = "</thinking>";

/** Strip a leading <thinking> and/or trailing </thinking> from `text`.
 *  Models often emit these tags as delimiters inside the `thinking` field;
 *  pi already marks the block type, so the tags are noise that leaks into
 *  the context and the TUI. We only trim at the head/tail — tags buried in
 *  the middle are part of the reasoning text and left alone, which avoids
 *  corrupting the model's argument if it literally discusses the tag. */
export function stripThinkingLabels(text: string): string {
  if (!text.includes(THINKING_OPEN) && !text.includes(THINKING_CLOSE)) {
    return text;
  }
  let out = text;
  // trimStart would loop-strip repeating opens; we want a single leading
  // open tag (optionally with whitespace before it) removed.
  const leadingOpen = out.match(/^\s*<thinking>/);
  if (leadingOpen) {
    out = out.slice(leadingOpen[0].length);
  }
  const trailingClose = out.match(/<\/thinking>\s*$/);
  if (trailingClose) {
    out = out.slice(0, out.length - trailingClose[0].length);
  }
  return out;
}

/** Return a new content array with thinking blocks cleaned, or undefined
 *  if nothing changed. */
function cleanContent(content: any[]): any[] | undefined {
  let changed = false;
  const next = content.map((block) => {
    if (block && block.type === "thinking" && typeof block.thinking === "string") {
      const cleaned = stripThinkingLabels(block.thinking);
      if (cleaned !== block.thinking) {
        changed = true;
        return { ...block, thinking: cleaned };
      }
    }
    return block;
  });
  return changed ? next : undefined;
}

export const thinkingLabelStripModule: Module = {
  name: "thinking-label-strip",
  hooks: {
    message_end: [
      (event: any) => {
        const message = event?.message;
        if (!message || message.role !== "assistant") return undefined;
        if (!Array.isArray(message.content)) return undefined;
        const cleaned = cleanContent(message.content);
        if (!cleaned) return undefined;
        return { message: { ...message, content: cleaned } };
      },
    ],
  },
};
