/**
 * Tests for patch.ts — old_str / new_str exact replacement
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  applyPatches,
  applyPatch,
  ParseError,
  ApplyError,
  formatPatchResult,
  generatePatchDiff,
  computePatchPreview,
  diagnoseOldStrMismatch,
  diagnoseOldStrNotUnique,
} from "../extensions/patch.js";
import { preparePatchArguments } from "../extensions/io.js";

// ═══════════════════════════════════════════════════════════════════════════
// applyPatches Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("applyPatches", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(name: string, content: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content, "utf8");
    return p;
  }

  function readFile(name: string): string {
    return fs.readFileSync(path.join(tmpDir, name), "utf8");
  }

  // ── Basic replacement ────────────────────────────────────────────────────

  it("replaces exact text", async () => {
    writeFile("f.txt", "hello world\n");
    const result = await applyPatches([
      { path: "f.txt", edits: [{ old_str: "hello", new_str: "hi" }] },
    ], tmpDir);
    expect(readFile("f.txt")).toBe("hi world\n");
    expect(result.modified).toContain("f.txt");
  });

  it("replaces with empty string (delete)", async () => {
    writeFile("f.txt", "foo bar baz\n");
    await applyPatches([
      { path: "f.txt", edits: [{ old_str: "bar ", new_str: "" }] },
    ], tmpDir);
    expect(readFile("f.txt")).toBe("foo baz\n");
  });

  it("replaces multi-line text", async () => {
    writeFile("f.txt", "line a\nline b\nline c\n");
    await applyPatches([
      { path: "f.txt", edits: [{ old_str: "line a\nline b", new_str: "LINE A\nLINE B" }] },
    ], tmpDir);
    expect(readFile("f.txt")).toBe("LINE A\nLINE B\nline c\n");
  });

  // ── Multiple edits on one file ──────────────────────────────────────────

  it("applies multiple edits sequentially", async () => {
    writeFile("f.txt", "alpha beta gamma\n");
    await applyPatches([
      {
        path: "f.txt",
        edits: [
          { old_str: "alpha", new_str: "ALPHA" },
          { old_str: "gamma", new_str: "GAMMA" },
        ],
      },
    ], tmpDir);
    expect(readFile("f.txt")).toBe("ALPHA beta GAMMA\n");
  });

  it("later edits see content changed by earlier edits", async () => {
    writeFile("f.txt", "x\n");
    await applyPatches([
      {
        path: "f.txt",
        edits: [
          { old_str: "x", new_str: "y" },
          { old_str: "y", new_str: "z" }, // works because first edit changed x→y
        ],
      },
    ], tmpDir);
    expect(readFile("f.txt")).toBe("z\n");
  });

  // ── Anchor ──────────────────────────────────────────────────────────────

  it("uses anchor to narrow search range", async () => {
    writeFile("f.txt", "foo\nbar\nreturn x\nbaz\nreturn y\n");
    await applyPatches([
      {
        path: "f.txt",
        edits: [
          { anchor: "baz", old_str: "return y", new_str: "return 42" },
        ],
      },
    ], tmpDir);
    // Only the y after "baz" changed, the x before baz is untouched
    expect(readFile("f.txt")).toBe("foo\nbar\nreturn x\nbaz\nreturn 42\n");
  });

  it("falls back to global old_str search when anchor appears multiple times", async () => {
    writeFile("f.txt", "marker\nstuff\nmarker\nmore\n");
    await applyPatches([
      { path: "f.txt", edits: [{ anchor: "marker", old_str: "stuff", new_str: "x" }] },
    ], tmpDir);
    expect(readFile("f.txt")).toBe("marker\nx\nmarker\nmore\n");
  });

  it("falls back to global old_str search when anchor not found", async () => {
    writeFile("f.txt", "hello world\n");
    await applyPatches([
      { path: "f.txt", edits: [{ anchor: "nope", old_str: "hello", new_str: "x" }] },
    ], tmpDir);
    expect(readFile("f.txt")).toBe("x world\n");
  });

  it("reports both anchor miss and old_str miss when fallback also fails", async () => {
    writeFile("f.txt", "hello world\n");
    await expect(
      applyPatches([
        { path: "f.txt", edits: [{ anchor: "nope", old_str: "missing", new_str: "x" }] },
      ], tmpDir),
    ).rejects.toThrow(/Anchor not found[\s\S]*old_str not found/);
  });

  // ── Uniqueness ──────────────────────────────────────────────────────────

  it("fails when old_str is not unique", async () => {
    writeFile("f.txt", "dup\na\nb\nc\ndup\n");
    await expect(
      applyPatches([
        { path: "f.txt", edits: [{ old_str: "dup", new_str: "fixed" }] },
      ], tmpDir),
    ).rejects.toThrow(ApplyError);
  });

  it("fails when old_str not found", async () => {
    writeFile("f.txt", "hello world\n");
    await expect(
      applyPatches([
        { path: "f.txt", edits: [{ old_str: "nope", new_str: "x" }] },
      ], tmpDir),
    ).rejects.toThrow(ApplyError);
  });


  // ── Multi-file ──────────────────────────────────────────────────────────

  it("patches multiple files in one call", async () => {
    writeFile("a.txt", "A\n");
    writeFile("b.txt", "B\n");
    const result = await applyPatches([
      { path: "a.txt", edits: [{ old_str: "A", new_str: "AA" }] },
      { path: "b.txt", edits: [{ old_str: "B", new_str: "BB" }] },
    ], tmpDir);
    expect(readFile("a.txt")).toBe("AA\n");
    expect(readFile("b.txt")).toBe("BB\n");
    expect(result.modified).toContain("a.txt");
    expect(result.modified).toContain("b.txt");
  });

  // ── CRLF handling ──────────────────────────────────────────────────────

  it("handles CRLF line endings", async () => {
    writeFile("f.txt", "hello\r\nworld\r\n");
    await applyPatches([
      { path: "f.txt", edits: [{ old_str: "hello", new_str: "HELLO" }] },
    ], tmpDir);
    const content = readFile("f.txt");
    expect(content).toBe("HELLO\r\nworld\r\n");
  });

  it("preserves missing trailing newline", async () => {
    writeFile("f.txt", "hello\nworld"); // no trailing newline
    await applyPatches([
      { path: "f.txt", edits: [{ old_str: "world", new_str: "WORLD" }] },
    ], tmpDir);
    expect(readFile("f.txt")).toBe("hello\nWORLD");
  });

  // ── Error cases ─────────────────────────────────────────────────────────

  it("rejects empty patches array", async () => {
    await expect(applyPatches([], tmpDir)).rejects.toThrow(ParseError);
  });

  it("rejects empty file path", async () => {
    await expect(
      applyPatches([{ path: "", edits: [{ old_str: "x", new_str: "y" }] }], tmpDir),
    ).rejects.toThrow(ParseError);
  });

  it("rejects empty old_str", async () => {
    writeFile("f.txt", "hello\n");
    await expect(
      applyPatches([{ path: "f.txt", edits: [{ old_str: "", new_str: "x" }] }], tmpDir),
    ).rejects.toThrow(ApplyError);
  });

  it("rejects patching a directory", async () => {
    fs.mkdirSync(path.join(tmpDir, "dir"));
    await expect(
      applyPatches([{ path: "dir", edits: [{ old_str: "x", new_str: "y" }] }], tmpDir),
    ).rejects.toThrow(ApplyError);
  });

  // ── formatPatchResult ──────────────────────────────────────────────────

  it("formatPatchResult shows created and modified", () => {
    const r = formatPatchResult({
      created: ["a.txt"],
      modified: ["b.txt"],
      warnings: [],
      replacements: new Map(),
      originalLines: new Map(),
      diff: "",
    });
    expect(r).toContain("A a.txt");
    expect(r).toContain("M b.txt");
  });

  it("formatPatchResult handles empty result", () => {
    const r = formatPatchResult({
      created: [],
      modified: [],
      warnings: [],
      replacements: new Map(),
      originalLines: new Map(),
      diff: "",
    });
    expect(r).toContain("No files were modified");
  });

  // ── generatePatchDiff ──────────────────────────────────────────────────

  it("generatePatchDiff produces diff from replacements", async () => {
    writeFile("f.txt", "hello world\nfoo bar\nbaz\n");
    const result = await applyPatches([
      { path: "f.txt", edits: [{ old_str: "hello", new_str: "HELLO" }] },
    ], tmpDir);
    const diff = generatePatchDiff(result);
    expect(diff).toContain("--- f.txt");
    expect(diff).toContain("+++ f.txt");
    expect(diff).toContain("-1 hello");
    expect(diff).toContain("+1 HELLO");
  });

  it("generatePatchDiff produces diff for multiple edits in one file", async () => {
    writeFile("f.txt", "alpha\nbeta\ngamma\ndelta\n");
    const result = await applyPatches([
      { path: "f.txt", edits: [
        { old_str: "alpha", new_str: "ALPHA" },
        { old_str: "gamma", new_str: "GAMMA" },
      ] },
    ], tmpDir);
    const diff = generatePatchDiff(result);
    expect(diff).toContain("-1 alpha");
    expect(diff).toContain("+1 ALPHA");
    expect(diff).toContain("-3 gamma");
    expect(diff).toContain("+3 GAMMA");
  });

  it("generatePatchDiff merges nearby edits into one visual chunk", async () => {
    writeFile("f.txt", "line1\nline2\nline3\nline4\nline5\n");
    const result = await applyPatches([
      {
        path: "f.txt",
        edits: [
          { old_str: "line1", new_str: "LINE1" },
          { old_str: "line3", new_str: "LINE3" },
        ],
      },
    ], tmpDir);
    const diff = generatePatchDiff(result);

    expect(diff).toContain("@@ lines 1-5 @@");
    expect(diff.match(/\n 2 line2\n/g)?.length ?? 0).toBe(1);
    expect(diff.match(/\n 4 line4\n/g)?.length ?? 0).toBe(1);
    expect(diff).not.toContain("\n\n 2 line2");
  });

  it("generatePatchDiff keeps anchor lines inside merged chunks without extra blank separators", async () => {
    writeFile("f.txt", "alpha\nbeta\ngamma\ndelta\nepsilon\n");
    const result = await applyPatches([
      {
        path: "f.txt",
        edits: [
          { anchor: "alpha", old_str: "alpha", new_str: "ALPHA" },
          { anchor: "gamma", old_str: "gamma", new_str: "GAMMA" },
        ],
      },
    ], tmpDir);
    const diff = generatePatchDiff(result);

    expect(diff).toContain("@@ lines 1-5 @@");
    expect(diff).not.toContain("2 edits, 2 anchors");
    expect(diff).toContain("anchors:\n  - alpha\n  - gamma");
    expect(diff).not.toContain("@@ lines 1-5 @@ anchors: alpha, gamma");
  });

  it("generatePatchDiff lists multiple anchors below the chunk header with +N more", async () => {
    writeFile("f.txt", "one\ntwo\nthree\nfour\nfive\n");
    const result = await applyPatches([
      {
        path: "f.txt",
        edits: [
          { anchor: "one", old_str: "one", new_str: "ONE" },
          { anchor: "three", old_str: "three", new_str: "THREE" },
          { anchor: "five", old_str: "five", new_str: "FIVE" },
        ],
      },
    ], tmpDir);
    const diff = generatePatchDiff(result);

    expect(diff).toContain("@@ lines 1-5 @@");
    expect(diff).not.toContain("3 edits, 3 anchors");
    expect(diff).toContain("anchors:\n  - one\n  - three\n  - +1 more");
    expect(diff).not.toContain("@@ lines 1-5 @@ anchors: one, three, five");
  });

  it("generatePatchDiff trims displayed anchors", async () => {
    writeFile("f.txt", "function foo() {\n  if (true) {\n    return 1;\n  }\n}\n");
    const result = await applyPatches([
      {
        path: "f.txt",
        edits: [
          { anchor: "function foo() {", old_str: "return 1;", new_str: "return 2;" },
          { anchor: "  if (true) {", old_str: "return 2;", new_str: "return 3;" },
        ],
      },
    ], tmpDir);
    const diff = generatePatchDiff(result);

    expect(diff).toContain("anchors:\n  - function foo() {\n  - if (true) {");
    expect(diff).not.toContain("  -   if (true) {");
  });

  it("generatePatchDiff shows missing anchor when fallback search succeeds", async () => {
    writeFile("f.txt", "hello world\n");
    const result = await applyPatches([
      {
        path: "f.txt",
        edits: [
          { anchor: "nope", old_str: "hello", new_str: "hi" },
        ],
      },
    ], tmpDir);
    const diff = generatePatchDiff(result);

    expect(diff).toContain("@@ lines 1 @@ anchor: nope (missing)");
  });

  it("generatePatchDiff preserves context lines after length-changing edits", async () => {
    writeFile("f.txt", "alpha\nstuff\nbeta\ngamma\n");
    const result = await applyPatches([
      { path: "f.txt", edits: [{ old_str: "stuff", new_str: "x" }] },
    ], tmpDir);
    const diff = generatePatchDiff(result);
    // Context lines after the edit (beta, gamma) must be intact, not garbled
    expect(diff).toContain(" 3 beta");
    expect(diff).toContain(" 4 gamma");
  });

  it("applyPatches with anchor substring of old_str still matches", async () => {
    writeFile("f.txt", "    if (has_mounted && m_bformatting == 0 && m_reinit_sta\n    next line\n");
    const result = await applyPatches([
      { path: "f.txt", edits: [{ anchor: "if (has_mounted", old_str: "    if (has_mounted && m_bformatting == 0 && m_reinit_sta", new_str: "    if (has_mounted && m_bformatting == 1 && m_reinit_sta" }] },
    ], tmpDir);
    const diff = generatePatchDiff(result);
    expect(diff).toContain("-1     if (has_mounted && m_bformatting == 0 && m_reinit_sta");
    expect(diff).toContain("+1     if (has_mounted && m_bformatting == 1 && m_reinit_sta");
  });

  it("generatePatchDiff uses a single blank line between distant chunks", async () => {
    writeFile("f.txt", [
      "a01",
      "a02",
      "a03",
      "a04",
      "a05",
      "a06",
      "a07",
      "a08",
      "a09",
      "a10",
      "a11",
      "a12",
      "a13",
      "a14",
      "",
    ].join("\n"));
    const result = await applyPatches([
      {
        path: "f.txt",
        edits: [
          { old_str: "a01", new_str: "A01" },
          { old_str: "a14", new_str: "A14" },
        ],
      },
    ], tmpDir);
    const diff = generatePatchDiff(result);

    expect(diff).toContain("  4 a04\n\n@@ lines 11-14 @@\n 11 a11");
  });

  // ── computePatchPreview ────────────────────────────────────────────────

  it("computePatchPreview generates preview diff (single-file API)", async () => {
    writeFile("f.txt", "hello world\nfoo bar\n");
    const p = await computePatchPreview(
      { path: "f.txt", edits: [{ old_str: "hello", new_str: "HELLO" }] },
      tmpDir,
    );
    expect(p.diff).toBeTruthy();
    expect(p.diff).toContain("-1 hello");
    expect(p.diff).toContain("+1 HELLO");
  });

  it("computePatchPreview shows error for missing file", async () => {
    const p = await computePatchPreview(
      { path: "nope.txt", edits: [{ old_str: "x", new_str: "y" }] },
      tmpDir,
    );
    expect(p.error).toBeTruthy();
  });

  it("passes through normal single-file input unchanged", () => {
    const input = { path: "a.ts", edits: [{ old_str: "x", new_str: "y" }] };
    const result = preparePatchArguments(input);
    expect(result.path).toBe("a.ts");
    expect(result.edits).toEqual([{ old_str: "x", new_str: "y" }]);
  });


  it("repairs edits serialized as string", () => {
    const edits = [{ old_str: "x", new_str: "y" }];
    const input = { path: "a.ts", edits: JSON.stringify(edits) };
    const result = preparePatchArguments(input);
    expect(Array.isArray(result.edits)).toBe(true);
    expect(result.edits).toEqual(edits);
  });

  it("repairs edits string with unescaped newlines", () => {
    const edits = [{ old_str: "OLD", new_str: "/**\n * hello\n */" }];
    const editsStr = JSON.stringify(edits).replace(/\\n/g, '\n');
    const input = { path: "a.ts", edits: editsStr };
    const result = preparePatchArguments(input);
    expect(Array.isArray(result.edits)).toBe(true);
    expect(result.edits[0].new_str).toContain("hello");
  });

  it("handles invalid patches string gracefully", () => {
    const input = { patches: "not valid json" };
    const result = preparePatchArguments(input);
    expect(result.patches).toBe("not valid json");
  });

  it("handles null and undefined input", () => {
    expect(preparePatchArguments(null)).toBe(null);
    expect(preparePatchArguments(undefined)).toBe(undefined);
  });

  it("repairs legacy top-level old_str/new_str", () => {
    const input = { path: "a.ts", old_str: "x", new_str: "y" };
    const result = preparePatchArguments(input);
    expect(result.edits).toEqual([{ old_str: "x", new_str: "y" }]);
    expect(result.old_str).toBeUndefined();
  });

  it("repairs legacy top-level old_str/new_str + anchor", () => {
    const input = { path: "a.ts", old_str: "x", new_str: "y", anchor: "function foo() {" };
    const result = preparePatchArguments(input);
    expect(result.edits[0]).toEqual({ old_str: "x", new_str: "y", anchor: "function foo() {" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// End-to-end: preparePatchArguments → applyPatch pipeline
// ═══════════════════════════════════════════════════════════════════════════


describe("preparePatchArguments → applyPatch pipeline", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-pipeline-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("edits as string → repair → apply", async () => {
    const filePath = path.join(tmpDir, "test2.txt");
    fs.writeFileSync(filePath, "foo bar baz\n");

    const input = { path: filePath, edits: JSON.stringify([{ old_str: "bar", new_str: "BAR" }]) };
    const repaired = preparePatchArguments(input);
    expect(Array.isArray(repaired.edits)).toBe(true);

    const result = await applyPatch(repaired, tmpDir);
    expect(result.modified).toContain(filePath);
    expect(fs.readFileSync(filePath, "utf8")).toBe("foo BAR baz\n");
  });

  it("detects tab vs space mismatch", () => {
    const diag = diagnoseOldStrMismatch("        code", "\t\tcode\n");
    expect(diag).toContain("tab vs space");
  });

  it("detects indent mismatch when tab width doesn't cleanly match spaces", () => {
    const diag = diagnoseOldStrMismatch("    pmod->res", "\t\t\t\tpmod->res\nother\n");
    expect(diag).toContain("indent mismatch");
  });

  it("detects trailing whitespace mismatch", () => {
    const diag = diagnoseOldStrMismatch("hello", "hello \nworld\n");
    expect(diag).toContain("trailing whitespace");
  });

  it("detects case mismatch", () => {
    const diag = diagnoseOldStrMismatch("Hello", "hello\nworld\n");
    expect(diag).toContain("case mismatch");
  });

  it("detects indent mismatch when tab count doesn't cleanly map to any common width", () => {
    // 3 spaces + code: no common tab width (2/4/8) maps 1 tab to 3 spaces
    const diag = diagnoseOldStrMismatch("   code", "\tcode\n");
    expect(diag).toContain("indent mismatch");
  });

  it("detects multi-line block mismatch with exact diff line", () => {
    const diag = diagnoseOldStrMismatch("line1\nwrong\nline3", "line1\ncorrect\nline3\n");
    expect(diag).toContain("diff at line");
    expect(diag).toContain("correct");
    expect(diag).toContain("wrong");
  });

  it("reports not found when content is completely absent", () => {
    const diag = diagnoseOldStrMismatch("missing_content_xyz", "hello\nworld\n");
    expect(diag).toContain("not found anywhere");
  });
});

describe("diagnoseOldStrNotUnique", () => {
  it("lists occurrence line numbers", () => {
    const diag = diagnoseOldStrNotUnique("dup", "dup\na\nb\nc\ndup\n");
    expect(diag).toContain("appears 2 times");
    expect(diag).toContain("line 1");
    expect(diag).toContain("line 5");
  });

  it("caps at 5 occurrences with remaining count", () => {
    const content = Array.from({ length: 7 }, () => "dup\n").join("");
    const diag = diagnoseOldStrNotUnique("dup", content);
    expect(diag).toContain("appears 7 times");
    expect(diag).toContain("and 2 more occurrence");
  });
});
