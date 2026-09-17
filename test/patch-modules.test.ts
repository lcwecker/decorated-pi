/**
 * patch — module layering.
 *
 * `core.ts` is the public entry point and re-exports the sibling modules, so
 * tools and tests keep importing `tools/patch/core.js`. The siblings form an
 * acyclic graph:
 *
 *   types ← lines ← diff
 *   types ← locate ← diagnostics
 *   types ← lines / diagnostics / locate / diff ← core
 *
 * These assertions are the guard: without them a later edit can quietly pull
 * `core.ts` into a helper and reintroduce the cycle this split removed.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const dir = path.join(import.meta.dirname, "../tools/patch");

function source(name: string): string {
  return fs.readFileSync(path.join(dir, `${name}.ts`), "utf-8");
}

/** Local (`./x.js`) imports of a module, as bare module names. */
function localImports(name: string): string[] {
  return [...source(name).matchAll(/from\s+"\.\/([a-z-]+)\.js"/g)].map((m) => m[1]!);
}

describe("patch — module layering", () => {
  it("lines.ts is a leaf (no local imports)", () => {
    expect(localImports("lines")).toEqual([]);
  });

  it("types.ts is a leaf (no local imports)", () => {
    expect(localImports("types")).toEqual([]);
  });

  it("diagnostics.ts is a leaf (no local imports)", () => {
    expect(localImports("diagnostics")).toEqual([]);
  });

  it("diff.ts depends only on lines and types", () => {
    expect([...new Set(localImports("diff"))].sort()).toEqual(["lines", "types"]);
  });

  it("locate.ts depends only on diagnostics, lines, and types", () => {
    expect([...new Set(localImports("locate"))].sort()).toEqual([
      "diagnostics",
      "lines",
      "types",
    ]);
  });

  it("core.ts never imports a sibling back into itself cyclically", () => {
    // Every sibling is a dependency of core, and none of them imports core.
    for (const sibling of ["diff", "diagnostics", "lines", "locate", "types"]) {
      expect(localImports(sibling)).not.toContain("core");
    }
  });

  it("core.ts re-exports the public apply / preview / diagnostics surface", () => {
    const src = source("core");
    for (const symbol of [
      "applyPatch",
      "applyPatches",
      "computePatchPreview",
      "PatchPreview",
      "__patchCoreTest",
    ]) {
      expect(src).toContain(symbol);
    }
    // Re-exported from siblings so `core.js` stays the single entry point.
    expect(src).toContain('export { generatePatchDiff } from "./diff.js"');
    expect(src).toContain('export type { Edit, FilePatch, PatchResult, ReplacementInfo }');
    expect(src).toContain(
      'export { diagnoseOldStrMismatch, diagnoseOldStrNotUnique } from "./diagnostics.js"',
    );
  });

  it("the tool layer registers no agent-loop hook (hard rule)", () => {
    for (const name of ["core", "diff", "diagnostics", "lines", "locate", "types", "index"]) {
      expect(source(name)).not.toContain("pi.on(");
    }
  });
});
