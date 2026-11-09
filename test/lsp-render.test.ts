/**
 * tools/lsp/render.ts — the TUI half of the LSP tools.
 *
 * A recording theme keeps the assertions readable and pins which color role
 * each part of a row uses: the path, the position, the hit, and a preview's
 * removed/added text. Every renderer must fall back to the model-facing text
 * when `details` carries no rows, which is what an error reply looks like.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeCallRenderer,
  makeLocationResultRenderer,
  renderRenameResult,
  renderSymbolsResult,
} from "../tools/lsp/render.js";
import { TOOL_RESULT_FOLD_LINES } from "../utils/tool-output.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "decorated-pi-lsp-render-"));
  tempDirs.push(dir);
  return dir;
}

function tempFile(name: string, contents: string): string {
  const file = join(tempDir(), name);
  writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `*${text}*`,
};

/** A host injects its own hint formatter; providing one keeps the fold footer
 *  out of the global theme singleton. `invalidate` is how the row asks to be
 *  repainted once its asynchronous subject read lands. */
const context = (expanded = false) => ({
  expanded,
  cwd: process.cwd(),
  state: {} as Record<string, any>,
  invalidate: vi.fn(),
  keyHint: (keybinding: string, description: string) => `[${keybinding}] ${description}`,
});

/** Wait for the row's asynchronous subject read to land. */
async function painted(row: { invalidate: any }): Promise<void> {
  await vi.waitFor(() => expect(row.invalidate).toHaveBeenCalled());
}

/** Render a component wide enough that nothing wraps, and join its lines.
 *  Text pads every line to the render width, so the padding goes. */
function drawn(component: any): string {
  return component
    .render(500)
    .map((line: string) => line.replace(/\s+$/, ""))
    .join("\n");
}

function locationRow(overrides: Record<string, unknown> = {}) {
  return {
    file: "hooks/tps.ts",
    line: 96,
    character: 11,
    source: "export function renderKeyHint(context: any): KeyHint {",
    symbol: "renderKeyHint",
    symbolStart: 16,
    ...overrides,
  };
}

function locationResult(overrides: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text", text: "hooks/tps.ts:96:11: ..." }],
    details: {
      ok: true,
      count: 2,
      total: 12,
      files: 5,
      omitted: 0,
      symbol: "renderKeyHint",
      locations: [locationRow(), locationRow({ file: "tools/websearch/index.ts", line: 52, character: 12 })],
      ...overrides,
    },
  };
}

