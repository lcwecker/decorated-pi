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
  formatDocumentSymbols,
  formatEditList,
  formatLocations,
} from "../tools/lsp/format.js";
import type { LspDocumentSymbol, LspTextEdit } from "../tools/lsp/types.js";

function range(sl: number, sc: number, el: number, ec: number) {
  return { start: { line: sl, character: sc }, end: { line: el, character: ec } };
}

describe("formatLocations", () => {
  it("returns the empty message when there is nothing", () => {
    expect(formatLocations([], "none")).toBe("none");
  });

  it("prints one-based path:line:character per location", () => {
    const out = formatLocations(
      [
        { uri: "file:///ws/a.ts", range: range(2, 4, 2, 8) },
        { uri: "file:///ws/b.ts", range: range(0, 0, 0, 1) },
      ],
      "none",
    );
    expect(out).toBe("/ws/a.ts:3:5\n/ws/b.ts:1:1");
  });

  it("shows a non-file URI verbatim", () => {
    // `untitled:` and `jdt://` have no path; they must not be mangled or dropped.
    const out = formatLocations([{ uri: "untitled:Untitled-1", range: range(0, 0, 0, 1) }], "none");
    expect(out).toBe("untitled:Untitled-1:1:1");
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

describe("formatEditList", () => {
  it("groups edits by file with their target positions", () => {
    const out = formatEditList({
      "/ws/a.ts": [{ range: range(0, 6, 0, 11), newText: "renamed" }],
      "/ws/b.ts": [
        { range: range(2, 0, 2, 5), newText: "renamed" },
        { range: range(4, 0, 4, 5), newText: "renamed" },
      ],
    });
    expect(out).toBe([
      "/ws/a.ts: 1 edit(s)",
      '  1:7 → "renamed"',
      "/ws/b.ts: 2 edit(s)",
      '  3:1 → "renamed"',
      '  5:1 → "renamed"',
    ].join("\n"));
  });
});
