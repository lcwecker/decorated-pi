/**
 * Tests for patch.ts — old_str / new_str exact replacement
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  applyPatches,
  ParseError,
  ApplyError,
  formatPatchResult,
  generatePatchDiff,
  computePatchPreview,
} from "../extensions/patch.js";

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

  it("fails when anchor appears multiple times", async () => {
    writeFile("f.txt", "marker\nstuff\nmarker\nmore\n");
    await expect(
      applyPatches([
        { path: "f.txt", edits: [{ anchor: "marker", old_str: "stuff", new_str: "x" }] },
      ], tmpDir),
    ).rejects.toThrow(ApplyError);
  });

  it("fails when anchor not found", async () => {
    writeFile("f.txt", "hello world\n");
    await expect(
      applyPatches([
        { path: "f.txt", edits: [{ anchor: "nope", old_str: "hello", new_str: "x" }] },
      ], tmpDir),
    ).rejects.toThrow(ApplyError);
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

  // ── Overwrite ───────────────────────────────────────────────────────────

  it("overwrites existing file atomically", async () => {
    writeFile("f.txt", "old content\n");
    const result = await applyPatches([
      { path: "f.txt", overwrite: true, new_str: "new content\n" },
    ], tmpDir);
    expect(readFile("f.txt")).toBe("new content\n");
    expect(result.modified).toContain("f.txt");
  });

  it("overwrite creates file if not exists", async () => {
    const result = await applyPatches([
      { path: "new.txt", overwrite: true, new_str: "created\n" },
    ], tmpDir);
    expect(readFile("new.txt")).toBe("created\n");
    expect(result.created).toContain("new.txt");
  });

  it("overwrite creates parent directories", async () => {
    await applyPatches([
      { path: "sub/dir/f.txt", overwrite: true, new_str: "hi\n" },
    ], tmpDir);
    expect(readFile("sub/dir/f.txt")).toBe("hi\n");
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

  it("mixes edits and overwrite in one call", async () => {
    writeFile("a.txt", "old\n");
    const result = await applyPatches([
      { path: "a.txt", edits: [{ old_str: "old", new_str: "new" }] },
      { path: "b.txt", overwrite: true, new_str: "created\n" },
    ], tmpDir);
    expect(readFile("a.txt")).toBe("new\n");
    expect(readFile("b.txt")).toBe("created\n");
    expect(result.modified).toContain("a.txt");
    expect(result.created).toContain("b.txt");
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

  it("rejects patch with no edits and no overwrite", async () => {
    await expect(
      applyPatches([{ path: "f.txt" }], tmpDir),
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

  it("generatePatchDiff skips overwrite files (no diff generated)", async () => {
    writeFile("f.txt", "old content\n");
    const result = await applyPatches([
      { path: "f.txt", overwrite: true, new_str: "new content\n" },
    ], tmpDir);
    const diff = generatePatchDiff(result);
    // Overwrite files have no replacement info, so diff is empty
    expect(diff).toBe("");
  });

  // ── computePatchPreview ────────────────────────────────────────────────

  it("computePatchPreview generates preview diffs", async () => {
    writeFile("f.txt", "hello world\nfoo bar\n");
    const previews = await computePatchPreview([
      { path: "f.txt", edits: [{ old_str: "hello", new_str: "HELLO" }] },
    ], tmpDir);
    expect(previews.has("f.txt")).toBe(true);
    const p = previews.get("f.txt")!;
    expect(p.diff).toBeTruthy();
    expect(p.diff).toContain("-1 hello");
    expect(p.diff).toContain("+1 HELLO");
  });

  it("computePatchPreview shows error for missing file", async () => {
    const previews = await computePatchPreview([
      { path: "nope.txt", edits: [{ old_str: "x", new_str: "y" }] },
    ], tmpDir);
    const p = previews.get("nope.txt")!;
    expect(p.error).toBeTruthy();
  });

  it("computePatchPreview returns full content for overwrite (no truncation)", async () => {
    const longContent = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFile("f.txt", "old\n");
    const previews = await computePatchPreview([
      { path: "f.txt", overwrite: true, new_str: longContent },
    ], tmpDir);
    const p = previews.get("f.txt")!;
    expect(p.isOverwrite).toBe(true);
    expect(p.preview).toBe(longContent); // full 30 lines, not truncated to 20
    expect(p.preview!.split("\n")).toHaveLength(30);
    expect(p.diff).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// preparePatchArguments Tests
// ═══════════════════════════════════════════════════════════════════════════

import { preparePatchArguments } from "../extensions/io.js";

describe("preparePatchArguments", () => {
  it("passes through normal input unchanged", () => {
    const input = {
      patches: [
        { path: "a.ts", edits: [{ old_str: "x", new_str: "y" }] },
      ],
    };
    const result = preparePatchArguments(input);
    expect(result.patches).toEqual(input.patches);
  });

  it("repairs patches serialized as string", () => {
    const patches = [{ path: "a.ts", edits: [{ old_str: "x", new_str: "y" }] }];
    const input = {
      patches: JSON.stringify(patches),
    };
    const result = preparePatchArguments(input);
    expect(Array.isArray(result.patches)).toBe(true);
    expect(result.patches).toEqual(patches);
  });

  it("repairs edits serialized as string inside a patch", () => {
    const edits = [{ old_str: "x", new_str: "y" }];
    const input = {
      patches: [
        { path: "a.ts", edits: JSON.stringify(edits) },
      ],
    };
    const result = preparePatchArguments(input);
    expect(Array.isArray(result.patches[0].edits)).toBe(true);
    expect(result.patches[0].edits).toEqual(edits);
  });

  it("handles invalid JSON string gracefully", () => {
    const input = {
      patches: "not valid json",
    };
    const result = preparePatchArguments(input);
    expect(result.patches).toBe("not valid json");
  });

  it("handles null and undefined input", () => {
    expect(preparePatchArguments(null)).toBe(null);
    expect(preparePatchArguments(undefined)).toBe(undefined);
  });

  it("repairs single patch object sent as string (not array)", () => {
    // Some models send a single patch as a JSON object string instead of array
    const input = {
      patches: JSON.stringify({ path: "a.ts", edits: [{ old_str: "x", new_str: "y" }] }),
    };
    const result = preparePatchArguments(input);
    expect(Array.isArray(result.patches)).toBe(true);
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].path).toBe("a.ts");
    expect(Array.isArray(result.patches[0].edits)).toBe(true);
  });

  it("repairs patches where each element is a JSON string", () => {
    // Some models send patches array where each element is a stringified JSON object
    const input = {
      patches: [
        JSON.stringify({ path: "a.ts", edits: [{ old_str: "x", new_str: "y" }] }),
        JSON.stringify({ path: "b.ts", edits: [{ old_str: "x", new_str: "y" }] }),
      ],
    };
    const result = preparePatchArguments(input);
    expect(Array.isArray(result.patches)).toBe(true);
    expect(result.patches).toHaveLength(2);
    expect(result.patches[0].path).toBe("a.ts");
    expect(result.patches[1].path).toBe("b.ts");
    expect(Array.isArray(result.patches[0].edits)).toBe(true);
  });

  it("repairs legacy format with top-level old_str/new_str", () => {
    const input = {
      patches: [{ path: "a.ts", old_str: "x", new_str: "y" }],
    };
    const result = preparePatchArguments(input);
    expect(Array.isArray(result.patches[0].edits)).toBe(true);
    expect(result.patches[0].edits).toHaveLength(1);
    expect(result.patches[0].edits[0].old_str).toBe("x");
    expect(result.patches[0].edits[0].new_str).toBe("y");
    expect(result.patches[0].old_str).toBeUndefined();
  });

  it("repairs legacy format with top-level old_str/new_str + anchor", () => {
    const input = {
      patches: [{ path: "a.ts", old_str: "x", new_str: "y", anchor: "function foo() {" }],
    };
    const result = preparePatchArguments(input);
    const edit = result.patches[0].edits[0];
    expect(edit.old_str).toBe("x");
    expect(edit.new_str).toBe("y");
    expect(edit.anchor).toBe("function foo() {");
  });

  it("drops primitive elements in patches array", () => {
    const input = {
      patches: [null, 42, { path: "a.ts", edits: [{ old_str: "x", new_str: "y" }] }, "bad"],
    };
    const result = preparePatchArguments(input);
    // null, 42, and "bad" (not valid JSON) are all dropped; only the valid object remains
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].path).toBe("a.ts");
  });

  it("repairs patches string with unescaped newlines in nested string values", () => {
    // Models sometimes send patches as a JSON string where new_str contains
    // literal newlines (not \\n). JSON.parse fails on these because
    // JSON strings cannot contain literal newline characters.
    const patches = [{ path: "a.ts", edits: [{ old_str: "OLD", new_str: "/**\n * test\n */" }] }];
    // Simulate what happens: JSON.stringify → the outer framework parses it → patches
    // becomes a string with literal newlines inside new_str
    const patchesStr = JSON.stringify(patches);
    // After outer JSON parse, the new_str values have literal newlines
    const args = { patches: patchesStr.replace(/\\n/g, '\n') };
    // This should now parse correctly despite literal newlines
    const result = preparePatchArguments(args);
    expect(Array.isArray(result.patches)).toBe(true);
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].path).toBe("a.ts");
    expect(result.patches[0].edits[0].new_str).toContain("test");
  });

  it("repairs edits string with unescaped newlines in nested string values", () => {
    // Same issue but at the edits level: edits is a JSON string with unescaped newlines
    const edits = [{ old_str: "OLD", new_str: "/**\n * hello\n */" }];
    const editsStr = JSON.stringify(edits).replace(/\\n/g, '\n');
    const input = {
      patches: [{ path: "a.ts", edits: editsStr }],
    };
    const result = preparePatchArguments(input);
    expect(Array.isArray(result.patches[0].edits)).toBe(true);
    expect(result.patches[0].edits[0].new_str).toContain("hello");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// End-to-end: preparePatchArguments → applyPatches pipeline
// ═══════════════════════════════════════════════════════════════════════════

describe("preparePatchArguments → applyPatches pipeline", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-pipeline-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("patches as string → repair → apply edits", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "hello world\n");

    // Simulate LLM sending patches as a JSON string instead of an array
    const input = {
      patches: JSON.stringify([{ path: filePath, edits: [{ old_str: "hello", new_str: "goodbye" }] }]),
    };

    const repaired = preparePatchArguments(input);
    expect(Array.isArray(repaired.patches)).toBe(true);

    const result = await applyPatches(repaired.patches, tmpDir);
    expect(result.modified).toContain(filePath);
    expect(fs.readFileSync(filePath, "utf8")).toBe("goodbye world\n");
  });

  it("edits as string → repair → apply edits", async () => {
    const filePath = path.join(tmpDir, "test2.txt");
    fs.writeFileSync(filePath, "foo bar baz\n");

    // Simulate LLM sending edits as a JSON string inside the patch object
    const input = {
      patches: [{
        path: filePath,
        edits: JSON.stringify([{ old_str: "bar", new_str: "BAR" }]),
      }],
    };

    const repaired = preparePatchArguments(input);
    expect(Array.isArray(repaired.patches[0].edits)).toBe(true);

    const result = await applyPatches(repaired.patches, tmpDir);
    expect(result.modified).toContain(filePath);
    expect(fs.readFileSync(filePath, "utf8")).toBe("foo BAR baz\n");
  });

  it("patches as string with anchor → repair → apply edits", async () => {
    const filePath = path.join(tmpDir, "test3.txt");
    fs.writeFileSync(filePath, "function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}\n");

    // Simulate LLM sending patches as string, with anchor
    const input = {
      patches: JSON.stringify([{
        path: filePath,
        edits: [{ anchor: "function bar() {", old_str: "return 2;", new_str: "return 42;" }],
      }]),
    };

    const repaired = preparePatchArguments(input);
    expect(Array.isArray(repaired.patches)).toBe(true);

    const result = await applyPatches(repaired.patches, tmpDir);
    expect(result.modified).toContain(filePath);
    expect(fs.readFileSync(filePath, "utf8")).toContain("return 42;");
    expect(fs.readFileSync(filePath, "utf8")).toContain("return 1;"); // foo unchanged
  });

  it("overwrite via repaired patches string", async () => {
    const filePath = path.join(tmpDir, "test4.txt");
    fs.writeFileSync(filePath, "old content\n");

    const input = {
      patches: JSON.stringify([{ path: filePath, overwrite: true, new_str: "new content\n" }]),
    };

    const repaired = preparePatchArguments(input);
    const result = await applyPatches(repaired.patches, tmpDir);
    expect(result.modified).toContain(filePath);
    expect(fs.readFileSync(filePath, "utf8")).toBe("new content\n");
  });
});