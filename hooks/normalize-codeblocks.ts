/**
 * normalize-codeblocks — fix tab rendering in markdown code blocks.
 *
 * pi-tui's Markdown component renders code blocks verbatim without
 * expanding tabs, which breaks line-wrap calculations and produces
 * garbled output (empty lines, misaligned content). This hook
 * normalizes code block content before it reaches the renderer:
 *   - \t → 4 spaces
 *   - strip trailing whitespace per line
 *
 * Only modifies content INSIDE fenced code blocks (``` or ~~~).
 * Everything else passes through untouched.
 */

import type { Module } from "./skeleton.js";

/** Normalize content inside markdown fenced code blocks.
 *  - \t → 4 spaces
 *  - strip trailing whitespace per line
 *  Leaves everything outside code blocks untouched. */
export function normalizeCodeBlocks(text: string): string {
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

/** Normalize all text content blocks in a tool_result event.
 *  Returns modified event, or undefined if no changes. */
export function normalizeToolResultCodeBlocks(event: any): any | undefined {
  if (!Array.isArray(event.content) || event.content.length === 0) return undefined;

  let changed = false;
  const newContent = event.content.map((block: any) => {
    if (block.type !== "text" || typeof block.text !== "string") return block;
    const normalized = normalizeCodeBlocks(block.text);
    if (normalized !== block.text) {
      changed = true;
      return { ...block, text: normalized };
    }
    return block;
  });

  if (!changed) return undefined;
  return { ...event, content: newContent };
}

export const normalizeCodeblocksModule: Module = {
  name: "normalize-codeblocks",
  hooks: {
    tool_result: [
      (event) => {
        return normalizeToolResultCodeBlocks(event);
      },
    ],
  },
};
