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
  generatePatchDiff,
  computePatchPreview,
  diagnoseOldStrMismatch,
  diagnoseOldStrNotUnique,
  __patchCoreTest,
} from "../tools/patch/core.js";
import { detectFileEncoding, readFileDecoded, writeFileEncoded } from "../tools/patch/encoding.js";
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

  // ── formatPatchResult (removed) ─────────────────────────────────────────
  // The LLM-facing execute() now returns the constant "Success" on success.
  // The file list (`result.modified` / `result.created`) is still populated
  // and the diff stays in `details.diff` for the TUI renderer.

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

// ═══════════════════════════════════════════════════════════════════════════
// Diff display: hunk line numbers must be consistent
// ═══════════════════════════════════════════════════════════════════════════

function assertHeaderCoversBody(diff: string | undefined) {
  expect(diff).toBeTruthy();
  const lines = (diff ?? "").split("\n");

  // Parse the hunk header, e.g. "@@ lines 6-13 @@".
  const headerLine = lines.find((l) => l.startsWith("@@ lines"));
  expect(headerLine).toBeTruthy();
  const match = headerLine!.match(/@@ lines (\d+)-(\d+) @@/);
  expect(match).toBeTruthy();
  const headerStart = parseInt(match![1], 10);
  const headerEnd = parseInt(match![2], 10);

  // Collect every line number that appears in the diff body.
  const bodyLineNumbers: number[] = [];
  for (const line of lines) {
    const m = line.match(/^[-+ ]?(\d+) /);
    if (m) bodyLineNumbers.push(parseInt(m[1], 10));
  }

  const minBodyLine = Math.min(...bodyLineNumbers);
  const maxBodyLine = Math.max(...bodyLineNumbers);

  // The header range must cover the full span of displayed line numbers.
  expect(headerStart).toBeLessThanOrEqual(minBodyLine);
  expect(headerEnd).toBeGreaterThanOrEqual(maxBodyLine);
}

