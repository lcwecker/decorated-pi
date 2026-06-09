/**
 * Normalize Codeblocks — Unit Tests
 *
 * Tests pure functions exported from hooks/normalize-codeblocks.ts:
 * - normalizeCodeBlocks: normalizes content inside fenced code blocks
 * - normalizeToolResultCodeBlocks: applies normalization to tool_result events
 *
 * The fix addresses a pi-tui bug where tabs inside code blocks break
 * line-wrap calculations, producing garbled output.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeCodeBlocks,
  normalizeToolResultCodeBlocks,
} from "../hooks/normalize-codeblocks.js";

// ═══════════════════════════════════════════════════════════════════════════
// normalizeCodeBlocks
// ═══════════════════════════════════════════════════════════════════════════

describe("normalizeCodeBlocks", () => {
  it("expands tabs to 4 spaces inside code blocks", () => {
    const input = "```cpp\n\tint x = 1;\n\t\tint y = 2;\n```";
    const expected = "```cpp\n    int x = 1;\n        int y = 2;\n```";
    expect(normalizeCodeBlocks(input)).toBe(expected);
  });

  it("strips trailing whitespace inside code blocks", () => {
    const input = "```js\nconst x = 1;   \nconst y = 2;\t\t\n```";
    const expected = "```js\nconst x = 1;\nconst y = 2;\n```";
    expect(normalizeCodeBlocks(input)).toBe(expected);
  });

  it("leaves content outside code blocks untouched", () => {
    const input = "Some text\twith tabs\n```cpp\n\tcode\n```\nMore text\twith tabs";
    const expected = "Some text\twith tabs\n```cpp\n    code\n```\nMore text\twith tabs";
    expect(normalizeCodeBlocks(input)).toBe(expected);
  });

  it("handles multiple code blocks", () => {
    const input = "```js\n\ta\n```\ntext\n```py\n\tb\n```";
    const expected = "```js\n    a\n```\ntext\n```py\n    b\n```";
    expect(normalizeCodeBlocks(input)).toBe(expected);
  });

  it("handles ~~~ fences", () => {
    const input = "~~~cpp\n\tint x;\n~~~";
    const expected = "~~~cpp\n    int x;\n~~~";
    expect(normalizeCodeBlocks(input)).toBe(expected);
  });

  it("handles longer fences (`````)", () => {
    const input = "`````rust\n\tfn main() {}\n`````";
    const expected = "`````rust\n    fn main() {}\n`````";
    expect(normalizeCodeBlocks(input)).toBe(expected);
  });

  it("requires closing fence to match opening length", () => {
    // Opening ```` (4), closing ``` (3) should NOT close the block
    const input = "````\n\ta\n```\n\tb\n````";
    const expected = "````\n    a\n```\n    b\n````";
    expect(normalizeCodeBlocks(input)).toBe(expected);
  });

  it("requires closing fence to match opening character", () => {
    // Opening ```, closing ~~~ should NOT close the block
    const input = "```\n\ta\n~~~\n\tb\n```";
    const expected = "```\n    a\n~~~\n    b\n```";
    expect(normalizeCodeBlocks(input)).toBe(expected);
  });

  it("handles empty code blocks", () => {
    const input = "```\n```";
    expect(normalizeCodeBlocks(input)).toBe(input);
  });

  it("handles code block with only whitespace", () => {
    const input = "```\n\t\n```";
    const expected = "```\n\n```";
    expect(normalizeCodeBlocks(input)).toBe(expected);
  });

  it("handles text with no code blocks", () => {
    const input = "Just plain text\twith tabs";
    expect(normalizeCodeBlocks(input)).toBe(input);
  });

  it("handles unclosed code block (normalize until end)", () => {
    const input = "```\n\ta\n\tb";
    const expected = "```\n    a\n    b";
    expect(normalizeCodeBlocks(input)).toBe(expected);
  });

  it("handles real-world C++ code with mixed indentation", () => {
    const input = `## release_listen (method)

**Location:** nets_server.cpp:3912

\`\`\`cpp
3912\tint c_netserver::release_listen()
3913\t{
3914\t\tif(m_evt_tcp)
3915\t\t{
3916\t\t\tbc_event_free(m_evt_tcp);
3917\t\t\tm_evt_tcp = NULL;
3918\t\t}
3919\t\treturn 0;
3920\t}
\`\`\``;
    const expected = `## release_listen (method)

**Location:** nets_server.cpp:3912

\`\`\`cpp
3912    int c_netserver::release_listen()
3913    {
3914        if(m_evt_tcp)
3915        {
3916            bc_event_free(m_evt_tcp);
3917            m_evt_tcp = NULL;
3918        }
3919        return 0;
3920    }
\`\`\``;
    expect(normalizeCodeBlocks(input)).toBe(expected);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// normalizeToolResultCodeBlocks
// ═══════════════════════════════════════════════════════════════════════════

describe("normalizeToolResultCodeBlocks", () => {
  it("normalizes text content blocks", () => {
    const event = {
      toolName: "codegraph_node",
      content: [{ type: "text", text: "```cpp\n\tint x;\n```" }],
    };
    const result = normalizeToolResultCodeBlocks(event);
    expect(result).toBeDefined();
    expect(result!.content[0].text).toBe("```cpp\n    int x;\n```");
  });

  it("returns undefined when no changes needed", () => {
    const event = {
      toolName: "read",
      content: [{ type: "text", text: "plain text, no code blocks" }],
    };
    expect(normalizeToolResultCodeBlocks(event)).toBeUndefined();
  });

  it("handles multiple content blocks", () => {
    const event = {
      toolName: "test",
      content: [
        { type: "text", text: "```js\n\ta\n```" },
        { type: "image", data: "base64..." },
        { type: "text", text: "```py\n\tb\n```" },
      ],
    };
    const result = normalizeToolResultCodeBlocks(event);
    expect(result).toBeDefined();
    expect(result!.content[0].text).toBe("```js\n    a\n```");
    expect(result!.content[1].type).toBe("image");
    expect(result!.content[2].text).toBe("```py\n    b\n```");
  });

  it("handles empty content array", () => {
    const event = { toolName: "test", content: [] };
    expect(normalizeToolResultCodeBlocks(event)).toBeUndefined();
  });

  it("handles missing content", () => {
    const event = { toolName: "test" };
    expect(normalizeToolResultCodeBlocks(event)).toBeUndefined();
  });

  it("preserves non-text content blocks", () => {
    const event = {
      toolName: "test",
      content: [{ type: "image", data: "base64..." }],
    };
    expect(normalizeToolResultCodeBlocks(event)).toBeUndefined();
  });
});
