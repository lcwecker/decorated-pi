/**
 * smart-at benchmark.
 *
 * Run with `npm run bench` (NOT `npm test`). Compares:
 *   - FFF-backed smart-at (this extension)
 *   - Pi's native @ autocomplete (fd subprocess via CombinedAutocompleteProvider)
 *
 * Reports three things:
 *   1. Speed    — median latency per query (vitest bench)
 *   2. Accuracy — top-1 / top-3 / top-5 hit rate against a ground-truth set
 *   3. Memory   — peak RSS during the benchmark
 *
 * Default corpus: 500k files in a fresh temp dir (override with
 * `BENCH_FILE_COUNT=50000 npm run bench` for a quick run).
 */

import { describe, bench, beforeAll, afterAll } from "vitest";
import { FileFinder } from "@ff-labs/fff-node";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { setupCorpus, teardownCorpus, whichFd, type Corpus, type BenchQuery } from "./fixtures/smart-at-corpus.js";

// ─── Shared state ────────────────────────────────────────────────────────

let corpus: Corpus;
let finder: FileFinder;
let native: CombinedAutocompleteProvider | null = null;
let nativeAvailable = false;
const fdPath = whichFd();

const SPEED_QUERIES = ["button", "service", "config", "main", ".ts", "src/components"];
const ITERATIONS = Number(process.env.BENCH_ITERATIONS) || 30;

const rss = () => process.memoryUsage().rss / 1024 / 1024;

// ─── Accuracy machinery ──────────────────────────────────────────────────

interface HitStats {
  top1: number;
  top3: number;
  top5: number;
  falsePos: number;
  misses: string[];
}

const emptyStats = (): HitStats => ({ top1: 0, top3: 0, top5: 0, falsePos: 0, misses: [] });

const smartAtStats = emptyStats();
const nativeStats = emptyStats();

async function querySmartAt(q: string): Promise<string[]> {
  const r = finder.mixedSearch(q, { pageSize: 20 });
  if (!r.ok) return [];
  return r.value.items
    .filter((it) => it.type === "file" && it.item.gitStatus !== "ignored")
    .filter((it) => it.item.relativePath.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 5)
    .map((it) => it.item.relativePath);
}

async function queryNative(q: string): Promise<string[]> {
  if (!native) return [];
  const r = await native.getSuggestions(
    ["@" + q],
    0,
    q.length + 1,
    { signal: new AbortController().signal },
  );
  if (!r) return [];
  return r.items.map((it: any) => (it.value as string).replace(/^@/, ""));
}

function recordHit(stats: HitStats, paths: string[], q: BenchQuery) {
  const hitIdx = paths.findIndex((p) =>
    p.toLowerCase().includes(q.mustContain.toLowerCase()),
  );
  if (hitIdx === 0) stats.top1++;
  if (hitIdx >= 0 && hitIdx < 3) stats.top3++;
  if (hitIdx >= 0 && hitIdx < 5) stats.top5++;
  if (hitIdx === -1) stats.misses.push(q.q);
  if (q.mustNotContain) {
    const fp = paths.find((p) =>
      p.toLowerCase().includes(q.mustNotContain!.toLowerCase()),
    );
    if (fp) stats.falsePos++;
  }
}

async function runAccuracy(): Promise<void> {
  for (const q of corpus.queries) {
    const ourPaths = await querySmartAt(q.q);
    recordHit(smartAtStats, ourPaths, q);
    if (native) {
      const nativePaths = await queryNative(q.q);
      recordHit(nativeStats, nativePaths, q);
    }
  }
}

