/**
 * Tests for file-times.ts — mtime tracking for stale-read protection
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  recordReadTime,
  checkStaleFile,
  clearReadMarkers,
  resolveAbsolutePath,
} from "../extensions/file-times.js";

describe("file-times", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "filetimes-test-"));
    clearReadMarkers();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── recordReadTime ───

  it("records mtime for an existing file", () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "hello");
    const mtimeBefore = fs.statSync(filePath).mtimeMs;

    recordReadTime(filePath);

    // No error — just verify it doesn't throw
    expect(checkStaleFile(filePath, filePath)).toBeUndefined();
  });

  it("silently skips non-existent files", () => {
    const ghost = path.join(tmpDir, "no-such-file");
    expect(() => recordReadTime(ghost)).not.toThrow();
  });

  // ─── checkStaleFile ───

  it("rejects edit on unread existing file — must read first", () => {
    const filePath = path.join(tmpDir, "new.txt");
    fs.writeFileSync(filePath, "content");
    // File exists but never recorded — must read first
    const error = checkStaleFile(filePath, filePath);
    expect(error).toContain("File not read yet");
    expect(error).toContain("new.txt");
  });

  it("allows edit on non-existent file — creating new file needs no read", () => {
    const filePath = path.join(tmpDir, "brand-new.txt");
    // File does not exist on disk, never read — should allow
    expect(checkStaleFile(filePath, filePath)).toBeUndefined();
  });

  it("allows edit immediately after read", () => {
    const filePath = path.join(tmpDir, "fresh.txt");
    fs.writeFileSync(filePath, "data");
    recordReadTime(filePath);
    expect(checkStaleFile(filePath, filePath)).toBeUndefined();
  });

  it("blocks edit when file modified after read", () => {
    const filePath = path.join(tmpDir, "stale.txt");
    fs.writeFileSync(filePath, "original");
    recordReadTime(filePath);

    // Simulate external modification by touching mtime
    const now = new Date();
    const future = new Date(now.getTime() + 10000);
    fs.utimesSync(filePath, future, future);

    const error = checkStaleFile(filePath, filePath);
    expect(error).toContain("File modified since last read");
    expect(error).toContain("stale.txt");
  });

  it("allows edit after re-read", () => {
    const filePath = path.join(tmpDir, "re-read.txt");
    fs.writeFileSync(filePath, "v1");
    recordReadTime(filePath);

    // Modify externally
    const now = new Date();
    const future = new Date(now.getTime() + 10000);
    fs.utimesSync(filePath, future, future);

    expect(checkStaleFile(filePath, filePath)).toContain("File modified since last read");

    // Re-read records the new mtime
    recordReadTime(filePath);
    expect(checkStaleFile(filePath, filePath)).toBeUndefined();
  });

  it("allows edit on deleted file (overwrite will recreate)", () => {
    const filePath = path.join(tmpDir, "deleted.txt");
    fs.writeFileSync(filePath, "data");
    recordReadTime(filePath);
    fs.unlinkSync(filePath);

    expect(checkStaleFile(filePath, filePath)).toBeUndefined();
  });

  it("allows edit after patch writes (mtime updated)", () => {
    const filePath = path.join(tmpDir, "after-patch.txt");
    fs.writeFileSync(filePath, "v1");
    recordReadTime(filePath);

    // Simulate patch writing the file
    fs.writeFileSync(filePath, "v2");
    recordReadTime(filePath); // patch updates marker

    expect(checkStaleFile(filePath, filePath)).toBeUndefined();
  });

  // ─── clearReadMarkers ───

  it("clears all tracked markers", () => {
    const filePath = path.join(tmpDir, "clear.txt");
    fs.writeFileSync(filePath, "data");
    recordReadTime(filePath);

    // Modify externally
    const now = new Date();
    const future = new Date(now.getTime() + 10000);
    fs.utimesSync(filePath, future, future);

    // Stale detected
    expect(checkStaleFile(filePath, filePath)).toContain("File modified since last read");

    // Clear markers — now requires re-read
    clearReadMarkers();
    expect(checkStaleFile(filePath, filePath)).toContain("File not read yet");
  });

  // ─── resolveAbsolutePath ───

  it("resolves relative paths to absolute", () => {
    const result = resolveAbsolutePath("/home/user/project", "src/file.ts");
    expect(result).toBe(path.normalize("/home/user/project/src/file.ts"));
  });

  it("keeps absolute paths as-is", () => {
    const result = resolveAbsolutePath("/home/user", "/absolute/path.ts");
    expect(result).toBe(path.normalize("/absolute/path.ts"));
  });
});
