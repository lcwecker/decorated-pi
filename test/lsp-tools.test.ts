/**
 * tools/lsp/tools.ts — the four navigation/rename tools.
 *
 * The manager is a stub, so these assert the wiring: which LSP call each tool
 * makes, how the result reads back, and that rename writes (or does not write)
 * as asked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __lspToolsTest, registerLspTools } from "../tools/lsp/tools.js";

function captureTools(manager: any): Record<string, any> {
  const tools: Record<string, any> = {};
  registerLspTools({ registerTool: (tool: any) => { tools[tool.name] = tool; } } as any, manager);
  return tools;
}

function mockManager(client: any) {
  return {
    resolveFileState: vi.fn(async (file: string) => ({
      ok: true as const,
      result: { abs: `/cwd/${file}`, uri: `file:///cwd/${file}`, state: { client } },
    })),
  };
}

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "decorated-pi-lsp-tools-"));
  tempDirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, contents);
  return file;
}

// ═════════════════════════════════════════════════════════════════════════════
// Registration
// ═════════════════════════════════════════════════════════════════════════════

describe("registerLspTools", () => {
  it("registers navigation and rename, and no diagnostics tool", () => {
    const tools = captureTools(mockManager({}));
    expect(Object.keys(tools).sort()).toEqual([
      "lsp_definition",
      "lsp_document_symbols",
      "lsp_references",
      "lsp_rename",
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Positions and results
// ═════════════════════════════════════════════════════════════════════════════

describe("lsp_definition", () => {
  it("converts one-based input, forwards the signal, and formats the location", async () => {
    const definition = vi.fn(async () => [{ uri: "file:///cwd/a.ts", range: range(4, 6, 4, 11) }]);
    const manager = mockManager({ definition });
    const tool = captureTools(manager).lsp_definition;
    const controller = new AbortController();

    const result = await tool.execute("id", { path: "other.ts", line: 3, character: 7 }, controller.signal, () => {}, {});

    // 3:7 one-based → 2:6 on the wire.
    expect(definition).toHaveBeenCalledWith("file:///cwd/other.ts", { line: 2, character: 6 }, 30_000, controller.signal);
    expect(result.content[0].text).toBe("/cwd/a.ts:5:7");
    expect(result.details).toMatchObject({ ok: true, count: 1 });
  });

  it("explains an empty answer at the position asked about", async () => {
    const manager = mockManager({ definition: vi.fn(async () => []) });
    const result = await captureTools(manager).lsp_definition.execute("id", { path: "a.ts", line: 2, character: 4 }, undefined, () => {}, {});
    expect(result.content[0].text).toBe("a.ts: no definition found at 2:4");
  });
});

describe("lsp_references", () => {
  it("includes the declaration by default and counts the hits", async () => {
    const references = vi.fn(async () => [
      { uri: "file:///cwd/a.ts", range: range(0, 0, 0, 3) },
      { uri: "file:///cwd/b.ts", range: range(1, 1, 1, 4) },
    ]);
    const manager = mockManager({ references });
    const result = await captureTools(manager).lsp_references.execute(
      "id", { path: "a.ts", line: 1, character: 1 }, undefined, () => {}, {},
    );

    expect(references).toHaveBeenCalledWith("file:///cwd/a.ts", { line: 0, character: 0 }, true, 30_000, undefined);
    expect(result.details.count).toBe(2);
    expect(result.content[0].text).toContain("/cwd/b.ts:2:2");
  });
});

describe("lsp_document_symbols", () => {
  it("formats the outline", async () => {
    const documentSymbols = vi.fn(async () => [
      { name: "main", kind: 12, range: range(2, 0, 4, 1), selectionRange: range(2, 9, 2, 13) },
    ]);
    const manager = mockManager({ documentSymbols });
    const result = await captureTools(manager).lsp_document_symbols.execute("id", { path: "a.ts" }, undefined, () => {}, {});
    expect(result.content[0].text).toBe("main (function) 3:10");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// lsp_rename
// ═════════════════════════════════════════════════════════════════════════════

describe("lsp_rename", () => {
  it("writes the server's edits and reports the counts", async () => {
    const file = tempFile("a.ts", "const value = 1;\nuse(value);\n");
    const rename = vi.fn(async () => ({
      [file]: [
        { range: range(0, 6, 0, 11), newText: "total" },
        { range: range(1, 4, 1, 9), newText: "total" },
      ],
    }));
    const manager = mockManager({ rename });

    const result = await captureTools(manager).lsp_rename.execute(
      "id", { path: "a.ts", line: 1, character: 7, new_name: "total" }, undefined, () => {}, {},
    );

    expect(readFileSync(file, "utf-8")).toBe("const total = 1;\nuse(total);\n");
    expect(result.content[0].text).toContain('Renamed to "total": 2 edit(s) in 1 file(s).');
    expect(result.content[0].text).toContain(`${file} (2 edit(s))`);
    expect(result.details).toMatchObject({ ok: true, files: 1, edits: 2 });
  });

  it("previews without writing when preview is set", async () => {
    const file = tempFile("a.ts", "const value = 1;\n");
    const rename = vi.fn(async () => ({ [file]: [{ range: range(0, 6, 0, 11), newText: "total" }] }));
    const manager = mockManager({ rename });

    const result = await captureTools(manager).lsp_rename.execute(
      "id", { path: "a.ts", line: 1, character: 7, new_name: "total", preview: true }, undefined, () => {}, {},
    );

    expect(readFileSync(file, "utf-8")).toBe("const value = 1;\n");
    expect(result.details).toMatchObject({ ok: true, preview: true });
    expect(result.content[0].text).toContain(`${file}: 1 edit(s)`);
  });

  it("reports a position that holds no renamable symbol", async () => {
    const manager = mockManager({ rename: vi.fn(async () => ({})) });
    const result = await captureTools(manager).lsp_rename.execute(
      "id", { path: "a.ts", line: 1, character: 1, new_name: "x" }, undefined, () => {}, {},
    );
    expect(result.content[0].text).toContain("no rename edits");
    expect(result.details).toMatchObject({ ok: true, files: 0, edits: 0 });
  });

  it("renames across two files", async () => {
    const definition = tempFile("math.ts", "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    const dir = mkdtempSync(join(tmpdir(), "decorated-pi-lsp-two-"));
    tempDirs.push(dir);
    const usage = join(dir, "use.ts");
    writeFileSync(usage, 'import { add } from "./math.js";\nexport const total = add(1, 2);\n');

    const rename = vi.fn(async () => ({
      [definition]: [{ range: range(0, 16, 0, 19), newText: "sum" }],
      [usage]: [
        { range: range(0, 9, 0, 12), newText: "sum" },
        { range: range(1, 21, 1, 24), newText: "sum" },
      ],
    }));
    const result = await captureTools(mockManager({ rename })).lsp_rename.execute(
      "id", { path: "math.ts", line: 1, character: 17, new_name: "sum" }, undefined, () => {}, {},
    );

    expect(readFileSync(definition, "utf-8")).toContain("export function sum(");
    expect(readFileSync(usage, "utf-8")).toBe('import { sum } from "./math.js";\nexport const total = sum(1, 2);\n');
    expect(result.details).toMatchObject({ ok: true, files: 2, edits: 3 });
  });

  it("refuses a workspace edit touching a non-file URI, writing nothing", async () => {
    const file = tempFile("a.ts", "const value = 1;\n");
    const rename = vi.fn(async () => ({ [file]: [{ range: range(0, 6, 0, 11), newText: "x" }], "untitled:Untitled-1": [{ range: range(0, 0, 0, 1), newText: "x" }] }));
    const result = await captureTools(mockManager({ rename })).lsp_rename.execute(
      "id", { path: "a.ts", line: 1, character: 7, new_name: "x" }, undefined, () => {}, {},
    );

    expect(readFileSync(file, "utf-8")).toBe("const value = 1;\n");
    expect(result.content[0].text).toContain("not local files");
    expect(result.details).toMatchObject({ ok: false, files: 0, edits: 0 });
  });

  it("leaves the workspace intact when a target cannot be read", async () => {
    const file = tempFile("a.ts", "const value = 1;\n");
    const dir = mkdtempSync(join(tmpdir(), "decorated-pi-lsp-dir-"));
    tempDirs.push(dir);
    // A directory as a rename target makes the read phase fail before any write.
    const rename = vi.fn(async () => ({ [file]: [{ range: range(0, 6, 0, 11), newText: "x" }], [dir]: [{ range: range(0, 0, 0, 1), newText: "x" }] }));
    const result = await captureTools(mockManager({ rename })).lsp_rename.execute(
      "id", { path: "a.ts", line: 1, character: 7, new_name: "x" }, undefined, () => {}, {},
    );

    expect(readFileSync(file, "utf-8")).toBe("const value = 1;\n");
    expect(result.content[0].text).toContain("No file was written");
    expect(result.details.ok).toBe(false);
  });

  it("names files the rename left unchanged", async () => {
    const file = tempFile("a.ts", "const value = 1;\n");
    const rename = vi.fn(async () => ({ [file]: [{ range: range(0, 6, 0, 11), newText: "value" }] }));
    const result = await captureTools(mockManager({ rename })).lsp_rename.execute(
      "id", { path: "a.ts", line: 1, character: 7, new_name: "value" }, undefined, () => {}, {},
    );

    expect(readFileSync(file, "utf-8")).toBe("const value = 1;\n");
    expect(result.content[0].text).toContain("Unchanged:");
    expect(result.details).toMatchObject({ ok: true, files: 0, edits: 0 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Position and name validation
// ═════════════════════════════════════════════════════════════════════════════

describe("lsp position validation", () => {
  it("rejects a zero-based position instead of clamping it", async () => {
    const manager = mockManager({ definition: vi.fn() });
    const result = await captureTools(manager).lsp_definition.execute(
      "id", { path: "a.ts", line: 0, character: 0 }, undefined, () => {}, {},
    );
    expect(result.content[0].text).toContain("one-based");
    expect(result.details.ok).toBe(false);
    // No server is started for a position that cannot be meant.
    expect(manager.resolveFileState).not.toHaveBeenCalled();
  });

  it("rejects a blank new_name", async () => {
    const manager = mockManager({ rename: vi.fn() });
    const result = await captureTools(manager).lsp_rename.execute(
      "id", { path: "a.ts", line: 1, character: 1, new_name: "   " }, undefined, () => {}, {},
    );
    expect(result.content[0].text).toContain("not be blank");
    expect(manager.resolveFileState).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Errors, cancellation and timeouts
// ═════════════════════════════════════════════════════════════════════════════

describe("lsp tool error handling", () => {
  it("reports an unsupported language as the tool's message", async () => {
    const manager = {
      resolveFileState: vi.fn(async () => ({
        ok: false as const,
        error: { kind: "unsupported_language", file: "/cwd/a.xyz", message: "No language server configured for /cwd/a.xyz" },
      })),
    };
    const result = await captureTools(manager).lsp_definition.execute("id", { path: "a.xyz", line: 1, character: 1 }, undefined, () => {}, {});
    expect(result.content[0].text).toBe("No language server configured for /cwd/a.xyz");
    expect(result.details.ok).toBe(false);
  });

  it("rethrows cancellation instead of returning a tool error", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("This operation was aborted", "AbortError");
    const manager = mockManager({
      definition: vi.fn(async () => {
        controller.abort();
        throw abortError;
      }),
    });
    await expect(
      captureTools(manager).lsp_definition.execute("id", { path: "a.ts", line: 1, character: 1 }, controller.signal, () => {}, {}),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("withTimeout rejects on abort instead of resolving a timeout result", async () => {
    const controller = new AbortController();
    const pending = __lspToolsTest.withTimeout(new Promise<any>(() => {}), 1000, "LSP definition", controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
  });

  it("withTimeout resolves a timeout result without a signal", async () => {
    const result = await __lspToolsTest.withTimeout(new Promise<any>(() => {}), 10, "LSP definition");
    expect(result.content[0].text).toContain("timed out after 10ms");
  });
});
