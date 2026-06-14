/**
 * Synthetic corpus for the smart-at benchmark.
 *
 * Generates ~500k files in a fresh temp directory using a deterministic
 * PRNG, so the benchmark is reproducible across runs and machines without
 * committing a real repo. The temp dir is deleted in teardownCorpus().
 *
 * Override the size with BENCH_FILE_COUNT (e.g. 50_000 for a quick run).
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const DEFAULT_FILE_COUNT = 500_000;

const DIRS = ["src", "lib", "test", "docs", "scripts", "configs", "tools", "data"];
const SUBDIRS: Record<string, string[]> = {
  src: ["components", "utils", "pages", "api", "hooks", "types"],
  lib: ["core", "helpers", "vendor"],
  test: ["unit", "integration", "e2e", "fixtures"],
  docs: ["guides", "api", "tutorials"],
  scripts: ["build", "deploy", "utils"],
  configs: ["dev", "prod", "test"],
  tools: ["lint", "format", "analyze"],
  data: ["raw", "processed", "archive"],
};
const EXTS = [
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java",
  ".c", ".cpp", ".h", ".md", ".json", ".yaml", ".toml",
];
const BASE_NAMES = [
  "index", "main", "app", "module", "service", "controller",
  "model", "view", "test", "spec", "config", "util",
  "helper", "type", "interface", "button", "input", "modal",
];

// Hardcoded "spotlight" queries with their expected paths. These are
// picked during generation so the expected paths are guaranteed to exist
// in the freshly created corpus.
export interface BenchQuery {
  q: string;
  mustContain: string; // substring that should appear in at least one top-5 result
  mustNotContain?: string; // substring that should NOT appear in any top-5 result
  description: string;
}

export interface Corpus {
  root: string;
  fileCount: number;
  queries: BenchQuery[];
  spotlights: Map<string, string>; // query -> exact file path (for hit-rate computation)
}

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(arr: T[], r: () => number): T => arr[Math.floor(r() * arr.length)];

function makeFileName(i: number, r: () => number): string {
  const base = pick(BASE_NAMES, r);
  const ext = pick(EXTS, r);
  return `${base}_${i.toString(36)}${ext}`;
}

export function setupCorpus(): Corpus {
  const count = Number(process.env.BENCH_FILE_COUNT) || DEFAULT_FILE_COUNT;
  const root = join(
    tmpdir(),
    `smart-at-bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });

  const r = mulberry32(42);
  const allDirs = new Set<string>();
  const files: string[] = [];
  const spotlights = new Map<string, string>();

  for (let i = 0; i < count; i++) {
    const top = pick(DIRS, r);
    const sub = pick(SUBDIRS[top], r);
    const fileName = makeFileName(i, r);
    const relPath = `${top}/${sub}/${fileName}`;
    files.push(relPath);
    allDirs.add(`${top}/${sub}`);
  }

  // Tracked spotlight files (deterministic picks from the random sequence)
  // These MUST be present; queries are designed around them.
  // (Build artifacts and node_modules are git-ignored; FFF drops them from
  // search results entirely, so we don't test those here.)
  const spotQueries: BenchQuery[] = [
    { q: "button",    mustContain: "button_",     description: "common UI component name" },
    { q: "controller", mustContain: "controller_", description: "common MVC name" },
    { q: "service",   mustContain: "service_",    description: "common service name" },
    { q: "config",    mustContain: "config_",     description: "common config name" },
    { q: "main",      mustContain: "main_",       description: "common entry name" },
    { q: "util",      mustContain: "util_",       description: "common utility name" },
    { q: "index",     mustContain: "index_",      description: "common entrypoint" },
    { q: "spec",      mustContain: "spec_",       description: "common test name" },
    { q: "model",     mustContain: "model_",      description: "common model name" },
    { q: "helper",    mustContain: "helper_",     description: "common helper name" },
    { q: ".ts",       mustContain: ".ts",         description: "extension match" },
    { q: "src/components", mustContain: "src/components/", description: "path-like query" },
    { q: "test/unit", mustContain: "test/unit/",  description: "scoped path query" },
    { q: "config_0",  mustContain: "config_0",    description: "specific generated file" },
  ];

  // Pin specific generated files to ground-truth queries
  for (const sq of spotQueries) {
    const hit = files.find((f) => f.toLowerCase().includes(sq.mustContain.toLowerCase()));
    if (hit) spotlights.set(sq.q, hit);
  }

  // Hardcoded entries that should never match
  mkdirSync(join(root, "node_modules", "lodash"), { recursive: true });
  writeFileSync(join(root, "node_modules", "lodash", "index.js"), "module.exports={};\n");
  mkdirSync(join(root, "build"), { recursive: true });
  writeFileSync(join(root, "build", "output.js"), "// build artifact\n");
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "[core]\n");

  // Initialize a git repo with a .gitignore so FFF can detect ignored paths
  execSync("git init -q", { cwd: root });
  writeFileSync(join(root, ".gitignore"), "node_modules/\nbuild/\n");

  for (const d of allDirs) mkdirSync(join(root, d), { recursive: true });
  for (const f of files) writeFileSync(join(root, f), "");

  return { root, fileCount: count, queries: spotQueries, spotlights };
}

export function teardownCorpus(root: string): void {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

/** Locate the `fd` or `fdfind` binary; null if neither is installed. */
export function whichFd(): string | null {
  for (const name of ["fd", "fdfind"]) {
    try {
      const r = execSync(`command -v ${name}`, { encoding: "utf-8" });
      const path = r.trim();
      if (path) return path;
    } catch {
      // not found
    }
  }
  return null;
}
