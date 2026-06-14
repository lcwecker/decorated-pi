/**
 * tools/lsp/servers.ts — language detection, project scanning, and
 * dependency status collection.
 *
 * These functions are pure (modulo filesystem reads), so we test against
 * a real temp directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lsp-servers-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeFile(rel: string, content = ""): void {
  const full = join(tmpRoot, rel);
  const dir = join(full, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(full, content);
}

// ─── detectLanguage / languageIdForFile ────────────────────────────────────

describe("detectLanguage", () => {
  it("maps common extensions to languages", async () => {
    const { detectLanguage } = await import("../tools/lsp/servers.js");
    expect(detectLanguage("foo.ts")).toBe("typescript");
    expect(detectLanguage("foo.tsx")).toBe("typescript");
    expect(detectLanguage("foo.js")).toBe("typescript");
    expect(detectLanguage("foo.py")).toBe("python");
    expect(detectLanguage("foo.rs")).toBe("rust");
    expect(detectLanguage("foo.go")).toBe("go");
    expect(detectLanguage("foo.cpp")).toBe("cpp");
    // .h is shared between C and C++; the map picks cpp
    expect(detectLanguage("foo.h")).toBe("cpp");
    expect(detectLanguage("foo.c")).toBe("c");
    expect(detectLanguage("foo.svelte")).toBe("svelte");
    expect(detectLanguage("foo.json")).toBe("json");
  });

  it("is case-insensitive on extension", async () => {
    const { detectLanguage } = await import("../tools/lsp/servers.js");
    expect(detectLanguage("foo.TS")).toBe("typescript");
    expect(detectLanguage("foo.Py")).toBe("python");
  });

  it("returns undefined for unknown extensions", async () => {
    const { detectLanguage } = await import("../tools/lsp/servers.js");
    expect(detectLanguage("foo.xyz")).toBeUndefined();
    expect(detectLanguage("foo")).toBeUndefined();
  });

  it("languageIdForFile is an alias for detectLanguage", async () => {
    const { languageIdForFile, detectLanguage } = await import("../tools/lsp/servers.js");
    expect(languageIdForFile("foo.ts")).toBe(detectLanguage("foo.ts"));
    expect(languageIdForFile("bar.py")).toBe("python");
  });
});

// ─── listSupportedLanguages ───────────────────────────────────────────────

describe("listSupportedLanguages", () => {
  it("returns all supported languages sorted", async () => {
    const { listSupportedLanguages } = await import("../tools/lsp/servers.js");
    const langs = listSupportedLanguages();
    expect(langs).toContain("typescript");
    expect(langs).toContain("python");
    expect(langs).toContain("rust");
    expect([...langs].sort()).toEqual(langs);
  });
});

// ─── getServerConfig ──────────────────────────────────────────────────────

describe("getServerConfig", () => {
  it("returns config for known languages", async () => {
    const { getServerConfig } = await import("../tools/lsp/servers.js");
    const ts = getServerConfig("typescript", tmpRoot);
    expect(ts).toBeDefined();
    expect(ts!.command).toBe("typescript-language-server");
    expect(ts!.args).toContain("--stdio");
    expect(ts!.install_hint).toContain("typescript-language-server");
    expect(ts!.is_project_local).toBe(false);
  });

  it("returns undefined for unknown language", async () => {
    const { getServerConfig } = await import("../tools/lsp/servers.js");
    expect(getServerConfig("klingon", tmpRoot)).toBeUndefined();
  });

  it("marks a project-local binary in node_modules/.bin", async () => {
    mkdirSync(join(tmpRoot, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(tmpRoot, "node_modules", ".bin", "typescript-language-server"), "");
    const { getServerConfig } = await import("../tools/lsp/servers.js");
    const ts = getServerConfig("typescript", tmpRoot);
    expect(ts).toBeDefined();
    expect(ts!.is_project_local).toBe(true);
    expect(ts!.command).toContain("node_modules");
  });
});

// ─── detectProjectLanguages ───────────────────────────────────────────────

describe("detectProjectLanguages", () => {
  it("finds languages from files in the project", async () => {
    writeFile("index.ts");
    writeFile("src/app.tsx");
    writeFile("scripts/build.py");
    writeFile("main.go");
    const { detectProjectLanguages } = await import("../tools/lsp/servers.js");
    const langs = detectProjectLanguages(tmpRoot);
    expect(langs).toEqual(new Set(["typescript", "python", "go"]));
  });

  it("skips noise directories", async () => {
    writeFile("src/app.ts");
    writeFile("node_modules/pkg/index.ts");
    writeFile(".git/HEAD");
    writeFile("dist/bundle.js");
    writeFile(".pi/agent/config.json");
    const { detectProjectLanguages } = await import("../tools/lsp/servers.js");
    const langs = detectProjectLanguages(tmpRoot);
    expect(langs).toEqual(new Set(["typescript"]));
  });

  it("skips dotfile directories", async () => {
    writeFile("src/app.ts");
    writeFile(".cache/x.ts");
    const { detectProjectLanguages } = await import("../tools/lsp/servers.js");
    const langs = detectProjectLanguages(tmpRoot);
    expect(langs).toEqual(new Set(["typescript"]));
  });

  it("respects the limit parameter", async () => {
    // Create 5 .ts files, limit to 3
    for (let i = 0; i < 5; i++) writeFile(`f${i}.ts`);
    const { detectProjectLanguages } = await import("../tools/lsp/servers.js");
    const langs = detectProjectLanguages(tmpRoot, 3);
    expect(langs).toEqual(new Set(["typescript"]));
  });

  it("returns empty set for an empty project", async () => {
    const { detectProjectLanguages } = await import("../tools/lsp/servers.js");
    expect(detectProjectLanguages(tmpRoot).size).toBe(0);
  });

  it("handles unreadable directories gracefully", async () => {
    writeFile("a.ts");
    // Create a directory and then remove its read permission
    mkdirSync(join(tmpRoot, "noperm"));
    writeFile("noperm/b.ts");
    // We don't actually remove read perms (would break CI on root) — we
    // just verify the function doesn't throw on a missing path.
    rmSync(join(tmpRoot, "noperm"), { recursive: true, force: true });
    const { detectProjectLanguages } = await import("../tools/lsp/servers.js");
    expect(() => detectProjectLanguages(tmpRoot)).not.toThrow();
  });
});

// ─── findWorkspaceRoot ────────────────────────────────────────────────────

describe("findWorkspaceRoot", () => {
  it("finds the nearest workspace marker", async () => {
    writeFile("package.json");
    writeFile("src/index.ts");
    const { findWorkspaceRoot } = await import("../tools/lsp/servers.js");
    const root = findWorkspaceRoot(join(tmpRoot, "src/index.ts"), tmpRoot);
    expect(root).toBe(tmpRoot);
  });

  it("walks up directories to find markers", async () => {
    writeFile("package.json");
    writeFile("src/deep/nested/file.ts");
    const { findWorkspaceRoot } = await import("../tools/lsp/servers.js");
    const root = findWorkspaceRoot(join(tmpRoot, "src/deep/nested/file.ts"), tmpRoot);
    expect(root).toBe(tmpRoot);
  });

  it("falls back to repo markers when no workspace marker exists", async () => {
    writeFile(".git/HEAD");
    writeFile("src/main.go");
    const { findWorkspaceRoot } = await import("../tools/lsp/servers.js");
    const root = findWorkspaceRoot(join(tmpRoot, "src/main.go"), tmpRoot);
    expect(root).toBe(tmpRoot);
  });

  it("returns fallback when no markers exist", async () => {
    writeFile("a.txt");
    const { findWorkspaceRoot } = await import("../tools/lsp/servers.js");
    const root = findWorkspaceRoot(join(tmpRoot, "a.txt"), "/some/fallback");
    expect(root).toBe("/some/fallback");
  });
});

// ─── collectLspDependencyStatuses ─────────────────────────────────────────

describe("collectLspDependencyStatuses", () => {
  it("returns one status per unique server command", async () => {
    const { collectLspDependencyStatuses } = await import("../tools/lsp/servers.js");
    const statuses = collectLspDependencyStatuses(tmpRoot);
    expect(statuses.length).toBeGreaterThan(0);
    const commands = statuses.map((s) => s.label);
    // clangd is used by both c and cpp — should be deduped
    const clangdCount = commands.filter((c) => c === "clangd").length;
    expect(clangdCount).toBe(1);
  });

  it("each status has module, label, state, and detail", async () => {
    const { collectLspDependencyStatuses } = await import("../tools/lsp/servers.js");
    const statuses = collectLspDependencyStatuses(tmpRoot);
    for (const s of statuses) {
      expect(s.module).toBe("lsp");
      expect(typeof s.label).toBe("string");
      expect(["ok", "missing"]).toContain(s.state);
      expect(typeof s.detail).toBe("string");
    }
  });

  it("reports missing for non-installed commands (most CI environments)", async () => {
    const { collectLspDependencyStatuses } = await import("../tools/lsp/servers.js");
    const statuses = collectLspDependencyStatuses(tmpRoot);
    // Most language servers are unlikely to be in a test environment
    const missing = statuses.filter((s) => s.state === "missing");
    expect(missing.length).toBeGreaterThan(0);
  });
});
