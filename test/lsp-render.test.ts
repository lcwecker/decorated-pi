/**
 * tools/lsp/render.ts — the TUI half of the LSP tools.
 *
 * A recording theme keeps the assertions readable and pins which color role
 * each part of a row uses: the path, the position, the hit, and a preview's
 * removed/added text. Every renderer must fall back to the model-facing text
 * when `details` carries no rows, which is what an error reply looks like.
 */
import { describe, expect, it } from "vitest";
import {
  makeCallRenderer,
  makeLocationResultRenderer,
  renderRenameResult,
  renderSymbolsResult,
} from "../tools/lsp/render.js";
import { TOOL_RESULT_FOLD_LINES } from "../utils/tool-output.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `*${text}*`,
};

/** A host injects its own hint formatter; providing one keeps the fold footer
 *  out of the global theme singleton. */
const context = (expanded = false) => ({
  expanded,
  keyHint: (keybinding: string, description: string) => `[${keybinding}] ${description}`,
});

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
  it("shows the position the call acts on", () => {
    const render = makeCallRenderer("LSP: references");
    const out = drawn(render({ path: "hooks/tps.ts", line: 96, character: 11 }, theme, context()));
    expect(out).toBe("*<toolTitle>LSP: references</toolTitle>* <accent>hooks/tps.ts</accent><muted>:96:11</muted>");
  });

  it("puts the tool's own flags after the position", () => {
    const render = makeCallRenderer("LSP: references", (args) => [
      ...(args.include_declaration === false ? ["no declaration"] : []),
      `limit ${args.limit}`,
    ]);
    const args = { path: "a.ts", line: 1, character: 2, include_declaration: false, limit: 20 };
    const collapsed = drawn(render(args, theme, context()));
    expect(collapsed).toContain("<muted>no declaration · limit 20</muted>");

    const expanded = drawn(render(args, theme, context(true)));
    expect(expanded).toContain("\n<muted>  no declaration</muted>\n<muted>  limit 20</muted>");
  });

  it("still renders a title when the call carries no path", () => {
    const out = drawn(makeCallRenderer("LSP: symbols")({}, theme, context()));
    expect(out).toBe("*<toolTitle>LSP: symbols</toolTitle>*");
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
