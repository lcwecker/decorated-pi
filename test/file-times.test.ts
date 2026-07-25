/**
 * Tests for file-times.ts — mtime tracking for stale-read protection
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  FileTimeTracker,
  createTrackMtimeModule,
  resolveAbsolutePath,
  createFileTimeMarkerData,
  FILE_TIMES_CUSTOM_TYPE,
} from "../hooks/track-mtime.js";

describe("file-times", () => {
  let tmpDir: string;
  let tracker: FileTimeTracker;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "filetimes-test-"));
    tracker = new FileTimeTracker();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── recordReadTime ───

  it("records mtime for an existing file", () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "hello");
    tracker.record(filePath);
    expect(tracker.check(filePath, filePath)).toBeUndefined();
  });

  it("silently skips non-existent files", () => {
    const ghost = path.join(tmpDir, "no-such-file");
    expect(() => tracker.record(ghost)).not.toThrow();
  });

  // ─── check ───

  it("rejects edit on unread existing file — must read first", () => {
    const filePath = path.join(tmpDir, "new.txt");
    fs.writeFileSync(filePath, "content");
    const error = tracker.check(filePath, filePath);
    expect(error).toContain("File not read yet");
    expect(error).toContain("new.txt");
  });

  it("allows edit on non-existent file — creating new file needs no read", () => {
    const filePath = path.join(tmpDir, "brand-new.txt");
    expect(tracker.check(filePath, filePath)).toBeUndefined();
  });

  it("allows edit immediately after read", () => {
    const filePath = path.join(tmpDir, "fresh.txt");
    fs.writeFileSync(filePath, "data");
    tracker.record(filePath);
    expect(tracker.check(filePath, filePath)).toBeUndefined();
  });

  it("blocks edit when file modified after read", () => {
    const filePath = path.join(tmpDir, "stale.txt");
    fs.writeFileSync(filePath, "original");
    tracker.record(filePath);

    const future = new Date(Date.now() + 10000);
    fs.utimesSync(filePath, future, future);

    const error = tracker.check(filePath, filePath);
    expect(error).toContain("File modified since last read");
    expect(error).toContain("stale.txt");
  });

  it("allows edit after re-read", () => {
    const filePath = path.join(tmpDir, "re-read.txt");
    fs.writeFileSync(filePath, "v1");
    tracker.record(filePath);

    const future = new Date(Date.now() + 10000);
    fs.utimesSync(filePath, future, future);

    expect(tracker.check(filePath, filePath)).toContain("File modified since last read");
    tracker.record(filePath);
    expect(tracker.check(filePath, filePath)).toBeUndefined();
  });

  it("allows edit on deleted file (overwrite will recreate)", () => {
    const filePath = path.join(tmpDir, "deleted.txt");
    fs.writeFileSync(filePath, "data");
    tracker.record(filePath);
    fs.unlinkSync(filePath);
    expect(tracker.check(filePath, filePath)).toBeUndefined();
  });

  it("allows edit after patch writes (mtime updated)", () => {
    const filePath = path.join(tmpDir, "after-patch.txt");
    fs.writeFileSync(filePath, "v1");
    tracker.record(filePath);
    fs.writeFileSync(filePath, "v2");
    tracker.record(filePath);
    expect(tracker.check(filePath, filePath)).toBeUndefined();
  });

  // ─── restore ───

  it("restores markers from custom entries on current branch", () => {
    const filePath = path.join(tmpDir, "restored.txt");
    fs.writeFileSync(filePath, "data");
    const marker = createFileTimeMarkerData(tmpDir, filePath)!;

    tracker.restore([
      { type: "custom", customType: FILE_TIMES_CUSTOM_TYPE, data: marker },
    ], tmpDir);

    expect(tracker.check(filePath, filePath)).toBeUndefined();
  });

  it("ignores markers before the last compaction", () => {
    const filePath = path.join(tmpDir, "compacted.txt");
    fs.writeFileSync(filePath, "data");
    const marker = createFileTimeMarkerData(tmpDir, filePath)!;

    tracker.restore([
      { type: "custom", customType: FILE_TIMES_CUSTOM_TYPE, data: marker },
      { type: "compaction" },
    ], tmpDir);

    expect(tracker.check(filePath, filePath)).toContain("File not read yet");
  });

  // ─── clear ───

  it("clears all tracked markers", () => {
    const filePath = path.join(tmpDir, "clear.txt");
    fs.writeFileSync(filePath, "data");
    tracker.record(filePath);

    const future = new Date(Date.now() + 10000);
    fs.utimesSync(filePath, future, future);
    expect(tracker.check(filePath, filePath)).toContain("File modified since last read");

    tracker.clear();
    expect(tracker.check(filePath, filePath)).toContain("File not read yet");
  });

  // ─── instance isolation ───

  it("two tracker instances do not share markers", () => {
    const a = new FileTimeTracker();
    const b = new FileTimeTracker();
    const filePath = path.join(tmpDir, "iso.txt");
    fs.writeFileSync(filePath, "data");

    a.record(filePath);
    // B never recorded — must report unread
    expect(b.check(filePath, filePath)).toContain("File not read yet");
    expect(a.check(filePath, filePath)).toBeUndefined();
  });

  // ─── module preflight ───

  it("blocks patch when an existing file has not been read", () => {
    const filePath = path.join(tmpDir, "unread-patch.txt");
    fs.writeFileSync(filePath, "data");
    const module = createTrackMtimeModule(tracker);

    const result = module.hooks.tool_call![0](
      { toolName: "patch", input: { path: filePath } } as any,
      { cwd: tmpDir } as any,
      {} as any,
    );

    expect(result).toEqual(expect.objectContaining({
      block: true,
      reason: expect.stringContaining("File not read yet"),
    }));
  });

  it("blocks patch when a different part of the file changed after read", () => {
    const filePath = path.join(tmpDir, "stale-patch.txt");
    fs.writeFileSync(filePath, "target=1\nexternal=1\n");
    tracker.record(filePath);
    fs.writeFileSync(filePath, "target=1\nexternal=2\n");
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(filePath, future, future);
    const module = createTrackMtimeModule(tracker);

    const result = module.hooks.tool_call![0](
      { toolName: "patch", input: { path: filePath } } as any,
      { cwd: tmpDir } as any,
      {} as any,
    );

    expect(result).toEqual(expect.objectContaining({
      block: true,
      reason: expect.stringContaining("File modified since last read"),
    }));
  });

  it("allows patch after read and when creating a new file", () => {
    const existing = path.join(tmpDir, "fresh-patch.txt");
    fs.writeFileSync(existing, "data");
    tracker.record(existing);
    const module = createTrackMtimeModule(tracker);
    const call = module.hooks.tool_call![0];

    expect(call(
      { toolName: "patch", input: { path: existing } } as any,
      { cwd: tmpDir } as any,
      {} as any,
    )).toBeUndefined();
    expect(call(
      { toolName: "patch", input: { path: "new-patch.txt" } } as any,
      { cwd: tmpDir } as any,
      {} as any,
    )).toBeUndefined();
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
