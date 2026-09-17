import { describe, it, expect, vi } from "vitest";
import { __lspToolsTest, registerLspTools } from "../tools/lsp/tools.js";

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

function captureLspTool(manager: any): any {
  let captured: any;
  const pi = { registerTool: (tool: any) => { captured = tool; } };
  registerLspTools(pi as any, manager);
  return captured;
}

describe("lsp_diagnostics cancellation", () => {
  it("forwards the abort signal to resolveFileState and waitForDiagnostics", async () => {
    const waitForDiagnostics = vi.fn(async () => []);
    const manager = {
      resolveFileState: vi.fn(async () => ({
        ok: true,
        result: { abs: "/cwd/a.ts", uri: "file:///cwd/a.ts", state: { client: { waitForDiagnostics } } },
      })),
    };
    const tool = captureLspTool(manager);
    const controller = new AbortController();
    await tool.execute("id1", { paths: ["a.ts"] }, controller.signal, () => {}, {});
    expect(manager.resolveFileState).toHaveBeenCalledWith("a.ts", { timeoutMs: 30_000, signal: controller.signal });
    expect(waitForDiagnostics).toHaveBeenCalledWith("file:///cwd/a.ts", 1500, controller.signal);
  });

  it("rethrows cancellation instead of returning a tool error", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("This operation was aborted", "AbortError");
    const waitForDiagnostics = vi.fn(async () => {
      controller.abort();
      throw abortError;
    });
    const manager = {
      resolveFileState: vi.fn(async () => ({
        ok: true,
        result: { abs: "/cwd/a.ts", uri: "file:///cwd/a.ts", state: { client: { waitForDiagnostics } } },
      })),
    };
    const tool = captureLspTool(manager);
    await expect(tool.execute("id1", { paths: ["a.ts"] }, controller.signal, () => {}, {})).rejects.toMatchObject({ name: "AbortError" });
  });

  it("withTimeout rejects on abort instead of resolving a timeout result", async () => {
    const controller = new AbortController();
    const pending = __lspToolsTest.withTimeout(new Promise<any>(() => {}), 1000, "LSP diagnostics", controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
  });

  it("withTimeout still resolves a timeout result without a signal", async () => {
    const result = await __lspToolsTest.withTimeout(new Promise<any>(() => {}), 10, "LSP diagnostics");
    expect(result.content[0].text).toContain("timed out after 10ms");
  });
});