describe("makeCallRenderer", () => {
  it("paints the position first and names the symbol once the read lands", async () => {
    const file = tempFile("math.ts", "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    const render = makeCallRenderer({ title: "lsp_references", subject: "symbol" });
    const row = context();
    const args = { path: file, line: 1, character: 17 };

    // A renderer must not wait for the disk: the first frame carries the
    // position, which is already in `args`.
    expect(drawn(render(args, theme, row))).toBe(
      `*<toolTitle>lsp_references</toolTitle>* <accent>${file}</accent><muted>:1:17</muted>`,
    );

    await painted(row);
    expect(drawn(render(args, theme, row))).toBe(
      `*<toolTitle>lsp_references</toolTitle>* <accent>add</accent><muted> · ${file}:1:17</muted>`,
    );
  });

  it("never reads a path that is not a regular file", async () => {
    // A directory, a FIFO and /dev/zero all report a small or zero size, so a
    // size guard alone would let them through — and reading a FIFO blocks until
    // something writes to it, freezing the whole UI.
    const dir = tempDir();
    const render = makeCallRenderer({ title: "lsp_references", subject: "symbol" });
    const row = context();
    const args = { path: dir, line: 1, character: 1 };

    drawn(render(args, theme, row));
    await painted(row);
    expect(drawn(render(args, theme, row))).toBe(
      `*<toolTitle>lsp_references</toolTitle>* <accent>${dir}</accent><muted>:1:1</muted>`,
    );
  });

  it("does not block on a FIFO", async () => {
    const fifo = join(tempDir(), "pipe");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      return; // No mkfifo (Windows): the directory case above covers the guard.
    }
    const render = makeCallRenderer({ title: "lsp_references", subject: "symbol" });
    const row = context();
    const args = { path: fifo, line: 1, character: 1 };

    drawn(render(args, theme, row));
    // Reaching this line at all is the assertion: the old synchronous read hung
    // here forever. `painted` still settles because stat answers immediately.
    await painted(row);
    expect(drawn(render(args, theme, row))).toContain(fifo);
  });

  it("drops to the position when the file cannot be read", async () => {
    const render = makeCallRenderer({ title: "lsp_references", subject: "symbol" });
    const row = context();
    const args = { path: "/nope/a.ts", line: 2, character: 17 };

    drawn(render(args, theme, row));
    await painted(row);
    expect(drawn(render(args, theme, row))).toBe(
      "*<toolTitle>lsp_references</toolTitle>* <accent>/nope/a.ts</accent><muted>:2:17</muted>",
    );
  });

  it("titles the file when the call has no single symbol", () => {
    const render = makeCallRenderer({ title: "lsp_document_symbols", subject: "path" });
    expect(drawn(render({ path: "a.ts" }, theme, context()))).toBe(
      "*<toolTitle>lsp_document_symbols</toolTitle>* <accent>a.ts</accent>",
    );
  });

  it("caches the subject, so the row stops touching the disk", async () => {
    const file = tempFile("a.ts", "const total = 1;\n");
    const render = makeCallRenderer({ title: "lsp_definition", subject: "symbol" });
    const row = context();
    const args = { path: file, line: 1, character: 7 };
    drawn(render(args, theme, row));
    await painted(row);
    expect(drawn(render(args, theme, row))).toContain("<accent>total</accent>");

    // The file is gone, yet the row still names it: the answer came from the
    // cache, not from another read.
    rmSync(file);
    const second = context();
    drawn(render(args, theme, second));
    expect(drawn(render(args, theme, second))).toContain("<accent>total</accent>");
    expect(second.invalidate).not.toHaveBeenCalled();
  });

  it("shows the name a rename writes", async () => {
    const file = tempFile("a.ts", "export function add() {}\n");
    const render = makeCallRenderer({
      title: "lsp_rename",
      subject: "symbol",
      newName: (args: any) => args.new_name,
      flags: (args: any) => (args.preview ? ["preview"] : []),
    });
    const row = context();
    const args = { path: file, line: 1, character: 17, new_name: "plus", preview: true };
    drawn(render(args, theme, row));
    await painted(row);
    expect(drawn(render(args, theme, row))).toBe(
      `*<toolTitle>lsp_rename</toolTitle>* <accent>add</accent> <muted>→</muted> <accent>plus</accent><muted> · ${file}:1:17</muted><muted> · preview</muted>`,
    );
  });

  it("puts the tool's flags on their own lines when expanded", () => {
    const render = makeCallRenderer({
      title: "lsp_references",
      subject: "symbol",
      flags: () => ["no declaration", "limit 20"],
    });
    const out = drawn(render({ path: "a.ts", line: 1, character: 7 }, theme, context(true)));
    expect(out).toContain("\n<muted>  no declaration</muted>\n<muted>  limit 20</muted>");
  });
});

