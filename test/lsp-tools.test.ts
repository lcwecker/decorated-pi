import { describe, it, expect } from "vitest";
import { __lspToolsTest } from "../tools/lsp/tools.js";

describe("lsp tool result folding", () => {
  it("does not fold when output has 45 lines or fewer", () => {
    const text = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = __lspToolsTest.collapse_lsp_text(text);

    expect(result.totalLines).toBe(45);
    expect(result.displayLines).toHaveLength(45);
    expect(result.remainingLines).toBe(0);
  });

  it("folds after 45 lines", () => {
    const text = Array.from({ length: 48 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = __lspToolsTest.collapse_lsp_text(text);

    expect(result.totalLines).toBe(48);
    expect(result.displayLines).toHaveLength(45);
    expect(result.displayLines[0]).toBe("line 1");
    expect(result.displayLines[44]).toBe("line 45");
    expect(result.remainingLines).toBe(3);
  });

  it("ignores trailing empty lines when counting fold length", () => {
    const text = `${Array.from({ length: 46 }, (_, i) => `line ${i + 1}`).join("\n")}\n\n`;
    const result = __lspToolsTest.collapse_lsp_text(text);

    expect(result.totalLines).toBe(46);
    expect(result.displayLines).toHaveLength(45);
    expect(result.remainingLines).toBe(1);
  });
});