describe("diff display: hunk line-number consistency", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-lineno-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });


  it("hunk header range must cover all displayed line numbers (preview path)", async () => {
    // Reproduce a codegraph-style edit: replace a multi-line comment
    // block near the top of a file. Removed lines keep old-file numbers
    // while added/context lines use new-file numbers; the hunk header
    // must still cover every displayed line number.
    const original = [
      "/**",
      " * codegraph builtin MCP server — config + project artefact check.",
      " *",
      " * Enabled state is controlled like any other MCP server: through the",
      " * MCP config (global `~/.pi/agent/mcp.json` under `mcpServers`, or",
      " * project `.pi/agent/mcp.json`) or via the `/mcp` command. There is no",
      " * separate /dp-settings toggle; codegraph is just one MCP server.",
      " *",
      " * Each tool's MCP `description` is injected into the system-prompt",
      " * Guidelines section via `promptGuidelines`, so no separate system-prompt",
      " * block is needed.",
      " */",
      "import * as fs from \"node:fs\";",
      "import * as path from \"node:path\";",
      "import { resolveMcpConfigs } from \"../config.js\";",
      "import type { McpServerConfig } from \"../config.js\";",
      "",
      "export const CODEGRAPH_BUILTIN: Omit<McpServerConfig, \"source\"> = {",
    ].join("\n") + "\n";

    fs.writeFileSync(path.join(tmpDir, "f.txt"), original);

    const oldStr = [
      " * Each tool's MCP `description` is injected into the system-prompt",
      " * Guidelines section via `promptGuidelines`, so no separate system-prompt",
      " * block is needed.",
      "",
    ].join("\n");

    const newStr = [
      " * Each tool's MCP `description` is shown verbatim in the system prompt,",
      " * so no hand-written CodeGraph guidance block is needed.",
      "",
    ].join("\n");

    const p = await computePatchPreview(
      { path: "f.txt", edits: [{ old_str: oldStr, new_str: newStr }] },
      tmpDir,
    );
    assertHeaderCoversBody(p.diff);
  });

  it("hunk header range must cover all displayed line numbers (execute path)", async () => {
    const original = [
      "/**",
      " * codegraph builtin MCP server — config + project artefact check.",
      " *",
      " * Enabled state is controlled like any other MCP server: through the",
      " * MCP config (global `~/.pi/agent/mcp.json` under `mcpServers`, or",
      " * project `.pi/agent/mcp.json`) or via the `/mcp` command. There is no",
      " * separate /dp-settings toggle; codegraph is just one MCP server.",
      " *",
      " * Each tool's MCP `description` is injected into the system-prompt",
      " * Guidelines section via `promptGuidelines`, so no separate system-prompt",
      " * block is needed.",
      " */",
      "import * as fs from \"node:fs\";",
      "import * as path from \"node:path\";",
      "import { resolveMcpConfigs } from \"../config.js\";",
      "import type { McpServerConfig } from \"../config.js\";",
      "",
      "export const CODEGRAPH_BUILTIN: Omit<McpServerConfig, \"source\"> = {",
    ].join("\n") + "\n";

    fs.writeFileSync(path.join(tmpDir, "f.txt"), original);

    const oldStr = [
      " * Each tool's MCP `description` is injected into the system-prompt",
      " * Guidelines section via `promptGuidelines`, so no separate system-prompt",
      " * block is needed.",
      "",
    ].join("\n");

    const newStr = [
      " * Each tool's MCP `description` is shown verbatim in the system prompt,",
      " * so no hand-written CodeGraph guidance block is needed.",
      "",
    ].join("\n");

    const result = await applyPatch(
      { path: "f.txt", edits: [{ old_str: oldStr, new_str: newStr }] },
      tmpDir,
    );
    assertHeaderCoversBody(result.diff);
  });

  it("line numbers stay consistent with CRLF line endings", async () => {
    const original = "line1\r\nline2\r\nline3\r\nline4\r\n";
    fs.writeFileSync(path.join(tmpDir, "f.txt"), original);
    const p = await computePatchPreview(
      { path: "f.txt", edits: [{ old_str: "line3", new_str: "line3_modified" }] },
      tmpDir,
    );
    assertHeaderCoversBody(p.diff);
  });

  it("line numbers stay consistent without trailing newline", async () => {
    const original = "line1\nline2\nline3\nline4"; // no trailing newline
    fs.writeFileSync(path.join(tmpDir, "f.txt"), original);
    const p = await computePatchPreview(
      { path: "f.txt", edits: [{ old_str: "line3", new_str: "line3_modified" }] },
      tmpDir,
    );
    assertHeaderCoversBody(p.diff);
  });

  it("line numbers stay consistent when old_str starts with a newline", async () => {
    // LLM sometimes sends old_str that includes the preceding newline.
    const original = "line1\nline2\nline3\nline4\n";
    fs.writeFileSync(path.join(tmpDir, "f.txt"), original);
    const p = await computePatchPreview(
      { path: "f.txt", edits: [{ old_str: "\nline2\nline3", new_str: "\nline2_new\nline3_new" }] },
      tmpDir,
    );
    assertHeaderCoversBody(p.diff);
  });

  it("line numbers stay consistent for multi-edit chained replacements", async () => {
    const original = [
      "/**",
      " * header",
      " */",
      "const A = 1;",
      "const B = 2;",
      "const C = 3;",
      "const D = 4;",
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(tmpDir, "f.txt"), original);
    const result = await applyPatch(
      {
        path: "f.txt",
        edits: [
          { old_str: "const A = 1;", new_str: "const A = 10;" },
          { old_str: "const C = 3;", new_str: "const C = 30;" },
        ],
      },
      tmpDir,
    );
    assertHeaderCoversBody(result.diff);
  });

  it("line numbers stay consistent when replacement is at the very end of file", async () => {
    const original = "line1\nline2\nline3";
    fs.writeFileSync(path.join(tmpDir, "f.txt"), original);
    const p = await computePatchPreview(
      { path: "f.txt", edits: [{ old_str: "line3", new_str: "line3_last" }] },
      tmpDir,
    );
    assertHeaderCoversBody(p.diff);
  });

  it("line numbers stay consistent for index.ts-style single-line replacement", async () => {
    // Exact file structure the user reported (before the wording patch).
    const original = [
      "",
      "const BASE_GUIDANCE = [",
      '  "## Decorated Pi Guidance",',
      '  "",',
      '  "### Workflow, how to approach tasks",',
      '  "- Before acting on a prompt: 1. ensure you fully understand the user\'s intent — if ambiguous, ask clarifying questions; 2. have researched the existing state — read files, search, investigate. Proceed only when both are clear.",',
      '  "- Exercise caution when performing any **write** operations, especially when you are in a research or exploration phase.",',
      '  "- Before modifying code, match the user\'s existing code style (naming, formatting, patterns). Do not re-modify lines the user has manually edited since your last change.",',
      '  "",',
      '  "### Filesystem Safety, where NOT to write",',
    ].join("\n") + "\n";

    fs.writeFileSync(path.join(tmpDir, "index.ts"), original);

    const oldStr = '  "- Before acting on a prompt: 1. ensure you fully understand the user\'s intent — if ambiguous, ask clarifying questions; 2. have researched the existing state — read files, search, investigate. Proceed only when both are clear.",';
    const newStr = '  "- Before acting on a prompt, have researched the existing state — read files, search, investigate.",';

    const p = await computePatchPreview(
      { path: "index.ts", edits: [{ old_str: oldStr, new_str: newStr }] },
      tmpDir,
    );
    assertHeaderCoversBody(p.diff);
  });

  it("does not collapse sequential edits that do not chain", async () => {
    const original = "alpha\nbeta\ngamma\n";
    fs.writeFileSync(path.join(tmpDir, "chain.ts"), original);

    const p = await computePatchPreview(
      {
        path: "chain.ts",
        edits: [
          { old_str: "alpha", new_str: "ALPHA" },
          { old_str: "gamma", new_str: "GAMMA" },
        ],
      },
      tmpDir,
    );
    expect(p.diff).toContain("-1 alpha");
    expect(p.diff).toContain("+1 ALPHA");
    expect(p.diff).toContain("-3 gamma");
    expect(p.diff).toContain("+3 GAMMA");
  });
});

