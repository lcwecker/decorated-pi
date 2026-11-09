/**
 * tools/lsp/format.ts — the formatters the tools actually run.
 *
 * These are the single implementation: tools.ts imports the same functions, so
 * a change here cannot drift away from production the way the old test-only
 * `format.ts` copy did.
 */
import { describe, expect, it } from "vitest";
import {
  applyTextEdits,
  flattenDocumentSymbols,
  formatChangeGroups,
  formatChangeRows,
  formatDocumentSymbols,
  formatLocationRows,
  identifierAt,
  limitNotice,
  relativeToCwd,
  textInRange,
  truncateSource,
  type LocationRow,
} from "../tools/lsp/format.js";
import type { LspDocumentSymbol, LspTextEdit } from "../tools/lsp/types.js";

function range(sl: number, sc: number, el: number, ec: number) {
  return { start: { line: sl, character: sc }, end: { line: el, character: ec } };
}

function row(overrides: Partial<LocationRow> = {}): LocationRow {
  return { file: "a.ts", line: 3, character: 5, source: "const x = 1;", ...overrides };
}

describe("formatLocationRows", () => {
  it("returns the empty message when there is nothing", () => {
    expect(formatLocationRows([], "none")).toBe("none");
  });

  it("prints path:line:character and the source line", () => {
    const out = formatLocationRows(
      [
        row({ file: "a.ts", source: "const total = sum(a, b);" }),
        row({ file: "b.ts", line: 1, character: 1, source: "import { sum } from './a';" }),
      ],
      "none",
    );
    expect(out).toBe([
      "a.ts:3:5: const total = sum(a, b);",
      "b.ts:1:1: import { sum } from './a';",
    ].join("\n"));
  });

  it("keeps the position when the file could not be read", () => {
    // A reference in a generated or deleted file is still a place to open.
    expect(formatLocationRows([row({ file: "gone.ts", source: "" })], "none")).toBe("gone.ts:3:5");
  });

  it("shows a non-file URI verbatim", () => {
    expect(formatLocationRows([row({ file: "untitled:Untitled-1", line: 1, character: 1, source: "" })], "none"))
      .toBe("untitled:Untitled-1:1:1");
  });
});

describe("identifierAt", () => {
  it("returns the identifier covering the column and where it starts", () => {
    expect(identifierAt("const total = sum(a, b);", 6)).toEqual({ name: "total", start: 6 });
    expect(identifierAt("const total = sum(a, b);", 8)).toEqual({ name: "total", start: 6 });
    expect(identifierAt("const total = sum(a, b);", 14)).toEqual({ name: "sum", start: 14 });
  });

  it("returns undefined on whitespace or punctuation", () => {
    // A position that holds no symbol is what makes rename return no edits.
    expect(identifierAt("const total = 1;", 5)).toBeUndefined();
    expect(identifierAt("const total = 1;", 11)).toBeUndefined();
    expect(identifierAt("", 0)).toBeUndefined();
    expect(identifierAt("   ", 1)).toBeUndefined();
  });

  it("covers identifiers that are not ASCII", () => {
    expect(identifierAt("const 总计 = 1;", 6)).toEqual({ name: "总计", start: 6 });
  });

  it("covers identifiers outside the BMP", () => {
    // U+10400 DESERET CAPITAL LETTER LONG I is one code point and two UTF-16
    // units; testing a single unit would see a lone surrogate and reject it.
    const line = "const 𐐀name = 1;";
    expect(identifierAt(line, 6)).toEqual({ name: "𐐀name", start: 6 });
    // A column that lands on the low surrogate still resolves the identifier.
    expect(identifierAt(line, 7)).toEqual({ name: "𐐀name", start: 6 });
    // The last unit of the identifier, four units past the surrogate pair.
    expect(identifierAt(line, 11)).toEqual({ name: "𐐀name", start: 6 });
  });
});

describe("relativeToCwd", () => {
  it("strips the workspace prefix", () => {
    expect(relativeToCwd("/ws/src/a.ts", "/ws")).toBe("src/a.ts");
    expect(relativeToCwd("/ws/src/a.ts", "/ws/")).toBe("src/a.ts");
  });

  it("leaves a path outside the workspace absolute", () => {
    expect(relativeToCwd("/other/a.ts", "/ws")).toBe("/other/a.ts");
    expect(relativeToCwd("/wssrc/a.ts", "/ws")).toBe("/wssrc/a.ts");
    expect(relativeToCwd("/ws/a.ts", undefined)).toBe("/ws/a.ts");
  });
});

describe("truncateSource", () => {
  it("drops indentation and expands tabs", () => {
    expect(truncateSource("\t\treturn x;")).toBe("return x;");
    expect(truncateSource("    return x;   ")).toBe("return x;");
  });

  it("cuts a long line so the row stays one line", () => {
    const out = truncateSource("x".repeat(400));
    expect(out).toHaveLength(160);
    expect(out.endsWith("...")).toBe(true);
  });
});

describe("limitNotice", () => {
  it("says how many of the total were shown", () => {
    expect(limitNotice(100, 250)).toBe(
      "[Showing 100 of 250 locations. Pass a higher limit for more, or narrow the query.]",
    );
  });
});

