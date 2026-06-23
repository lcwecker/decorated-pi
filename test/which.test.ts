/**
 * which — binary path lookup.
 *
 * Tests the pure Node PATH walker, the absolute-path shortcut, and the
 * extendPath option (extra dirs/files searched before $PATH).
 * Windows-specific branch (where) is not exercised here.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "../utils/which.js";

describe("which — PATH lookup", () => {
  it("finds a binary on PATH (ls)", () => {
    const result = which("ls");
    expect(result).not.toBeNull();
    expect(result).toMatch(/ls$/);
  });

  it("returns null for non-existent binary", () => {
    expect(which("nonexistent-binary-xyz-12345")).toBeNull();
  });

  it("returns null for empty name", () => {
    expect(which("")).toBeNull();
  });

  it("returns null when name not on PATH and no extendPath", () => {
    expect(which("fake-binary-xyz-12345")).toBeNull();
  });
});

describe("which — absolute/relative path in name", () => {
  it("absolute path is checked directly", () => {
    expect(which("/bin/ls")).toBe("/bin/ls");
  });

  it("absolute path that doesn't exist returns null", () => {
    expect(which("/nonexistent/bin/ls")).toBeNull();
  });

  it("non-executable absolute path returns null", () => {
    // /etc/hostname exists but is not executable
    expect(which("/etc/hostname")).toBeNull();
  });
});

describe("which — extendPath", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "which-test-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds binary in extendPath directory (before $PATH)", () => {
    // Create a fake binary in tmpDir
    const binPath = join(tmpDir, "my-fake-bin");
    writeFileSync(binPath, "#!/bin/sh\necho hi");
    chmodSync(binPath, 0o755);

    const result = which("my-fake-bin", { extendPath: [tmpDir] });
    expect(result).toBe(binPath);
  });

  it("extendPath file entry is checked directly", () => {
    // extendPath entry can be a file path, not just a directory
    const result = which("anything", { extendPath: ["/bin/ls"] });
    expect(result).toBe("/bin/ls");
  });

  it("extendPath wins over $PATH", () => {
    // Put a fake 'ls' in tmpDir; which should return it instead of /usr/bin/ls
    const fakeLs = join(tmpDir, "ls");
    writeFileSync(fakeLs, "#!/bin/sh\necho fake");
    chmodSync(fakeLs, 0o755);

    const result = which("ls", { extendPath: [tmpDir] });
    expect(result).toBe(fakeLs);
  });

  it("extendPath entry that doesn't exist is skipped", () => {
    // Nonexistent dir in extendPath → fall through to $PATH
    const result = which("ls", { extendPath: ["/nonexistent/dir"] });
    expect(result).not.toBe(null);
    expect(result).toMatch(/ls$/);
  });

  it("extendPath file that is not executable is skipped", () => {
    // /etc/hostname exists but isn't executable → skip, fall through to PATH
    const result = which("ls", { extendPath: ["/etc/hostname"] });
    expect(result).not.toBe(null);
    expect(result).toMatch(/ls$/);
  });

  it("extendPath directory without the binary falls through to $PATH", () => {
    // tmpDir exists but doesn't contain 'ls' → $PATH lookup runs
    const result = which("ls", { extendPath: [tmpDir] });
    expect(result).not.toBe(null);
    expect(result).toMatch(/ls$/);
  });

  it("multiple extendPath entries are tried in order", () => {
    const dir1 = mkdtempSync(join(tmpdir(), "which-test-d1-"));
    const dir2 = mkdtempSync(join(tmpdir(), "which-test-d2-"));
    try {
      const bin1 = join(dir1, "ordered-bin");
      const bin2 = join(dir2, "ordered-bin");
      writeFileSync(bin1, "#!/bin/sh\necho first");
      writeFileSync(bin2, "#!/bin/sh\necho second");
      chmodSync(bin1, 0o755);
      chmodSync(bin2, 0o755);

      // dir1 first → bin1 wins
      expect(which("ordered-bin", { extendPath: [dir1, dir2] })).toBe(bin1);
      // dir2 first → bin2 wins
      expect(which("ordered-bin", { extendPath: [dir2, dir1] })).toBe(bin2);
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("empty extendPath array is same as no extendPath", () => {
    const withEmpty = which("ls", { extendPath: [] });
    const noOpts = which("ls");
    expect(withEmpty).toEqual(noOpts);
  });

  it("undefined opts is same as no extendPath", () => {
    const withUndef = which("ls", undefined);
    const noOpts = which("ls");
    expect(withUndef).toEqual(noOpts);
  });

  it("returns null when extendPath empty, name fake, not on PATH", () => {
    expect(which("fake-binary-xyz-12345", { extendPath: [tmpDir] })).toBeNull();
  });

  it("~ in extendPath dir is expanded to home", () => {
    // ~/.wakatime likely doesn't exist on test machine, but shouldn't crash
    // and shouldn't find wakatime-cli. Just verify no throw.
    const result = which("wakatime-cli-probably-missing", { extendPath: ["~/.wakatime"] });
    expect(result).toBeNull();
  });
});

import { beforeEach, afterEach } from "vitest";