// ─── diagnoseOldStrMismatch ───────────────────────────────────────────────

describe("diagnoseOldStrMismatch", () => {
  it("reports tab vs space mismatch", async () => {
    const { diagnoseOldStrMismatch } = await import("../tools/patch/core.js");
    const msg = diagnoseOldStrMismatch("    hello", "\thello");
    expect(msg).toContain("tab vs space");
  });

  it("reports trailing whitespace mismatch", async () => {
    const { diagnoseOldStrMismatch } = await import("../tools/patch/core.js");
    const msg = diagnoseOldStrMismatch("hello", "hello ");
    expect(msg).toContain("trailing whitespace mismatch");
  });

  it("reports case mismatch", async () => {
    const { diagnoseOldStrMismatch } = await import("../tools/patch/core.js");
    const msg = diagnoseOldStrMismatch("Hello", "hello");
    expect(msg).toContain("case mismatch");
  });

  it("reports indent mismatch when trimmed content matches", async () => {
    const { diagnoseOldStrMismatch } = await import("../tools/patch/core.js");
    const msg = diagnoseOldStrMismatch("  hello world", "    hello world");
    expect(msg).toContain("indent mismatch");
  });

  it("reports first matching line but full block differs", async () => {
    const { diagnoseOldStrMismatch } = await import("../tools/patch/core.js");
    const content = "line1\nline2\nline3";
    const oldStr = "line1\nchanged";
    const msg = diagnoseOldStrMismatch(oldStr, content);
    expect(msg).toContain("diff at line 2");
    expect(msg).toContain('actual: "line2"');
    expect(msg).toContain('expected: "changed"');
  });

  it("reports first line matches but block length differs", async () => {
    const { diagnoseOldStrMismatch } = await import("../tools/patch/core.js");
    const content = "line1\nline2";
    const oldStr = "line1\nline2\nline3";
    const msg = diagnoseOldStrMismatch(oldStr, content);
    expect(msg).toContain("diff at line 3");
    expect(msg).toContain('actual: "<EOF>"');
    expect(msg).toContain('expected: "line3"');
  });

  it("reports content not found for short strings", async () => {
    const { diagnoseOldStrMismatch } = await import("../tools/patch/core.js");
    const msg = diagnoseOldStrMismatch("xyz", "abc\ndef");
    expect(msg).toBe(""); // firstOldLine.trim().length <= 3
  });

  it("reports content not found for longer strings", async () => {
    const { diagnoseOldStrMismatch } = await import("../tools/patch/core.js");
    const msg = diagnoseOldStrMismatch("this long string is not present", "abc\ndef");
    expect(msg).toContain("not found anywhere in the file");
    expect(msg).toContain("File may have changed");
  });
});

// ─── diagnoseOldStrNotUnique ──────────────────────────────────────────────

describe("diagnoseOldStrNotUnique", () => {
  it("returns empty string when old_str is absent", async () => {
    const { diagnoseOldStrNotUnique } = await import("../tools/patch/core.js");
    expect(diagnoseOldStrNotUnique("missing", "abc\ndef")).toBe("");
  });

  it("reports a single occurrence and suggests adding context", async () => {
    const { diagnoseOldStrNotUnique } = await import("../tools/patch/core.js");
    const msg = diagnoseOldStrNotUnique("unique", "unique\nother");
    expect(msg).toContain("appears 1 times");
    expect(msg).toContain("Add more surrounding context");
  });

  it("lists line numbers of duplicate occurrences", async () => {
    const { diagnoseOldStrNotUnique } = await import("../tools/patch/core.js");
    const msg = diagnoseOldStrNotUnique("dup", "dup\ndup\ndup");
    expect(msg).toContain("appears 3 times");
    expect(msg).toContain("line 1");
    expect(msg).toContain("line 2");
    expect(msg).toContain("line 3");
  });

  it("truncates to 5 occurrences", async () => {
    const { diagnoseOldStrNotUnique } = await import("../tools/patch/core.js");
    const content = Array(10).fill("x").join("\n");
    const msg = diagnoseOldStrNotUnique("x", content);
    expect(msg).toContain("5 more");
  });
});

// ─── chained edit merging ─────────────────────────────────────────────────

