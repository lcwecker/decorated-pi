/**
 * LSP Format Module — Unit Tests
 *
 * Tests pure formatting functions from lsp/format.ts:
 * - format_diagnostics / filter_diagnostics
 * - format_hover
 * - format_locations
 * - to_lsp_tool_error / format_tool_error
 * - format_status_lines (basic)
 */

import { describe, it, expect } from "vitest";
import {
  format_diagnostics,
  filter_diagnostics,
  format_hover,
  format_locations,
  to_lsp_tool_error,
  format_tool_error,
  LspToolError,
  type SeverityFilter,
  type LspDiagnostic,
  type LspHover,
  type LspLocation,
} from "../tools/lsp/format.js";

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
    const details = to_lsp_tool_error("test.ts", "python", undefined, "pyright-langserver", undefined, new Error("crashed"));
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