describe("formatDocumentSymbols", () => {
  it("says so when the file is empty", () => {
    expect(formatDocumentSymbols("a.ts", [])).toBe("a.ts: no symbols");
  });

  it("indents children and labels the kind", () => {
    const symbols: LspDocumentSymbol[] = [
      {
        name: "Greeter",
        kind: 5,
        range: range(0, 0, 9, 1),
        selectionRange: range(0, 6, 0, 13),
        children: [{ name: "greet", kind: 6, range: range(2, 2, 4, 3), selectionRange: range(2, 8, 2, 13) }],
      },
    ];
    expect(formatDocumentSymbols("a.ts", symbols)).toBe("Greeter (class) 1:7\n  greet (method) 3:9");
  });

  it("falls back for an unknown kind", () => {
    const symbols: LspDocumentSymbol[] = [
      { name: "odd", kind: 99, range: range(0, 0, 0, 3), selectionRange: range(0, 0, 0, 3) },
    ];
    expect(formatDocumentSymbols("a.ts", symbols)).toBe("odd (kind 99) 1:1");
  });
});

describe("applyTextEdits", () => {
  it("replaces within a line", () => {
    expect(applyTextEdits("hello world", [{ range: range(0, 6, 0, 11), newText: "there" }])).toBe("hello there");
  });

  it("applies several edits to one line from the last backwards", () => {
    // Applied front-to-back, the second edit's offsets would already have moved.
    const edits: LspTextEdit[] = [
      { range: range(0, 0, 0, 3), newText: "baz" },
      { range: range(0, 4, 0, 7), newText: "qux" },
    ];
    expect(applyTextEdits("foo(bar)", edits)).toBe("baz(qux)");
  });

  it("splits a multi-line replacement over new lines", () => {
    expect(applyTextEdits("a\nb\nc", [{ range: range(1, 0, 1, 1), newText: "B1\nB2" }])).toBe("a\nB1\nB2\nc");
  });

  it("joins across a range that spans lines", () => {
    expect(applyTextEdits("abc\ndef", [{ range: range(0, 1, 1, 2), newText: "X" }])).toBe("aXf");
  });

  it("inserts when the range is empty", () => {
    expect(applyTextEdits("ab", [{ range: range(0, 1, 0, 1), newText: "-" }])).toBe("a-b");
  });

  it("throws on an edit past the end of the file rather than dropping it", () => {
    // A dropped edit would mean a silently half-applied rename on disk.
    expect(() => applyTextEdits("ab", [{ range: range(9, 0, 9, 1), newText: "x" }])).toThrow(/outside/);
  });

  it("throws on a character past the end of its line", () => {
    expect(() => applyTextEdits("ab\ncd", [{ range: range(0, 0, 0, 9), newText: "x" }])).toThrow(/outside/);
  });

  it("keeps CRLF documents on CRLF when the replacement spans lines", () => {
    const out = applyTextEdits("ab\r\ncd\r\n", [{ range: range(1, 0, 1, 2), newText: "X\nY" }]);
    expect(out).toBe("ab\r\nX\r\nY\r\n");
  });

  it("leaves CRLF untouched for a single-line replacement", () => {
    expect(applyTextEdits("ab\r\ncd\r\n", [{ range: range(1, 0, 1, 2), newText: "Z" }])).toBe("ab\r\nZ\r\n");
  });
});

describe("formatChangeGroups", () => {
  it("groups edits by file and shows the text they replace", () => {
    const out = formatChangeGroups([
      { file: "/ws/a.ts", rows: [{ file: "/ws/a.ts", line: 1, character: 7, before: "total", after: "sum" }] },
      {
        file: "/ws/b.ts",
        rows: [
          { file: "/ws/b.ts", line: 3, character: 1, before: "total", after: "sum" },
          { file: "/ws/b.ts", line: 5, character: 9, before: "total", after: "sum" },
        ],
      },
    ]);
    expect(out).toBe([
      "/ws/a.ts: 1 edit(s)",
      "  1:7: total → sum",
      "/ws/b.ts: 2 edit(s)",
      "  3:1: total → sum",
      "  5:9: total → sum",
    ].join("\n"));
  });
});

describe("formatChangeRows", () => {
  it("prints one row per change, flattening multi-line text", () => {
    const out = formatChangeRows([
      { file: "a.ts", line: 2, character: 3, before: "aa\nbb", after: "cc" },
      { file: "a.ts", line: 4, character: 1, before: "", after: "dd" },
    ]);
    expect(out).toBe(["a.ts:2:3: aa bb → cc", "a.ts:4:1: (nothing) → dd"].join("\n"));
  });
});

describe("textInRange", () => {
  it("takes a single-line range", () => {
    expect(textInRange("const total = 1;", range(0, 6, 0, 11))).toBe("total");
  });

  it("joins a multi-line range", () => {
    expect(textInRange("a\nbb\nccc\nd", range(0, 1, 2, 2))).toBe("\nbb\ncc");
  });
});
