import { describe, expect, it } from "vitest";
import { __mcpIndexTest } from "../tools/mcp/index.js";

describe("mcp tool result folding", () => {
  it("does not fold when output has 45 lines or fewer", () => {
    const text = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = __mcpIndexTest.collapseMcpText(text);
    expect(result.totalLines).toBe(45);
    expect(result.displayLines).toHaveLength(45);
    expect(result.remainingLines).toBe(0);
  });

  it("folds after 45 lines", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = __mcpIndexTest.collapseMcpText(text);
    expect(result.totalLines).toBe(50);
    expect(result.displayLines).toHaveLength(45);
    expect(result.displayLines.at(-1)).toBe("line 45");
    expect(result.remainingLines).toBe(5);
  });

  it("ignores trailing empty lines when counting fold length", () => {
    const text = `${Array.from({ length: 46 }, (_, i) => `line ${i + 1}`).join("\n")}\n\n\n`;
    const result = __mcpIndexTest.collapseMcpText(text);
    expect(result.totalLines).toBe(46);
    expect(result.displayLines).toHaveLength(45);
    expect(result.remainingLines).toBe(1);
  });
});
