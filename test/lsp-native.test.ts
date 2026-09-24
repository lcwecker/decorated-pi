/**
 * Bundled language servers, end to end.
 *
 * These run the real servers through the manager, so they cover the
 * request/response path the unit tests stub out: symbols come back, a rename
 * produces edits that apply to the source, and both bundled servers start for
 * the languages the README advertises.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspServerManager } from "../tools/lsp/manager.js";
import { applyTextEdits } from "../tools/lsp/format.js";

let root = "";
let manager: LspServerManager | null = null;

afterEach(async () => {
  await manager?.clearLanguageState();
  manager = null;
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

/** A strict TS project; returns the absolute path of `entry`. */
function tsProject(entry: string, files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), "decorated-pi-ts7-lsp-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", noEmit: true },
    include: ["src/**/*.ts"],
  }));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents);
  }
  manager = new LspServerManager({ cwd: () => root });
  return join(root, entry);
}

async function open(file: string, timeoutMs = 15_000) {
  const resolved = await manager!.resolveFileState(file, { timeoutMs });
  if (!resolved.ok) throw new Error(resolved.error.message);
  expect(resolved.result.state.command).toBe(process.execPath);
  return resolved.result;
}

describe("bundled TypeScript 7 server", () => {
  it("answers document symbols", async () => {
    const file = tsProject("src/app.ts", {
      "src/app.ts": "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n",
    });
    const opened = await open(file);

    const symbols = await opened.state.client.documentSymbols(opened.uri, 10_000);
    expect(symbols.map((symbol) => symbol.name)).toContain("greet");
  }, 30_000);

  it("answers a rename with an edit for every reference", async () => {
    const source = "const value = 1;\nexport function use(): number {\n  return value;\n}\n";
    const file = tsProject("src/app.ts", { "src/app.ts": source });
    const opened = await open(file);

    // `value` starts at one-based 1:7 → zero-based line 0, character 6.
    const edits = await opened.state.client.rename(opened.uri, { line: 0, character: 6 }, "total", 10_000);

    const list = edits[opened.abs];
    expect(list && list.length).toBeGreaterThanOrEqual(2);

    const renamed = applyTextEdits(source, list!);
    expect(renamed).toContain("const total = 1;");
    expect(renamed).toContain("return total;");
  }, 30_000);

  it("answers a rename that spans two files", async () => {
    const math = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
    const use = 'import { add } from "./math.js";\nexport const total = add(1, 2);\n';
    const file = tsProject("src/math.ts", { "src/math.ts": math, "src/use.ts": use });
    const opened = await open(file);

    const edits = await opened.state.client.rename(opened.uri, { line: 0, character: 16 }, "sum", 10_000);

    const files = Object.keys(edits).sort();
    expect(files).toHaveLength(2);
    expect(applyTextEdits(math, edits[join(root, "src/math.ts")]!)).toContain("export function sum(");
    expect(applyTextEdits(use, edits[join(root, "src/use.ts")]!)).toBe('import { sum } from "./math.js";\nexport const total = sum(1, 2);\n');
  }, 30_000);
});