describe("chained edit merging in diff", () => {
  let chainTmpDir: string;
  beforeEach(() => {
    chainTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-chain-"));
  });
  afterEach(() => {
    fs.rmSync(chainTmpDir, { recursive: true, force: true });
  });

  function writeChainFile(name: string, content: string): void {
    fs.writeFileSync(path.join(chainTmpDir, name), content, "utf8");
  }
  function readChainFile(name: string): string {
    return fs.readFileSync(path.join(chainTmpDir, name), "utf8");
  }

  it("merges adjacent edits that form a chain", async () => {
    writeChainFile("chain.ts", "a\nb\nc\n");
    const result = await applyPatches([
      {
        path: "chain.ts",
        edits: [
          { old_str: "a", new_str: "A" },
          { old_str: "b", new_str: "B" },
          { old_str: "c", new_str: "C" },
        ],
      },
    ], chainTmpDir);
    expect(readChainFile("chain.ts")).toBe("A\nB\nC\n");
    const diff = generatePatchDiff(result);
    expect(diff).toContain("@@");
  });

  it("handles edits that shift line numbers after replacement", async () => {
    writeChainFile("shift.ts", "line1\nline2\nline3\n");
    const result = await applyPatches([
      {
        path: "shift.ts",
        edits: [
          { old_str: "line1", new_str: "L1\nextra" },
          { old_str: "line3", new_str: "L3" },
        ],
      },
    ], chainTmpDir);
    expect(readChainFile("shift.ts")).toBe("L1\nextra\nline2\nL3\n");
    const diff = generatePatchDiff(result);
    expect(diff).toContain("L1");
    expect(diff).toContain("L3");
  });
});

// ─── internal helpers ─────────────────────────────────────────────────────

describe("patch core internal helpers", () => {
  it("charOffsetToLine returns 1-based line numbers", async () => {
    const { __patchCoreTest } = await import("../tools/patch/core.js");
    expect(__patchCoreTest.charOffsetToLine("abc", 0)).toBe(1);
    expect(__patchCoreTest.charOffsetToLine("a\nb\nc", 2)).toBe(2);
    expect(__patchCoreTest.charOffsetToLine("a\nb\nc", 4)).toBe(3);
    expect(__patchCoreTest.charOffsetToLine("a\nb\nc", 999)).toBe(3);
  });

  it("detectTabWidth returns 0 when there are not enough tab-only lines", async () => {
    const { __patchCoreTest } = await import("../tools/patch/core.js");
    expect(__patchCoreTest.detectTabWidth("no tabs here")).toBe(0);
    expect(__patchCoreTest.detectTabWidth("\t\t\t")).toBe(0);
  });

  it("detectTabWidth infers tab width from indentation progression", async () => {
    const { __patchCoreTest } = await import("../tools/patch/core.js");
    // Tab-only lines with 4-tab progression → differences of 4 → tab width 4
    const content = [
      "\t\t\t\tline",
      "\t\t\t\t\t\t\t\tline",
      "\t\t\t\t\t\t\t\t\t\t\t\tline",
    ].join("\n");
    expect(__patchCoreTest.detectTabWidth(content)).toBe(4);
  });

  it("detectTabWidth infers tab width 2 from 2-tab progression", async () => {
    const { __patchCoreTest } = await import("../tools/patch/core.js");
    const content = [
      "\t\tline",
      "\t\t\t\tline",
      "\t\t\t\t\t\tline",
    ].join("\n");
    expect(__patchCoreTest.detectTabWidth(content)).toBe(2);
  });

  it("detectTabWidth ignores jumps larger than 8", async () => {
    const { __patchCoreTest } = await import("../tools/patch/core.js");
    const content = [
      "\t\t\t\tline",
      "\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\tline", // jump of 12 tabs (16 total)
      "\t\t\t\t\t\t\t\tline",
      "\t\t\t\t\t\t\t\t\t\t\t\tline",
    ].join("\n");
    expect(__patchCoreTest.detectTabWidth(content)).toBe(4);
  });

  it("normalizeIndentForFuzzy preserves identical leading whitespace", async () => {
    const { __patchCoreTest } = await import("../tools/patch/core.js");
    expect(__patchCoreTest.normalizeIndentForFuzzy("  hello", "  world")).toBe("  world");
  });

  it("normalizeIndentForFuzzy replaces new leading whitespace with actual style", async () => {
    const { __patchCoreTest } = await import("../tools/patch/core.js");
    expect(__patchCoreTest.normalizeIndentForFuzzy("\thello", "    world")).toBe("\tworld");
    expect(__patchCoreTest.normalizeIndentForFuzzy("    hello", "\tworld")).toBe("    world");
  });

  it("truncate returns short strings unchanged", async () => {
    const { __patchCoreTest } = await import("../tools/patch/core.js");
    expect(__patchCoreTest.truncate("short")).toBe("short");
  });

  it("truncate returns the first line when it fits", async () => {
    const { __patchCoreTest } = await import("../tools/patch/core.js");
    const first = "first line content";
    const long = `${first}\n${"second line text ".repeat(20)}`;
    expect(__patchCoreTest.truncate(long, 100)).toBe(first);
    expect(__patchCoreTest.truncate(long, 100)).not.toContain("second line");
  });

  it("truncate slices the first line when it exceeds the limit", async () => {
    const { __patchCoreTest } = await import("../tools/patch/core.js");
    const long = "a".repeat(100);
    expect(__patchCoreTest.truncate(long, 20)).toBe("a".repeat(17) + "...");
  });
});

