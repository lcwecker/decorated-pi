/**
 * normalize-codeblocks — fix markdown code block rendering in TUI.
 *
 * pi-tui's Markdown renderer doesn't expand tabs or handle CRLF in code
 * blocks, causing garbled output (empty lines, misaligned content).
 *
 * This hook intercepts tool_result events and normalizes fenced code
 * blocks (``` or ~~~):
 *   - CRLF → LF (entire text)
 *   - tabs → 4 spaces (inside code blocks only)
 *   - strip trailing whitespace (inside code blocks only)
 *
 * Content outside code blocks is left untouched.
 */

import type { Module } from "./skeleton.js";

/** Normalize CRLF line endings to LF. */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Normalize content inside markdown fenced code blocks.
 *  - \t → 4 spaces
 *  - strip trailing whitespace per line
 *  Leaves everything outside code blocks untouched. */
function normalizeCodeBlockContent(text: string): string {
  const lines = text.split("\n");
  let inCodeBlock = false;
  let fenceChar = "";
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^(`{3,}|~{3,})/);

    if (!inCodeBlock) {
      if (fenceMatch) {
        inCodeBlock = true;
        fenceChar = fenceMatch[1][0];
        fenceLen = fenceMatch[1].length;
      }
    } else {
      // Check for closing fence (same char, length >= opening)
      if (fenceMatch && fenceMatch[1][0] === fenceChar && fenceMatch[1].length >= fenceLen) {
        inCodeBlock = false;
      } else {
        // Inside code block: normalize
        lines[i] = line.replace(/\t/g, "    ").replace(/[ \t]+$/, "");
      }
    }
  }

  return lines.join("\n");
}

/** Normalize a tool result's text content.
 *  Returns modified content array, or undefined if no changes. */
export function normalizeToolResultContent(content: any[]): any[] | undefined {
  let changed = false;
  const newContent = content.map((block) => {
    if (block.type !== "text" || typeof block.text !== "string") return block;
    // First normalize line endings (entire text)
    let text = normalizeLineEndings(block.text);
    // Then normalize code block content
    text = normalizeCodeBlockContent(text);
    if (text !== block.text) {
      changed = true;
      return { ...block, text };
    }
    return block;
  });
  return changed ? newContent : undefined;
}

export const normalizeCodeblocksModule: Module = {
  name: "normalize-codeblocks",
  hooks: {
    tool_result: [
      (event) => {
        if (!Array.isArray(event.content)) return undefined;
        const newContent = normalizeToolResultContent(event.content);
        if (!newContent) return undefined;
        return { ...event, content: newContent };
      },
    ],
  },
};