describe("makeLocationResultRenderer", () => {
  it("heads the list with the counts and the symbol, then one row per hit", () => {
    const render = makeLocationResultRenderer("reference");
    const out = drawn(render(locationResult(), { expanded: false }, theme, context()));

    expect(out.split("\n")[0]).toBe("<muted>12 references · 5 files</muted> · <accent>renderKeyHint</accent>");
    // The identifier at each hit is the one part of the source that is colored.
    expect(out).toContain(
      "<accent>hooks/tps.ts</accent><muted>:96:11</muted> export function <toolDiffAdded>renderKeyHint</toolDiffAdded>(context: any): KeyHint {",
    );
  });

  it("marks a reply the limit shortened", () => {
    const render = makeLocationResultRenderer("reference");
    const out = drawn(render(locationResult({ omitted: 7, count: 5, total: 12 }), { expanded: false }, theme, context()));
    expect(out.split("\n")[0]).toContain("<warning> · 7 omitted</warning>");
  });

  it("prints a row without source when the file could not be read", () => {
    const render = makeLocationResultRenderer("definition");
    const result = locationResult({ locations: [locationRow({ source: "", symbol: undefined, symbolStart: undefined })] });
    const out = drawn(render(result, { expanded: false }, theme, context()));
    expect(out.split("\n")[1]).toBe("<accent>hooks/tps.ts</accent><muted>:96:11</muted>");
  });

  it("folds a long list behind the expand hint and shows it all when expanded", () => {
    const rows = Array.from({ length: 40 }, (_value, index) => locationRow({ line: index + 1 }));
    const render = makeLocationResultRenderer("reference");
    const folded = drawn(render(locationResult({ locations: rows }), { expanded: false }, theme, context()));
    const expanded = drawn(render(locationResult({ locations: rows }), { expanded: true }, theme, context()));

    // Header + TOOL_RESULT_FOLD_LINES rows, then the footer.
    expect(folded.split("\n")).toHaveLength(TOOL_RESULT_FOLD_LINES + 2);
    expect(folded).toContain("10 more lines, 40 total");
    expect(expanded.split("\n")).toHaveLength(41);
    expect(expanded).not.toContain("more lines");
  });

  it("falls back to the model-facing text when details carries no rows", () => {
    const render = makeLocationResultRenderer("reference");
    const error = { content: [{ type: "text", text: "no language server for .zig" }], details: { ok: false } };
    expect(drawn(render(error, { expanded: false }, theme, context()))).toContain("no language server for .zig");
  });
});

describe("renderSymbolsResult", () => {
  it("indents by depth and labels the kind", () => {
    const result = {
      content: [{ type: "text", text: "a.ts" }],
      details: {
        ok: true,
        symbols: [
          { depth: 0, name: "LspServerManager", kind: 5, line: 12, character: 14 },
          { depth: 1, name: "start", kind: 6, line: 30, character: 3 },
        ],
      },
    };
    const out = drawn(renderSymbolsResult(result, { expanded: false }, theme, context()));
    expect(out.split("\n")).toEqual([
      "<muted>2 symbols</muted>",
      "LspServerManager <muted>(class)</muted> <accent>12:14</accent>",
      "  start <muted>(method)</muted> <accent>30:3</accent>",
    ]);
  });

  it("falls back to the text when there are no rows", () => {
    const result = { content: [{ type: "text", text: "a.ts: no symbols" }], details: { ok: true, symbols: [] } };
    expect(drawn(renderSymbolsResult(result, { expanded: false }, theme, context()))).toContain("a.ts: no symbols");
  });
});

describe("renderRenameResult", () => {
  it("shows a preview as red-removed / green-added rows", () => {
    const result = {
      content: [{ type: "text", text: "a.ts: 1 edit(s)" }],
      details: {
        ok: true,
        preview: true,
        files: 1,
        edits: 1,
        changes: [{ file: "a.ts", line: 3, character: 7, before: "total", after: "sum" }],
      },
    };
    const out = drawn(renderRenameResult(result, { expanded: false }, theme, context()));
    expect(out.split("\n")[0]).toBe("<muted>preview · 1 edit · 1 file</muted>");
    expect(out.split("\n")[1]).toBe(
      "<accent>a.ts</accent><muted>:3:7</muted> <toolDiffRemoved>total</toolDiffRemoved> <muted>→</muted> <toolDiffAdded>sum</toolDiffAdded>",
    );
  });

  it("says what it wrote once the rename has been applied", () => {
    const result = {
      content: [{ type: "text", text: 'Renamed to "sum": 1 edit(s) in 1 file(s).' }],
      details: {
        ok: true,
        files: 1,
        edits: 1,
        newName: "sum",
        changes: [{ file: "a.ts", line: 3, character: 7, before: "total", after: "sum" }],
      },
    };
    const out = drawn(renderRenameResult(result, { expanded: false }, theme, context()));
    expect(out.split("\n")[0]).toBe('<muted>renamed to</muted> <accent>"sum"</accent> <muted>· 1 edit · 1 file</muted>');
  });

  it("falls back to the text when details carries no rows", () => {
    const result = {
      content: [{ type: "text", text: "Rename was not applied: a target is not a local file." }],
      details: { ok: false, files: 0, edits: 0 },
    };
    expect(drawn(renderRenameResult(result, { expanded: false }, theme, context()))).toContain("not applied");
  });
});