// ─── diagnose with tab files ──────────────────────────────────────────────

describe("diagnoseOldStrMismatch with tab-indented files", () => {
  it("detects tab width and reports a tab-related mismatch", async () => {
    const { diagnoseOldStrMismatch } = await import("../tools/patch/core.js");
    // File uses 4 tabs (16 logical spaces at width 4); old_str uses 16 spaces
    const content = ["\t\t\t\tfoo", "\t\t\t\tbar"].join("\n");
    const msg = diagnoseOldStrMismatch("                foo", content);
    expect(msg).toContain("tab vs space");
  });

  it("uses truncate on very long first lines", async () => {
    const { diagnoseOldStrMismatch } = await import("../tools/patch/core.js");
    const longLine = "x".repeat(200);
    const content = "abc\ndef";
    const msg = diagnoseOldStrMismatch(longLine, content);
    // The message quotes the trimmed first 60 chars; it does not contain "..."
    expect(msg).toContain('Content "');
    expect(msg).toContain('not found anywhere in the file');
    expect(msg.length).toBeLessThan(longLine.length + 50);
  });
});

// ─── applyPatch edge cases ────────────────────────────────────────────────

describe("applyPatch edge cases", () => {
  let edgeTmpDir: string;
  beforeEach(() => {
    edgeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-edge-"));
  });
  afterEach(() => {
    fs.rmSync(edgeTmpDir, { recursive: true, force: true });
  });

  function writeEdgeFile(name: string, content: string): void {
    fs.writeFileSync(path.join(edgeTmpDir, name), content, "utf8");
  }
  function readEdgeFile(name: string): string {
    return fs.readFileSync(path.join(edgeTmpDir, name), "utf8");
  }

  it("handles a replacement at the very end of file without trailing newline", async () => {
    writeEdgeFile("no-nl.txt", "abc");
    await applyPatches([
      { path: "no-nl.txt", edits: [{ old_str: "abc", new_str: "xyz" }] },
    ], edgeTmpDir);
    expect(readEdgeFile("no-nl.txt")).toBe("xyz");
  });

  it("handles fuzzy match when indentation differs", async () => {
    writeEdgeFile("fuzzy.txt", "function foo() {\n  return 1;\n}\n");
    await applyPatches([
      {
        path: "fuzzy.txt",
        edits: [{ old_str: "  return 1;", new_str: "  return 2;" }],
      },
    ], edgeTmpDir);
    expect(readEdgeFile("fuzzy.txt")).toContain("return 2;");
  });

  it("handles fuzzy match with trailing whitespace differences", async () => {
    writeEdgeFile("fuzzy2.txt", "function foo() {\n  return 1; \n}\n");
    await applyPatches([
      {
        path: "fuzzy2.txt",
        edits: [{ old_str: "  return 1;", new_str: "  return 2;" }],
      },
    ], edgeTmpDir);
    expect(readEdgeFile("fuzzy2.txt")).toContain("return 2;");
  });

  it("reports error for non-existent file", async () => {
    await expect(applyPatches(
      [{ path: "missing.txt", edits: [{ old_str: "a", new_str: "b" }] }],
      edgeTmpDir,
    )).rejects.toThrow();
  });

  it("reports error when old_str is not unique", async () => {
    writeEdgeFile("dup.txt", "dup\ndup\ndup\n");
    await expect(applyPatches(
      [{ path: "dup.txt", edits: [{ old_str: "dup", new_str: "x" }] }],
      edgeTmpDir,
    )).rejects.toThrow(/appears 3 times/);
  });

  it("applies a patch that requires tab-vs-space fuzzy matching", async () => {
    writeEdgeFile("tabs.txt", "function foo() {\n\treturn 1;\n}\n");
    await applyPatches([
      {
        path: "tabs.txt",
        edits: [{ old_str: "    return 1;", new_str: "    return 2;" }],
      },
    ], edgeTmpDir);
    expect(readEdgeFile("tabs.txt")).toContain("return 2;");
  });
});

// ─── diagnoseOldStrMismatch first-line-match edge cases ───────────────────

describe("diagnoseOldStrMismatch first-line match", () => {
  it("reports single-line match where the full block does not (defensive branch)", async () => {
    const { diagnoseOldStrMismatch } = await import("../tools/patch/core.js");
    const msg = diagnoseOldStrMismatch("line2", "line1\nline2\nline3");
    expect(msg).toContain("First line matches at line 2, but full 1-line block does not.");
  });
});

// ─── line endings and overwrite ───────────────────────────────────────────

