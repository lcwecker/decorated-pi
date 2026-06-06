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
} from "../tools/patch/core.js";
import { preparePatchArguments } from "../tools/patch/index.js";

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

  it("emits no hunk when old_str === new_str (no-op patch)", async () => {
    writeFile("f.txt", "hello world\n");
    const result = await applyPatches([
      { path: "f.txt", edits: [{ old_str: "hello world", new_str: "hello world" }] },
    ], tmpDir);
    // File untouched
    expect(readFile("f.txt")).toBe("hello world\n");
    // Diff should be empty (no hunk to render)
    const diff = generatePatchDiff(result);
    expect(diff).not.toContain("@@");
  });

  it("multi-edit with no-op rep on line > CONTEXT does not throw", async () => {
    // Regression: a no-op rep (old_str === new_str) at a line beyond CONTEXT_LINES
    // used to crash with "Cannot read properties of undefined (reading 'line')"
    // because the empty-hunk guard in computeRenderedRange didn't account for
    // beforeStart being < oldStartLine (which happens when oldStartLine > CONTEXT).
    writeFile("f.txt", "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nlast\n");
    const result = await applyPatches(
      [
        {
          path: "f.txt",
          edits: [
            { old_str: "line 1", new_str: "LINE 1" },
            { old_str: "last", new_str: "last" }, // no-op on a line > CONTEXT (3)
            { old_str: "line 5", new_str: "LINE 5" },
          ],
        },
      ],
      tmpDir,
    );
    expect(readFile("f.txt")).toBe("LINE 1\nline 2\nline 3\nline 4\nLINE 5\nline 6\nline 7\nline 8\nline 9\nlast\n");
    // The diff should render without throwing, and the no-op rep should be skipped
    const diff = generatePatchDiff(result);
    expect(diff).toBeTruthy();
    expect(diff).toContain("LINE 1");
    expect(diff).toContain("LINE 5");
  });

  it("multi-edit with no-op rep does not emit its context lines in diff", async () => {
    // Regression: a no-op rep at line 10 (oldStartLine > CONTEXT=3) used to
    // emit lines 7, 8, 9 as its "before context" in the diff, even though
    // there were no actual changes from that rep. Combined with the real
    // edits at lines 1 and 5, this produced a garbled diff that omitted
    // line 6 (which falls between the no-op's before-context and the
    // trailing context of the last real edit).
    writeFile("f.txt", "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nlast\n");
    const result = await applyPatches(
      [
        {
          path: "f.txt",
          edits: [
            { old_str: "line 1", new_str: "LINE 1" },
            { old_str: "last", new_str: "last" }, // no-op at line 10
            { old_str: "line 5", new_str: "LINE 5" },
          ],
        },
      ],
      tmpDir,
    );
    const diff = generatePatchDiff(result);
    // The diff should contain line 6 (which is the trailing context for
    // the line 5 change — 3 lines after).
    expect(diff).toContain(" 6 line 6");
    expect(diff).toContain(" 7 line 7");
    expect(diff).toContain(" 8 line 8");
    // The no-op rep at line 10 should NOT pull in line 9 (its before
    // context) or "last" (the no-op line itself).
    expect(diff).not.toContain(" 9 line 9");
    expect(diff).not.toContain("last");
  });

  it("LCS added lines use new-file line numbers (no conflict with trailing context)", async () => {
    // Regression: LCS used to label `+` lines with the same formula as
    // context lines (`rep.oldStartLine + j - 1`), which caused added lines
    // and trailing-context lines to share line numbers (e.g. both
    // labelled 944). Fix: context + added now use the new-file line
    // number (computed by a second pass after the LCS), so the line
    // numbers within a hunk are monotonically increasing.
    writeFile(
      "f.txt",
      "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\n",
    );
    const result = await applyPatches(
      [
        {
          path: "f.txt",
          edits: [
            {
              // Multi-line edit inserting 2 lines after line 3 inside a
              // surrounding context. LCS context lines (the parts of
              // old_str that match new_str) and the 2 added lines must
              // have monotonically increasing new-file line numbers.
              old_str: "line 1\nline 2\nline 3\nline 4\nline 5",
              new_str: "line 1\nline 2\nline 3\nINSERTED_A\nINSERTED_B\nline 4\nline 5",
            },
          ],
        },
      ],
      tmpDir,
    );
    const diff = generatePatchDiff(result);
    // Hunk covers 3 before-context + 2 added + 2 inner-context + 3 trailing
    // (lines 6, 7, 8 of original, now at new positions 8, 9, 10)
    expect(diff).toMatch(/@@ lines 1-10 @@/);
    // Added lines at new-file positions 4 and 5
    expect(diff).toContain("+ 4 INSERTED_A");
    expect(diff).toContain("+ 5 INSERTED_B");
    // Context line "line 4" (original line 4) at new-file position 6
    expect(diff).toContain(" 6 line 4");
    // Context line "line 5" (original line 5) at new-file position 7
    expect(diff).toContain(" 7 line 5");
    // Trailing context lines (original 6, 7, 8) at new-file positions 8, 9, 10
    expect(diff).toContain(" 8 line 6");
    expect(diff).toContain(" 9 line 7");
    expect(diff).toContain("10 line 8");
    // Sanity: line numbers in the hunk must be monotonically non-decreasing
    const lineNums = [...diff.matchAll(/^[+\s ]\s*(\d+)/gm)].map(m => Number(m[1]));
    for (let i = 1; i < lineNums.length; i++) {
      expect(lineNums[i]).toBeGreaterThanOrEqual(lineNums[i - 1]!);
    }
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

  it("reports old_str not found after a valid unique anchor", async () => {
    writeFile("f.txt", "function foo() {\n  return 1;\n}\n");
    await expect(
      applyPatches([
        { path: "f.txt", edits: [{ anchor: "function foo() {", old_str: "return 2;", new_str: "return 3;" }] },
      ], tmpDir),
    ).rejects.toThrow(/old_str not found in f\.txt after anchor "function foo\(\) \{"/);
  });

  it("preserves valid-anchor diagnostics after sequential fallback", async () => {
    writeFile("f.txt", "function foo() {\n  return 1;\n}\n");
    await expect(
      applyPatches([
        {
          path: "f.txt",
          edits: [
            { old_str: "return 1;", new_str: "return 2;" },
            { anchor: "function foo() {", old_str: "return 3;", new_str: "return 4;" },
          ],
        },
      ], tmpDir),
    ).rejects.toThrow(/old_str not found in f\.txt after anchor "function foo\(\) \{"/);
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

  it("generatePatchDiff collapses multi-step chained edits to net effect", async () => {
    writeFile("f.txt", "alpha\nbeta\ngamma\ndelta\n");
    const result = await applyPatches([
      {
        path: "f.txt",
        edits: [
          { old_str: "beta", new_str: "BETA_1" },
          { old_str: "BETA_1", new_str: "BETA_2" },
          { old_str: "BETA_2", new_str: "BETA_FINAL" },
        ],
      },
    ], tmpDir);
    const diff = generatePatchDiff(result);

    expect(diff).toContain("-2 beta");
    expect(diff).toContain("+2 BETA_FINAL");
    expect(diff).not.toContain("BETA_1");
    expect(diff).not.toContain("BETA_2");
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

  it("context lines after an insert use original content, not shifted post-edit lines", async () => {
    // old_str=line2, new_str=line2+line2.5 → inserts line2.5. Trailing context must
    // come from the original file (line3, line4), NOT from the shifted post-edit content.
    writeFile("f.txt", "line1\nline2\nline3\nline4\n");
    const result = await applyPatches([
      { path: "f.txt", edits: [{ old_str: "line2", new_str: "line2\nline2.5" }] },
    ], tmpDir);
    const diff = generatePatchDiff(result);
    // Trailing context must be the original line3, not the shifted line2.5 from post-edit content
    expect(diff).toContain(" 3 line3");
    expect(diff).toContain(" 4 line4");
    // Must NOT leak the inserted content into context position
    expect(diff).not.toContain(" 3 line2.5");
  });

  it("hides unchanged interior lines as context, not as fake removals/additions", async () => {
    // LLM supplies a large old_str spanning 12 lines but only two are actually
    // removed. The diff must NOT paint every line as -/+; identical lines
    // inside the block must appear as plain context.
    const oldLines = [
      "static int timer_hb_proc(HEVT hevent, void *p);",            // 1
      "static int timer_event_bus_scheduler(HEVT hevent, void *p);", // 2 (REMOVED)
      "static int backend_ai_init_timer(HEVT hevent, void *p);",     // 3
      "static int on_msg_proc(rpc_msg_param_set_t nparamset);",      // 4
      "",                                                              // 5
      "static int on_task_loop(int stat, bc_mod_base *pmod, void *pctx, int *handled);", // 6
      "static int on_encode_task_loop(int stat, bc_mod_base *pmod, void *pctx, int *handled);", // 7
      "static int on_task_handle(int stat, bc_mod_base *pmod, void *pctx, bc_task_t *ptask);", // 8
      "static int on_task_alarm_oar_notify(int stat, bc_mod_base *pmod, void *pctx, bc_task_t *ptask);", // 9 (REMOVED)
      "static int on_task_end(int stat, bc_mod_base *pmod, void *pctx, bc_task_t *ptask);", // 10
      "};",                                                            // 11
      "#endif",                                                        // 12
    ];
    const newLines = [
      "static int timer_hb_proc(HEVT hevent, void *p);",            // matches old[0]
      "static int backend_ai_init_timer(HEVT hevent, void *p);",     // matches old[2]
      "static int on_msg_proc(rpc_msg_param_set_t nparamset);",      // matches old[3]
      "",                                                              // matches old[4]
      "static int on_task_loop(int stat, bc_mod_base *pmod, void *pctx, int *handled);", // matches old[5]
      "static int on_encode_task_loop(int stat, bc_mod_base *pmod, void *pctx, int *handled);", // matches old[6]
      "static int on_task_handle(int stat, bc_mod_base *pmod, void *pctx, bc_task_t *ptask);", // matches old[7]
      "static int on_task_end(int stat, bc_mod_base *pmod, void *pctx, bc_task_t *ptask);", // matches old[9]
      "};",                                                            // matches old[10]
      "#endif",                                                        // matches old[11]
    ];
    const oldStr = oldLines.join("\n");
    const newStr = newLines.join("\n");
    writeFile("h.h", oldStr + "\n");
    const result = await applyPatches([
      { path: "h.h", edits: [{ old_str: oldStr, new_str: newStr }] },
    ], tmpDir);
    const diff = generatePatchDiff(result);

    // The two lines that were actually removed must appear as - with their
    // original line numbers from the file.
    expect(diff).toContain("- 2 static int timer_event_bus_scheduler");
    expect(diff).toContain("- 9 static int on_task_alarm_oar_notify");

    // Lines that didn't change must NOT appear as -.
    expect(diff).not.toContain("- 1 static int timer_hb_proc");
    expect(diff).not.toContain("- 3 static int backend_ai_init_timer");
    expect(diff).not.toContain("- 4 static int on_msg_proc");
    expect(diff).not.toContain("-10 static int on_task_end");
    expect(diff).not.toContain("-11 };");
    expect(diff).not.toContain("-12 #endif");

    // Unchanged interior lines must surface as context. With new-file
    // line numbering, after the 2 lines are removed, the remaining
    // lines shift up: old 3 → new 2, old 4 → new 3, ..., old 12 → new 10.
    expect(diff).toContain(" 1 static int timer_hb_proc");
    expect(diff).toContain(" 2 static int backend_ai_init_timer");
    expect(diff).toContain(" 3 static int on_msg_proc");
    expect(diff).toContain(" 4 ");
    expect(diff).toContain(" 5 static int on_task_loop");
    expect(diff).toContain(" 6 static int on_encode_task_loop");
    expect(diff).toContain(" 7 static int on_task_handle");
    expect(diff).toContain(" 8 static int on_task_end");
    expect(diff).toContain(" 9 };");
    expect(diff).toContain("10 #endif");

    // No + lines in a pure-deletion case.
    expect(diff).not.toMatch(/^\+ /m);
  });

  it("trims interior context so the hunk doesn't grow with the LLM's old_str", async () => {
    // LLM sends a 22-line old_str block, removing only `do_dispatch:` from the middle.
    // The hunk should NOT show 22 lines of context — it should trim to ~3 lines
    // before and after the actual change.
    const oldLines = [
      "}",
      "if (pos < 0) return false;",
      "",
      "// 写锁 pop + dispatch",
      "beai_event_t evt{};",
      "{",
      "    std::unique_lock wlock(s_evt_queue_rwlock);",
      "    auto& q = s_evt_queue();",
      "    if (pos < (int)q.size() && q[pos].chn == m_chn && q[pos].model == m_model) {",
      "        evt = q[pos];",
      "        q.erase(q.begin() + pos);",
      "    } else {",
      "        return false;  // 被其他 slave 抢走了",
      "    }",
      "}",
      "do_dispatch:",
      "std::visit([this](auto&& payload) { dispatch(payload); }, evt.data);",
      "return true;",
      "}",
      "",
      "void beai_evt_bus_slave::dispatch(const beai_oar_request_payload_t& p)",
      "{",
    ];
    const newLines = [
      "}",
      "if (pos < 0) return false;",
      "",
      "// 写锁 pop + dispatch",
      "beai_event_t evt{};",
      "{",
      "    std::unique_lock wlock(s_evt_queue_rwlock);",
      "    auto& q = s_evt_queue();",
      "    if (pos < (int)q.size() && q[pos].chn == m_chn && q[pos].model == m_model) {",
      "        evt = q[pos];",
      "        q.erase(q.begin() + pos);",
      "    } else {",
      "        return false;  // 被其他 slave 抢走了",
      "    }",
      "}",
      "std::visit([this](auto&& payload) { dispatch(payload); }, evt.data);",
      "return true;",
      "}",
      "",
      "void beai_evt_bus_slave::dispatch(const beai_oar_request_payload_t& p)",
      "{",
    ];
    const oldStr = oldLines.join("\n");
    const newStr = newLines.join("\n");
    writeFile("c.cpp", oldStr + "\n");
    const result = await applyPatches([
      { path: "c.cpp", edits: [{ old_str: oldStr, new_str: newStr }] },
    ], tmpDir);
    const diff = generatePatchDiff(result);

    // Lines far from the change should NOT appear in the diff.
    expect(diff).not.toContain(" 1 }");
    expect(diff).not.toContain(" 2 if (pos < 0) return false;");
    // The hunk body should be small (a handful of context lines + 1 removed).
    const hunkBody = diff.split("\n").filter(l => /^[ +-]\d/.test(l));
    expect(hunkBody.length).toBeLessThan(12);
  });

  it("falls back to minimal-diff rendering for multi-line block edits", async () => {
    // old_str is identical to new_str except one new line is inserted in the middle.
    writeFile("f.txt", "line1\nline2\nline3\n");
    const result = await applyPatches([
      { path: "f.txt", edits: [{ old_str: "line1\nline2\nline3", new_str: "line1\nINSERTED\nline2\nline3" }] },
    ], tmpDir);
    const diff = generatePatchDiff(result);

    // The identical prefix/suffix must be context, not + and -.
    // With new-file line numbering, after the inserted line at position 2,
    // line2 moves to position 3 and line3 moves to position 4.
    expect(diff).toMatch(/^ 1 line1/m);
    expect(diff).toMatch(/^ 3 line2/m);
    expect(diff).toMatch(/^ 4 line3/m);
    // Only the inserted line should appear as +.
    expect(diff).toMatch(/^\+[0-9 ]+INSERTED/m);
    // No - lines, since old_str was a superset of new_str's content.
    expect(diff).not.toMatch(/^-[0-9 ]/m);
  });

  it("rejects overlapping edits targeting the same region", async () => {
    writeFile("f.txt", "alpha\nbeta\ngamma\ndelta\n");
    await expect(applyPatches([
      {
        path: "f.txt",
        edits: [
          { old_str: "beta\ngamma", new_str: "BETA\nGAMMA" },
          { old_str: "gamma\ndelta", new_str: "GAMMA\nDELTA" },
        ],
      },
    ], tmpDir)).rejects.toThrow(/Edits target overlapping regions/);
  });

  it("allows non-overlapping edits in a single batch (one-shot)", async () => {
    writeFile("f.txt", "line1\nline2\nline3\nline4\n");
    const result = await applyPatches([
      {
        path: "f.txt",
        edits: [
          { old_str: "line1", new_str: "LINE1" },
          { old_str: "line4", new_str: "LINE4" },
        ],
      },
    ], tmpDir);
    const final = readFile("f.txt");
    expect(final).toBe("LINE1\nline2\nline3\nLINE4\n");
    const diff = generatePatchDiff(result);
    expect(diff).toContain("LINE1");
    expect(diff).toContain("LINE4");
  });

  it("allows edits sent in reverse order (sorted by position internally)", async () => {
    writeFile("f.txt", "aaa\nbbb\nccc\n");
    // Send edits out of order: line3 first, line1 second
    const result = await applyPatches([
      {
        path: "f.txt",
        edits: [
          { old_str: "ccc", new_str: "CCC" },
          { old_str: "aaa", new_str: "AAA" },
        ],
      },
    ], tmpDir);
    const final = readFile("f.txt");
    expect(final).toBe("AAA\nbbb\nCCC\n");
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
    // `-` line shows the file's actual line content (with full leading
    // whitespace), not the LLM's old_str. So we expect "hello world",
    // not just "hello".
    expect(p.diff).toContain("-1 hello world");
    // `+` line shows the LLM's new_str verbatim (we don't synthesize
    // context for new lines).
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

// ═══════════════════════════════════════════════════════════════════════════
// Diff display: leading whitespace preservation
// ═══════════════════════════════════════════════════════════════════════════

describe("diff display: leading whitespace", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("preserves file's leading whitespace on `-` line even when LLM's old_str has none", async () => {
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "    hello world\n    foo\n");
    const p = await computePatchPreview(
      { path: "f.txt", edits: [{ old_str: "hello world", new_str: "    HELLO world" }] },
      tmpDir,
    );
    // `-` line must show the file's actual content (4-space indent),
    // not the LLM's stripped `old_str`.
    expect(p.diff).toContain("-1     hello world");
    expect(p.diff).toContain("+1     HELLO world");
  });

  it("multi-line old_str with correct context renders all lines with indent", async () => {
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "    line1\n    line2_old\n    line3\n");
    const p = await computePatchPreview(
      { path: "f.txt", edits: [{ old_str: "    line1\n    line2_old\n", new_str: "    line1\n    line2_new\n" }] },
      tmpDir,
    );
    expect(p.diff).toBeTruthy();
    expect(p.diff).toContain("    line1");
    expect(p.diff).toContain("    line2_old");
    expect(p.diff).toContain("    line2_new");
  });

  it("no-op patch produces empty diff (no hunk, no file headers)", async () => {
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "    foo\n    bar\n");
    const p = await computePatchPreview(
      { path: "f.txt", edits: [{ old_str: "    foo", new_str: "    foo" }] },
      tmpDir,
    );
    expect(p.diff ?? "").not.toContain("@@");
  });

  it("LLM strips whitespace from multi-line old_str → patch fails (not our concern)", async () => {
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "    line1\n    line2\n");
    const p = await computePatchPreview(
      { path: "f.txt", edits: [{ old_str: "line1\nline2", new_str: "    line1\n    line2_new\n" }] },
      tmpDir,
    );
    // "line1\nline2" is not a substring of "    line1\n    line2" so it must fail.
    expect(p.error).toBeTruthy();
  });
});
