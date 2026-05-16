/**
 * LSP Format Module — Unit Tests
 *
 * Tests pure formatting functions from lsp/format.ts:
 * - format_diagnostics / filter_diagnostics
 * - format_hover
 * - format_locations
 * - format_document_symbols
 * - find_symbol_matches / format_symbol_matches
 * - symbol_kind_label
 * - to_lsp_tool_error / format_tool_error
 * - format_status_lines (basic)
 */

import { describe, it, expect } from "vitest";
import {
  format_diagnostics,
  filter_diagnostics,
  format_hover,
  format_locations,
  format_document_symbols,
  find_symbol_matches,
  format_symbol_matches,
  symbol_kind_label,
  to_lsp_tool_error,
  format_tool_error,
  LspToolError,
  type SeverityFilter,
  type LspDiagnostic,
  type LspHover,
  type LspLocation,
  type LspDocumentSymbol,
} from "../extensions/lsp/format.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helper factories
// ═══════════════════════════════════════════════════════════════════════════

function makeDiagnostic(overrides: Partial<LspDiagnostic> = {}): LspDiagnostic {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    },
    severity: 1,
    message: "test error",
    ...overrides,
  };
}

function makeSymbol(overrides: Partial<LspDocumentSymbol> = {}): LspDocumentSymbol {
  return {
    name: "testSymbol",
    kind: 12, // function
    range: {
      start: { line: 10, character: 5 },
      end: { line: 20, character: 1 },
    },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// filter_diagnostics
// ═══════════════════════════════════════════════════════════════════════════

describe("filter_diagnostics", () => {
  const diags: LspDiagnostic[] = [
    makeDiagnostic({ severity: 1, message: "error" }),
    makeDiagnostic({ severity: 2, message: "warning" }),
    makeDiagnostic({ severity: 3, message: "info" }),
    makeDiagnostic({ severity: 4, message: "hint" }),
  ];

  it("returns all when no filter", () => {
    expect(filter_diagnostics(diags)).toHaveLength(4);
  });

  it("returns all when empty filter", () => {
    expect(filter_diagnostics(diags, [])).toHaveLength(4);
  });

  it("error filter shows only errors", () => {
    const filtered = filter_diagnostics(diags, ["error" as SeverityFilter]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.message).toBe("error");
  });

  it("warning filter shows errors + warnings", () => {
    const filtered = filter_diagnostics(diags, ["warning" as SeverityFilter]);
    expect(filtered).toHaveLength(2);
  });

  it("info filter shows errors + warnings + info", () => {
    const filtered = filter_diagnostics(diags, ["info" as SeverityFilter]);
    expect(filtered).toHaveLength(3);
  });

  it("hint filter shows all", () => {
    const filtered = filter_diagnostics(diags, ["hint" as SeverityFilter]);
    expect(filtered).toHaveLength(4);
  });

  it("multiple severity filters use minimum", () => {
    // ["error", "warning"] → min = 1 (error) → only errors
    const filtered = filter_diagnostics(diags, ["error" as SeverityFilter, "warning" as SeverityFilter]);
    expect(filtered).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// format_diagnostics
// ═══════════════════════════════════════════════════════════════════════════

describe("format_diagnostics", () => {
  it("formats no diagnostics", () => {
    expect(format_diagnostics("test.ts", [])).toBe("test.ts: no diagnostics");
  });

  it("formats single diagnostic", () => {
    const diag = makeDiagnostic({
      range: { start: { line: 4, character: 10 }, end: { line: 4, character: 15 } },
      severity: 1,
      message: "Unexpected token",
    });
    const result = format_diagnostics("test.ts", [diag]);
    expect(result).toContain("test.ts: 1 diagnostic(s)");
    expect(result).toContain("5:11"); // line+1, char+1
    expect(result).toContain("error");
    expect(result).toContain("Unexpected token");
  });

  it("formats diagnostic with source and code", () => {
    const diag = makeDiagnostic({
      source: "typescript",
      code: 2307,
      message: "Cannot find module",
    });
    const result = format_diagnostics("test.ts", [diag]);
    expect(result).toContain("[typescript]");
    expect(result).toContain("(2307)");
  });

  it("formats multiple diagnostics", () => {
    const diags = [
      makeDiagnostic({ severity: 1, message: "err1" }),
      makeDiagnostic({ severity: 2, message: "warn1" }),
    ];
    const result = format_diagnostics("test.ts", diags);
    expect(result).toContain("2 diagnostic(s)");
    expect(result).toContain("err1");
    expect(result).toContain("warn1");
  });

  it("applies severity filter", () => {
    const diags = [
      makeDiagnostic({ severity: 1, message: "err" }),
      makeDiagnostic({ severity: 3, message: "info" }),
    ];
    const result = format_diagnostics("test.ts", diags, ["error" as SeverityFilter]);
    expect(result).toContain("1 diagnostic(s)");
    expect(result).toContain("err");
    expect(result).not.toContain("info");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// format_hover
// ═══════════════════════════════════════════════════════════════════════════

describe("format_hover", () => {
  it("returns no hover info for null", () => {
    expect(format_hover(null)).toBe("No hover info.");
  });

  it("extracts string contents", () => {
    const hover: LspHover = { contents: "type Foo = string" };
    expect(format_hover(hover)).toBe("type Foo = string");
  });

  it("extracts value from MarkedString object", () => {
    const hover: LspHover = { contents: { language: "typescript", value: "const x: number" } };
    expect(format_hover(hover)).toBe("const x: number");
  });

  it("joins array contents", () => {
    const hover: LspHover = { contents: ["line1", { language: "ts", value: "line2" }] };
    const result = format_hover(hover);
    expect(result).toContain("line1");
    expect(result).toContain("line2");
  });

  it("returns no hover info for empty contents", () => {
    const hover: LspHover = { contents: "" };
    expect(format_hover(hover)).toBe("No hover info.");
  });

  it("returns no hover info for empty array", () => {
    const hover: LspHover = { contents: ["", ""] };
    expect(format_hover(hover)).toBe("No hover info.");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// format_locations
// ═══════════════════════════════════════════════════════════════════════════

describe("format_locations", () => {
  it("returns empty message for no locations", () => {
    expect(format_locations([], "No results")).toBe("No results");
  });

  it("formats single location", () => {
    const loc: LspLocation = {
      uri: "file:///home/user/project/src/index.ts",
      range: { start: { line: 9, character: 4 }, end: { line: 9, character: 10 } },
    };
    const result = format_locations([loc], "");
    expect(result).toContain("index.ts");
    expect(result).toContain("10:5"); // line+1, char+1
  });

  it("formats multiple locations", () => {
    const locs: LspLocation[] = [
      { uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      { uri: "file:///b.ts", range: { start: { line: 5, character: 2 }, end: { line: 5, character: 3 } } },
    ];
    const result = format_locations(locs, "");
    expect(result).toContain("a.ts");
    expect(result).toContain("b.ts");
    expect(result.split("\n").length).toBe(2);
  });

  it("handles non-file URIs", () => {
    const loc: LspLocation = {
      uri: "custom-scheme://something",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    };
    const result = format_locations([loc], "");
    expect(result).toContain("custom-scheme://something");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// format_document_symbols
// ═══════════════════════════════════════════════════════════════════════════

describe("format_document_symbols", () => {
  it("formats no symbols", () => {
    expect(format_document_symbols("test.ts", [])).toBe("test.ts: no symbols");
  });

  it("formats top-level symbols", () => {
    const symbols = [
      makeSymbol({ name: "foo", kind: 12, range: { start: { line: 9, character: 0 }, end: { line: 19, character: 1 } } }),
      makeSymbol({ name: "bar", kind: 6, range: { start: { line: 29, character: 0 }, end: { line: 39, character: 1 } } }),
    ];
    const result = format_document_symbols("test.ts", symbols);
    expect(result).toContain("2 top-level symbol(s)");
    expect(result).toContain("function foo");
    expect(result).toContain("method bar");
  });

  it("formats nested symbols with indentation", () => {
    const symbols: LspDocumentSymbol[] = [
      makeSymbol({
        name: "MyClass",
        kind: 5, // class
        range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
        children: [
          makeSymbol({
            name: "myMethod",
            kind: 6, // method
            range: { start: { line: 2, character: 4 }, end: { line: 5, character: 5 } },
          }),
        ],
      }),
    ];
    const result = format_document_symbols("test.ts", symbols);
    expect(result).toContain("class MyClass");
    expect(result).toContain("  method myMethod");
  });

  it("formats symbol with detail", () => {
    const symbols = [
      makeSymbol({ name: "x", kind: 13, detail: ": string", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }),
    ];
    const result = format_document_symbols("test.ts", symbols);
    expect(result).toContain("— : string");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// find_symbol_matches
// ═══════════════════════════════════════════════════════════════════════════

describe("find_symbol_matches", () => {
  const symbols: LspDocumentSymbol[] = [
    makeSymbol({ name: "setupSafety", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } } }),
    makeSymbol({ name: "setupLsp", kind: 12, range: { start: { line: 20, character: 0 }, end: { line: 30, character: 1 } } }),
    makeSymbol({ name: "MyClass", kind: 5, range: { start: { line: 40, character: 0 }, end: { line: 50, character: 1 } },
      children: [
        makeSymbol({ name: "myMethod", kind: 6, range: { start: { line: 42, character: 4 }, end: { line: 45, character: 5 } } }),
      ],
    }),
  ];

  const baseOptions = {
    max_results: 20,
    top_level_only: false,
    exact_match: false,
    kinds: new Set<string>(),
    language: "typescript",
  };

  it("finds by substring", () => {
    const matches = find_symbol_matches(symbols, "setup", baseOptions);
    expect(matches.length).toBe(2);
    expect(matches.every(m => m.symbol.name.includes("setup"))).toBe(true);
  });

  it("finds by exact match", () => {
    const matches = find_symbol_matches(symbols, "setupSafety", { ...baseOptions, exact_match: true });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.symbol.name).toBe("setupSafety");
  });

  it("finds nested symbols", () => {
    const matches = find_symbol_matches(symbols, "myMethod", baseOptions);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.depth).toBe(2);
  });

  it("excludes nested when top_level_only", () => {
    const matches = find_symbol_matches(symbols, "myMethod", { ...baseOptions, top_level_only: true });
    expect(matches).toHaveLength(0);
  });

  it("filters by kind", () => {
    const matches = find_symbol_matches(symbols, "setup", { ...baseOptions, kinds: new Set(["function"]) });
    expect(matches).toHaveLength(2);
  });

  it("filters by kind — class only", () => {
    const matches = find_symbol_matches(symbols, "My", { ...baseOptions, kinds: new Set(["class"]) });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.symbol.name).toBe("MyClass");
  });

  it("respects max_results", () => {
    const matches = find_symbol_matches(symbols, "setup", { ...baseOptions, max_results: 1 });
    expect(matches).toHaveLength(1);
  });

  it("returns empty for empty query", () => {
    const matches = find_symbol_matches(symbols, "", baseOptions);
    expect(matches).toHaveLength(0);
  });

  it("returns empty for no match", () => {
    const matches = find_symbol_matches(symbols, "nonexistent", baseOptions);
    expect(matches).toHaveLength(0);
  });

  it("matches by detail", () => {
    const symbolsWithDetail: LspDocumentSymbol[] = [
      makeSymbol({ name: "x", kind: 13, detail: "ProviderModelConfig", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }),
    ];
    const matches = find_symbol_matches(symbolsWithDetail, "ProviderModel", baseOptions);
    expect(matches).toHaveLength(1);
  });

  it("handles C++ namespace expansion", () => {
    const cppSymbols: LspDocumentSymbol[] = [
      makeSymbol({ name: "std::vector", kind: 5, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }),
    ];
    // Exact match on "vector" should match "std::vector" in C++
    const matches = find_symbol_matches(cppSymbols, "vector", { ...baseOptions, exact_match: true, language: "cpp" });
    expect(matches).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// format_symbol_matches
// ═══════════════════════════════════════════════════════════════════════════

describe("format_symbol_matches", () => {
  it("formats no matches", () => {
    expect(format_symbol_matches("test.ts", "foo", [])).toContain("no symbols matching");
  });

  it("formats matches with query", () => {
    const matches = [
      { symbol: makeSymbol({ name: "foo", kind: 12 }), depth: 1 },
    ];
    const result = format_symbol_matches("test.ts", "foo", matches);
    expect(result).toContain("1 symbol match(es)");
    expect(result).toContain("function foo");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// symbol_kind_label
// ═══════════════════════════════════════════════════════════════════════════

describe("symbol_kind_label", () => {
  const knownKinds: [number, string][] = [
    [2, "module"],
    [5, "class"],
    [6, "method"],
    [12, "function"],
    [13, "variable"],
    [14, "constant"],
    [23, "struct"],
  ];

  for (const [kind, label] of knownKinds) {
    it(`${kind} → ${label}`, () => {
      expect(symbol_kind_label(kind)).toBe(label);
    });
  }

  it("returns 'symbol' for unknown kind", () => {
    expect(symbol_kind_label(999)).toBe("symbol");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// to_lsp_tool_error / format_tool_error
// ═══════════════════════════════════════════════════════════════════════════

describe("to_lsp_tool_error", () => {
  it("passes through LspToolError", () => {
    const err = new LspToolError({
      kind: "unsupported_language",
      message: "Language foo is not supported",
    });
    const details = to_lsp_tool_error("test.ts", "foo", undefined, "fools", undefined, err);
    expect(details.kind).toBe("unsupported_language");
  });

  it("handles generic ENOENT error", () => {
    const err: any = new Error("spawn ENOENT");
    err.code = "ENOENT";
    const details = to_lsp_tool_error("test.ts", "typescript", "/workspace", "tsserver", "npm i -g typescript", err);
    // Generic errors get tool_execution_failed, not server_start_failed
    expect(details.kind).toBe("tool_execution_failed");
    expect(details.message).toBe("spawn ENOENT");
    expect(details.code).toBe("ENOENT");
    expect(details.install_hint).toBe("npm i -g typescript");
  });

  it("handles generic errors", () => {
    const details = to_lsp_tool_error("test.ts", "python", undefined, "pylsp", undefined, new Error("crashed"));
    expect(details.kind).toBe("tool_execution_failed");
    expect(details.message).toBe("crashed");
  });

  it("handles non-Error throws", () => {
    const details = to_lsp_tool_error("test.ts", "go", undefined, "gopls", undefined, "string error");
    expect(details.message).toBe("string error");
  });
});

describe("format_tool_error", () => {
  it("formats unsupported_language", () => {
    const result = format_tool_error({
      kind: "unsupported_language",
      message: "Language xyz is not supported",
    });
    expect(result).toBe("Language xyz is not supported");
  });

  it("formats server_start_failed with all fields", () => {
    const result = format_tool_error({
      kind: "server_start_failed",
      file: "test.ts",
      language: "typescript",
      workspace_root: "/project",
      command: "tsserver",
      install_hint: "npm i -g typescript",
      message: "command not found",
    });
    expect(result).toContain("typescript LSP unavailable for test.ts");
    expect(result).toContain("command not found");
    expect(result).toContain("tsserver");
    expect(result).toContain("/project");
    expect(result).toContain("npm i -g typescript");
  });

  it("formats error without language", () => {
    const result = format_tool_error({
      kind: "tool_execution_failed",
      file: "test.ts",
      message: "something broke",
    });
    expect(result).toContain("LSP request failed for test.ts");
  });
});