describe("patch line endings and overwrite", () => {
  let leTmpDir: string;
  beforeEach(() => {
    leTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-le-"));
  });
  afterEach(() => {
    fs.rmSync(leTmpDir, { recursive: true, force: true });
  });

  function writeLeFile(name: string, content: string): void {
    fs.writeFileSync(path.join(leTmpDir, name), content, "utf8");
  }
  function readLeFile(name: string): string {
    return fs.readFileSync(path.join(leTmpDir, name), "utf8");
  }

  it("preserves CRLF line endings when editing", async () => {
    writeLeFile("crlf.txt", "line1\r\nline2\r\nline3");
    await applyPatches([
      { path: "crlf.txt", edits: [{ old_str: "line2", new_str: "LINE2" }] },
    ], leTmpDir);
    expect(readLeFile("crlf.txt")).toBe("line1\r\nLINE2\r\nline3");
  });

  it("creates a new file via overwrite", async () => {
    const result = await applyPatches([
      { path: "new.txt", overwrite: true, new_str: "hello world" },
    ], leTmpDir);
    expect(readLeFile("new.txt")).toBe("hello world");
    expect(result.created).toContain("new.txt");
  });

  it("overwrites an existing file via overwrite", async () => {
    writeLeFile("existing.txt", "old content");
    const result = await applyPatches([
      { path: "existing.txt", overwrite: true, new_str: "new content" },
    ], leTmpDir);
    expect(readLeFile("existing.txt")).toBe("new content");
    expect(result.modified).toContain("existing.txt");
  });
});

// ─── chained edit merge break ─────────────────────────────────────────────

describe("chained edit merge break", () => {
  let chainTmpDir: string;
  beforeEach(() => {
    chainTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-chain-"));
  });
  afterEach(() => {
    fs.rmSync(chainTmpDir, { recursive: true, force: true });
  });

  function writeChainFile(name: string, content: string): void {
    fs.writeFileSync(path.join(chainTmpDir, name), content, "utf8");
  }
  function readChainFile(name: string): string {
    return fs.readFileSync(path.join(chainTmpDir, name), "utf8");
  }

  it("does not merge edits whose outputs do not chain", async () => {
    writeChainFile("break.ts", "alpha\nbeta\ngamma\n");
    const result = await applyPatches([
      {
        path: "break.ts",
        edits: [
          { old_str: "alpha", new_str: "ALPHA" },
          { old_str: "gamma", new_str: "GAMMA" },
        ],
      },
    ], chainTmpDir);
    expect(readChainFile("break.ts")).toBe("ALPHA\nbeta\nGAMMA\n");
    expect(result.modified).toContain("break.ts");
  });

  it("collapseSequentialReplacements breaks when next edit does not chain", async () => {
    const { __patchCoreTest } = await import("../tools/patch/core.js");
    const reps = [
      {
        oldStartLine: 1,
        oldEndLine: 1,
        newStartLine: 1,
        newEndLine: 1,
        oldLines: ["alpha"],
        newLines: ["ALPHA"],
        anchor: undefined,
        anchorMissing: false,
      },
      {
        oldStartLine: 3,
        oldEndLine: 3,
        newStartLine: 3,
        newEndLine: 3,
        oldLines: ["gamma"],
        newLines: ["GAMMA"],
        anchor: undefined,
        anchorMissing: false,
      },
    ];
    const collapsed = __patchCoreTest.collapseSequentialReplacements(reps);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0].newLines).toEqual(["ALPHA"]);
    expect(collapsed[1].newLines).toEqual(["GAMMA"]);
  });
});

// ─── generateReplacementDiff edge cases ───────────────────────────────────

