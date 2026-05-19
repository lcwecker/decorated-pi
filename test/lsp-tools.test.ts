import { describe, it, expect } from "vitest";
import { __lspToolsTest } from "../extensions/lsp/tools.js";

describe("lsp tool result folding", () => {
  it("does not fold when output has 20 lines or fewer", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = __lspToolsTest.collapse_lsp_text(text);

    expect(result.totalLines).toBe(20);
    expect(result.displayLines).toHaveLength(20);
    expect(result.remainingLines).toBe(0);
  });

  it("folds after 20 lines", () => {
    const text = Array.from({ length: 23 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = __lspToolsTest.collapse_lsp_text(text);

    expect(result.totalLines).toBe(23);
    expect(result.displayLines).toHaveLength(20);
    expect(result.displayLines[0]).toBe("line 1");
    expect(result.displayLines[19]).toBe("line 20");
    expect(result.remainingLines).toBe(3);
  });

  it("ignores trailing empty lines when counting fold length", () => {
    const text = `${Array.from({ length: 21 }, (_, i) => `line ${i + 1}`).join("\n")}\n\n`;
    const result = __lspToolsTest.collapse_lsp_text(text);

    expect(result.totalLines).toBe(21);
    expect(result.displayLines).toHaveLength(20);
    expect(result.remainingLines).toBe(1);
  });
});
