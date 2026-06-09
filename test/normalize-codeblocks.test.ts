/**
 * normalize-codeblocks — unit tests.
 *
 * Tests the pure functions in hooks/normalize-codeblocks.ts.
 * The hook fixes pi-tui's Markdown renderer not expanding tabs or
 * handling CRLF in code blocks.
 */

import { describe, it, expect } from "vitest";
import { normalizeToolResultContent } from "../hooks/normalize-codeblocks.js";

describe("normalizeToolResultContent", () => {
  it("converts CRLF to LF", () => {
    const content = [{ type: "text", text: "line1\r\nline2\r\n" }];
    const result = normalizeToolResultContent(content);
    expect(result).toBeDefined();
    expect(result![0].text).toBe("line1\nline2\n");
  });

  it("converts lone CR to LF", () => {
    const content = [{ type: "text", text: "line1\rline2\r" }];
    const result = normalizeToolResultContent(content);
    expect(result).toBeDefined();
    expect(result![0].text).toBe("line1\nline2\n");
  });

  it("expands tabs to 4 spaces inside code blocks", () => {
    const content = [{ type: "text", text: "```cpp\n\tint x = 1;\n\t\tint y = 2;\n```" }];
    const result = normalizeToolResultContent(content);
    expect(result).toBeDefined();
    expect(result![0].text).toBe("```cpp\n    int x = 1;\n        int y = 2;\n```");
  });

  it("strips trailing whitespace inside code blocks", () => {
    const content = [{ type: "text", text: "```js\nconst x = 1;   \nconst y = 2;\t\t\n```" }];
    const result = normalizeToolResultContent(content);
    expect(result).toBeDefined();
    expect(result![0].text).toBe("```js\nconst x = 1;\nconst y = 2;\n```");
  });

  it("leaves content outside code blocks untouched", () => {
    const content = [{ type: "text", text: "Some text\twith tabs\r\n```cpp\n\tcode\r\n```\r\nMore text\twith tabs\r\n" }];
    const result = normalizeToolResultContent(content);
    expect(result).toBeDefined();
    expect(result![0].text).toBe("Some text\twith tabs\n```cpp\n    code\n```\nMore text\twith tabs\n");
  });

  it("handles multiple code blocks", () => {
    const content = [{ type: "text", text: "```js\n\ta\n```\ntext\n```py\n\tb\n```" }];
    const result = normalizeToolResultContent(content);
    expect(result).toBeDefined();
    expect(result![0].text).toBe("```js\n    a\n```\ntext\n```py\n    b\n```");
  });

  it("handles ~~~ fences", () => {
    const content = [{ type: "text", text: "~~~cpp\n\tint x;\n~~~" }];
    const result = normalizeToolResultContent(content);
    expect(result).toBeDefined();
    expect(result![0].text).toBe("~~~cpp\n    int x;\n~~~");
  });

  it("handles longer fences (`````)", () => {
    const content = [{ type: "text", text: "`````rust\n\tfn main() {}\n`````" }];
    const result = normalizeToolResultContent(content);
    expect(result).toBeDefined();
    expect(result![0].text).toBe("`````rust\n    fn main() {}\n`````");
  });

  it("requires closing fence to match opening length", () => {
    // Opening ```` (4), closing ``` (3) should NOT close the block
    const content = [{ type: "text", text: "````\n\ta\n```\n\tb\n````" }];
    const result = normalizeToolResultContent(content);
    expect(result).toBeDefined();
    expect(result![0].text).toBe("````\n    a\n```\n    b\n````");
  });

  it("requires closing fence to match opening character", () => {
    // Opening ```, closing ~~~ should NOT close the block
    const content = [{ type: "text", text: "```\n\ta\n~~~\n\tb\n```" }];
    const result = normalizeToolResultContent(content);
    expect(result).toBeDefined();
    expect(result![0].text).toBe("```\n    a\n~~~\n    b\n```");
  });

  it("handles empty code blocks", () => {
    const content = [{ type: "text", text: "```\n```" }];
    const result = normalizeToolResultContent(content);
    expect(result).toBeUndefined(); // no changes
  });

  it("handles code block with only whitespace", () => {
    const content = [{ type: "text", text: "```\n\t\n```" }];
    const result = normalizeToolResultContent(content);
    expect(result).toBeDefined();
    expect(result![0].text).toBe("```\n\n```");
  });

  it("handles text with no code blocks and no CRLF", () => {
    const content = [{ type: "text", text: "Just plain text\twith tabs\n" }];
    const result = normalizeToolResultContent(content);
    expect(result).toBeUndefined(); // no changes
  });

  it("handles unclosed code block (normalize until end)", () => {
    const content = [{ type: "text", text: "```\n\ta\n\tb" }];
    const result = normalizeToolResultContent(content);
    expect(result).toBeDefined();
    expect(result![0].text).toBe("```\n    a\n    b");
  });

  it("handles real-world C++ code with CRLF and tabs", () => {
    const content = [{
      type: "text",
      text: "## release_listen\r\n\r\n```cpp\r\n3912\tint c_netserver::release_listen()\r\n3913\t{\r\n3914\t\tif(m_evt_tcp)\r\n3915\t\t{\r\n3916\t\t\tbc_event_free(m_evt_tcp);\r\n3917\t\t}\r\n3918\t}\r\n```"
    }];
    const result = normalizeToolResultContent(content);
    expect(result).toBeDefined();
    expect(result![0].text).toBe(
      "## release_listen\n\n```cpp\n3912    int c_netserver::release_listen()\n3913    {\n3914        if(m_evt_tcp)\n3915        {\n3916            bc_event_free(m_evt_tcp);\n3917        }\n3918    }\n```"
    );
  });

  it("handles multiple content blocks", () => {
    const content = [
      { type: "text", text: "```js\n\ta\n```" },
      { type: "image", data: "base64..." },
      { type: "text", text: "```py\n\tb\n```" },
    ];
    const result = normalizeToolResultContent(content);
    expect(result).toBeDefined();
    expect(result![0].text).toBe("```js\n    a\n```");
    expect(result![1].type).toBe("image");
    expect(result![2].text).toBe("```py\n    b\n```");
  });

  it("handles empty content array", () => {
    const result = normalizeToolResultContent([]);
    expect(result).toBeUndefined();
  });

  it("preserves non-text content blocks", () => {
    const content = [{ type: "image", data: "base64..." }];
    const result = normalizeToolResultContent(content);
    expect(result).toBeUndefined();
  });
});