describe("generateReplacementDiff", () => {
  it("returns empty string when there are no reps", async () => {
    const { __patchCoreTest } = await import("../tools/patch/core.js");
    expect(__patchCoreTest.generateReplacementDiff("f.txt", [], [])).toBe("");
  });

  it("renders a multi-hunk diff via computePatchPreview", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-multihunk-"));
    try {
      const content = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
      fs.writeFileSync(path.join(tmpDir, "f.txt"), content);
      const p = await computePatchPreview(
        {
          path: "f.txt",
          edits: [
            { old_str: "line2", new_str: "LINE2" },
            { old_str: "line18", new_str: "LINE18" },
          ],
        },
        tmpDir,
      );
      expect(p.diff).toContain("line2");
      expect(p.diff).toContain("LINE2");
      expect(p.diff).toContain("line18");
      expect(p.diff).toContain("LINE18");
      expect(p.diff).toContain("@@ lines 15-20 @@");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── line-ending preservation (byte-faithful writeback) ───────────────────

describe("patch line-ending preservation", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "patch-le2-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function writeBin(name: string, buf: Buffer) {
    const p = path.join(tmp, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    return p;
  }
  function readBin(name: string): Buffer {
    return fs.readFileSync(path.join(tmp, name));
  }

  it("keeps CRLF on untouched lines, writes LF from new_str verbatim", async () => {
    // CRLF file; the edit replaces a CRLF line with an LF-only new_str.
    // Untouched lines must keep CRLF; the replaced line carries LF as given.
    writeBin("crlf.bin", Buffer.from("a\r\nb\r\nc\r\n", "latin1"));
    await applyPatch({
      path: "crlf.bin",
      edits: [{ old_str: "b", new_str: "B1\nB2" }],
    }, tmp);
    const out = readBin("crlf.bin").toString("latin1");
    expect(out).toBe("a\r\nB1\nB2\r\nc\r\n");
  });

  it("does not unify mixed line endings", async () => {
    // Mix of CRLF and LF in the same file; only the edited line changes,
    // every other line keeps its original ending byte-for-byte.
    writeBin("mix.bin", Buffer.from("lf\ncrlf\r\nlf2\n", "latin1"));
    await applyPatch({
      path: "mix.bin",
      edits: [{ old_str: "crlf", new_str: "CRLF" }],
    }, tmp);
    const out = readBin("mix.bin").toString("latin1");
    expect(out).toBe("lf\nCRLF\r\nlf2\n");
  });

  it("spliceOntoRaw leaves untouched bytes identical", () => {
    const { spliceOntoRaw } = __patchCoreTest;
    // raw has CRLF; normalized match happens on LF view; untouched CRLF survives.
    const raw = "x\r\ny\r\nz\r\n";
    const splices = [{ normStart: 2, normEnd: 3, newStr: "Y" }]; // "y" at norm offset 2
    expect(spliceOntoRaw(raw, splices)).toBe("x\r\nY\r\nz\r\n");
  });

  it("buildNormToRawMap maps LF offsets back to CRLF offsets", () => {
    const { buildNormToRawMap } = __patchCoreTest;
    const raw = "a\r\nb\r\n"; // offsets: a=0, \r=1, \n=2, b=3, \r=4, \n=5
    const norm = "a\nb\n";   // offsets: a=0, \n=1, b=2, \n=3
    const map = buildNormToRawMap(raw, norm);
    // norm[0]='a' -> raw 0; norm[1]='\n' came from \r\n -> raw skips to 3? No:
    // map[ni] is recorded BEFORE advancing. map[0]=0, map[1]=1, map[2]=3, map[3]=4, map[4]=6
    expect(map[0]).toBe(0);
    expect(map[1]).toBe(1); // start of \r\n pair
    expect(map[2]).toBe(3); // 'b' in raw
    expect(map[3]).toBe(4); // start of second \r\n
    expect(map[4]).toBe(6); // end of raw
  });
});

// ─── encoding round-trip ──────────────────────────────────────────────────

import * as iconv from "iconv-lite";

describe("patch encoding round-trip", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "patch-enc-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function writeBin(name: string, buf: Buffer) {
    const p = path.join(tmp, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    return p;
  }
  function readBin(name: string): Buffer {
    return fs.readFileSync(path.join(tmp, name));
  }

  it("edits a GBK file and writes back as GBK", async () => {
    // "你好world" in GBK: 你好 = c4 e3 ba c3, then "world" ASCII
    const original = Buffer.concat([
      iconv.encode("你好", "gbk"),
      Buffer.from("world"),
    ]);
    writeBin("gbk.txt", original);
    const decoded = iconv.decode(original, "gbk");
    await applyPatch({
      path: "gbk.txt",
      edits: [{ old_str: "world", new_str: decoded.slice(0, 2) + "!" }],
    }, tmp);
    const outBuf = readBin("gbk.txt");
    const out = iconv.decode(outBuf, "gbk");
    expect(out).toBe("你好你好!");
    // And the bytes must be GBK, not UTF-8 (你 in UTF-8 is e4 bd a0, not c4 e3)
    expect(outBuf.includes(Buffer.from([0xc4, 0xe3]))).toBe(true);
  });

  it("preserves UTF-8 BOM across edits", async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const body = Buffer.from("hello\nworld\n", "utf8");
    writeBin("bom.txt", Buffer.concat([bom, body]));
    await applyPatch({
      path: "bom.txt",
      edits: [{ old_str: "hello", new_str: "HELLO" }],
    }, tmp);
    const out = readBin("bom.txt");
    expect(out[0]).toBe(0xef);
    expect(out[1]).toBe(0xbb);
    expect(out[2]).toBe(0xbf);
    expect(out.subarray(3).toString("utf8")).toBe("HELLO\nworld\n");
  });

  it("preserves UTF-16LE with BOM across edits", async () => {
    const bom = Buffer.from([0xff, 0xfe]);
    const body = iconv.encode("alpha\nbeta\n", "utf-16le");
    writeBin("u16.txt", Buffer.concat([bom, body]));
    await applyPatch({
      path: "u16.txt",
      edits: [{ old_str: "alpha", new_str: "ALPHA" }],
    }, tmp);
    const out = readBin("u16.txt");
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xfe);
    expect(iconv.decode(out, "utf-16le")).toBe("ALPHA\nbeta\n");
  });

  it("overwrite detects existing GBK encoding and writes back in GBK", async () => {
    const original = iconv.encode("旧内容", "gbk");
    writeBin("gbk2.txt", original);
    await applyPatch({
      path: "gbk2.txt",
      overwrite: true,
      new_str: "新内容",
    }, tmp);
    const out = readBin("gbk2.txt");
    expect(iconv.decode(out, "gbk")).toBe("新内容");
    // UTF-8 of 新 is e6 96 b0 — must NOT appear if we stayed in GBK
    expect(out.includes(Buffer.from([0xe6, 0x96, 0xb0]))).toBe(false);
  });

  it("computePatchPreview decodes a GBK file for diff", async () => {
    const original = iconv.encode("你好world", "gbk");
    writeBin("gbk3.txt", original);
    const p = await computePatchPreview(
      { path: "gbk3.txt", edits: [{ old_str: "world", new_str: "WORLD" }] },
      tmp,
    );
    expect(p.diff).toContain("WORLD");
    expect(p.diff).toContain("world");
  });
});

