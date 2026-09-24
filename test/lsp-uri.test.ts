/**
 * tools/lsp/uri.ts — the single URI ↔ path mapping.
 *
 * The client groups rename edits by path and the formatters print paths, so a
 * disagreement here would show up as an edit written to the wrong file or a
 * location the model cannot open.
 */
import { describe, expect, it } from "vitest";
import { filePathToUri, isLocalFilePath, uriToFilePath } from "../tools/lsp/uri.js";

describe("uriToFilePath", () => {
  it("maps a file: URI to an absolute path", () => {
    expect(uriToFilePath("file:///ws/a.ts")).toBe("/ws/a.ts");
  });

  it("percent-decodes the path", () => {
    expect(uriToFilePath("file:///ws/a%20b.ts")).toBe("/ws/a b.ts");
  });

  it("returns a non-file URI verbatim", () => {
    // `untitled:` and `jdt://` are not on disk; callers detect that separately.
    expect(uriToFilePath("untitled:Untitled-1")).toBe("untitled:Untitled-1");
    expect(uriToFilePath("jdt://contents/a.class")).toBe("jdt://contents/a.class");
  });

  it("round-trips through filePathToUri", () => {
    expect(uriToFilePath(filePathToUri("/ws/a b.ts"))).toBe("/ws/a b.ts");
  });
});

describe("isLocalFilePath", () => {
  it("accepts absolute paths on either platform", () => {
    expect(isLocalFilePath("/ws/a.ts")).toBe(true);
    expect(isLocalFilePath("C:\\ws\\a.ts")).toBe(true);
  });

  it("rejects a URI that has no file behind it", () => {
    expect(isLocalFilePath("untitled:Untitled-1")).toBe(false);
    expect(isLocalFilePath("jdt://contents/a.class")).toBe(false);
    expect(isLocalFilePath("relative/a.ts")).toBe(false);
  });
});