function printAccuracyReport(): void {
  const total = corpus.queries.length;
  const pct = (n: number) =>
    total ? `${((n / total) * 100).toFixed(0)}%`.padStart(4) : "  n/a";
  console.log("│");
  console.log(`├─ accuracy (${total} queries)`);
  console.log(`│                  top-1   top-3   top-5   false-pos`);
  console.log(`│  smart-at        ${pct(smartAtStats.top1)}    ${pct(smartAtStats.top3)}    ${pct(smartAtStats.top5)}    ${smartAtStats.falsePos}`);
  console.log(`│  native (fd)     ${pct(nativeStats.top1)}    ${pct(nativeStats.top3)}    ${pct(nativeStats.top5)}    ${nativeStats.falsePos}`);
  if (smartAtStats.misses.length || nativeStats.misses.length) {
    console.log(`│  misses smart-at: ${smartAtStats.misses.join(", ") || "(none)"}`);
    console.log(`│  misses native :  ${nativeStats.misses.join(", ") || "(none)"}`);
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────

const memSnapshots = { start: 0, afterFff: 0, afterBench: 0 };

beforeAll(async () => {
  console.log("\n┌─ smart-at benchmark");
  console.log("│");
  memSnapshots.start = rss();

  const t0 = performance.now();
  corpus = setupCorpus();
  console.log(`├─ generated ${corpus.fileCount.toLocaleString()} files in ${(performance.now() - t0).toFixed(0)} ms`);
  console.log(`│  root: ${corpus.root}`);
  console.log(`│  RSS after generation: ${rss().toFixed(0)} MB`);

  const t1 = performance.now();
  const created = FileFinder.create({ basePath: corpus.root });
  if (!created.ok) throw new Error(`FileFinder.create failed: ${created.error}`);
  finder = created.value;
  const scanResult = await finder.waitForScan(300_000);
  const scanOk = scanResult.ok && scanResult.value;
  console.log(`├─ FFF scan ${scanOk ? "complete" : "timed out"} in ${(performance.now() - t1).toFixed(0)} ms`);
  memSnapshots.afterFff = rss();
  console.log(`│  RSS after FFF index:  ${memSnapshots.afterFff.toFixed(0)} MB (delta: +${(memSnapshots.afterFff - memSnapshots.start).toFixed(0)} MB)`);

  if (fdPath) {
    native = new CombinedAutocompleteProvider([], corpus.root, fdPath);
    nativeAvailable = true;
    console.log(`├─ native @ wired up via ${fdPath}`);
  } else {
    console.log(`├─ native @ skipped (fd/fdfind not found)`);
  }

  // Run accuracy queries once, before speed bench starts
  console.log("├─ running accuracy queries...");
  const tAcc = performance.now();
  await runAccuracy();
  console.log(`│  accuracy queries done in ${(performance.now() - tAcc).toFixed(0)} ms`);
  printAccuracyReport();
  console.log("│");
}, 600_000);

afterAll(() => {
  memSnapshots.afterBench = rss();
  console.log(`├─ memory`);
  console.log(`│  start:                ${memSnapshots.start.toFixed(0).padStart(5)} MB`);
  console.log(`│  after FFF index:      ${memSnapshots.afterFff.toFixed(0).padStart(5)} MB  (+${(memSnapshots.afterFff - memSnapshots.start).toFixed(0)} MB)`);
  console.log(`│  after benchmark loop: ${memSnapshots.afterBench.toFixed(0).padStart(5)} MB  (+${(memSnapshots.afterBench - memSnapshots.start).toFixed(0)} MB)`);
  console.log("│");

  if (finder && !finder.isDestroyed) finder.destroy();
  if (corpus) teardownCorpus(corpus.root);
  console.log("└─ corpus cleaned\n");
});

// ─── Speed benchmark ─────────────────────────────────────────────────────

describe("speed", () => {
  bench(
    `smart-at  (${SPEED_QUERIES.length} queries)`,
    async () => {
      for (const q of SPEED_QUERIES) {
        const lower = q.toLowerCase();
        const r = finder.mixedSearch(q, { pageSize: 100 });
        if (!r.ok) continue;
        r.value.items
          .filter((it) => it.type === "file" && it.item.gitStatus !== "ignored")
          .filter((it) => it.item.relativePath.toLowerCase().includes(lower))
          .slice(0, 20);
      }
    },
    { iterations: ITERATIONS },
  );

  // vitest hoists `describe` and runs the callback at collection time,
  // before beforeAll — so we can't gate bench registration on
  // nativeAvailable. Instead, always register both benches; the native
  // one early-returns if fd is unavailable, so the bench table stays
  // the same shape.
  bench(
    fdPath
      ? `native @  (CombinedAutocompleteProvider, fd subprocess)`
      : `native @  (skipped: fd not found)`,
    async () => {
      if (!native) return;
      for (const q of SPEED_QUERIES) {
        await native.getSuggestions(
          ["@" + q],
          0,
          q.length + 1,
          { signal: new AbortController().signal },
        );
      }
    },
    { iterations: ITERATIONS },
  );
});