// ─── encoding edge cases ──────────────────────────────────────────────────

describe("patch encoding edge cases", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "patch-enc2-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("treats pure ASCII short file as UTF-8 (no chardet exotic misfire)", () => {
    const p = path.join(tmp, "short.txt");
    fs.writeFileSync(p, "x\n", "utf8");
    const enc = detectFileEncoding(p);
    expect(enc.isUtf8).toBe(true);
    expect(enc.encoding).toBe("utf-8");
    expect(enc.hasBOM).toBe(false);
  });

  it("edits a Big5 file and writes back as Big5", async () => {
    const original = iconv.encode("歡迎world", "big5");
    fs.writeFileSync(path.join(tmp, "big5.txt"), original);
    await applyPatch({
      path: "big5.txt",
      edits: [{ old_str: "world", new_str: "WORLD" }],
    }, tmp);
    const out = fs.readFileSync(path.join(tmp, "big5.txt"));
    // Big5 "歡迎" must round-trip; if we had mis-encoded as UTF-8 the bytes
    // for 歡 (a6 77) would be gone.
    expect(iconv.decode(out, "big5")).toBe("歡迎WORLD");
  });

  it("edits a Latin-1 file with high bytes", async () => {
    // "café" in latin1: 63 61 66 e9
    fs.writeFileSync(path.join(tmp, "lat1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x21]));
    // '!' is ASCII-safe; editing it must keep é (e9) byte-identical.
    await applyPatch({
      path: "lat1.txt",
      edits: [{ old_str: "!", new_str: "?" }],
    }, tmp);
    const out = fs.readFileSync(path.join(tmp, "lat1.txt"));
    expect(Array.from(out)).toEqual([0x63, 0x61, 0x66, 0xe9, 0x3f]);
  });
});

// ─── encoding safety-net branches ─────────────────────────────────────────

describe("patch encoding safety nets", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "patch-enc3-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("detects UTF-16BE with BOM", () => {
    // UTF-16BE BOM = FE FF, then "AB" = 00 41 00 42
    const buf = Buffer.from([0xfe, 0xff, 0x00, 0x41, 0x00, 0x42]);
    fs.writeFileSync(path.join(tmp, "be.txt"), buf);
    const enc = detectFileEncoding(path.join(tmp, "be.txt"));
    expect(enc.encoding).toBe("utf-16be");
    expect(enc.hasBOM).toBe(true);
  });

  it("falls back to a single-byte encoding when UTF-8 is invalid", async () => {
    // Craft bytes that are not valid UTF-8. A lone 0x80 continuation byte is
    // illegal UTF-8; the detector must route to a single-byte legacy encoding
    // (ISO-8859-1 / windows-1252) that round-trips byte-identically, never
    // introducing U+FFFD.
    const buf = Buffer.from([0x80, 0x41]);
    fs.writeFileSync(path.join(tmp, "bad.txt"), buf);
    const enc = detectFileEncoding(path.join(tmp, "bad.txt"));
    expect(enc.isUtf8).toBe(false);
    expect(["iso-8859-1", "windows-1252"]).toContain(enc.encoding);
    // Round-trip must be byte-identical and produce no U+FFFD.
    const s = readFileDecoded(path.join(tmp, "bad.txt"), enc);
    expect(s.includes("\uFFFD")).toBe(false);
    writeFileEncoded(path.join(tmp, "out.txt"), s, enc);
    expect(fs.readFileSync(path.join(tmp, "out.txt"))).toEqual(buf);
  });

  it("buildNormToRawMap handles trailing CR without LF", () => {
    const { buildNormToRawMap } = __patchCoreTest;
    // raw ends with a lone \r (no following \n). normalize turns it into \n.
    const raw = "a\r";
    const norm = "a\n";
    const map = buildNormToRawMap(raw, norm);
    // map[norm.length] must clamp to raw.length, not leave a stale value.
    expect(map[norm.length]).toBe(raw.length);
  });
});
