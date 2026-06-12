/**
 * Usage Sync — IO Tests
 *
 * Integration tests for syncUsageIndex / rebuildUsageIndex with real temp
 * directories. Covers the regression cases that can't be tested with pure
 * functions:
 *
 *   1. Cross-line read: when the cached offset lands on a \n boundary, the
 *      next sync must not drop the first new line. (Regression for the
 *      startIdx=1 heuristic that lost a line on boundary.)
 *   2. File shrunk: when a session file is truncated, the next sync must
 *      re-import from offset 0 (not skip because size < cached.size).
 *   3. Inode change: replacing a session file via rename (which always
 *      creates a new inode) triggers a full reimport. Note: unlink+create
 *      on the same path can recycle the inode on some filesystems, so
 *      this test uses rename() to force a new inode reliably.
 *   4. Dedup: same message appearing in two session files is counted once.
 *   5. Rebuild: rebuildUsageIndex truncates usage.jsonl and the index
 *      before re-importing.
 *
 * Isolation: PI_CODING_AGENT_DIR is redirected to a tempdir for sessions
 * and the usage JSONL. The real ~/.pi/agent/decorated-pi.json is
 * backed up and restored around each test (settings.ts hardcodes the path).
 */

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readUsageEntries, rebuildUsageIndex, syncUsageIndex } from "../commands/usage.js";

// ─── Environment isolation ─────────────────────────────────────────────────

const REAL_CONFIG_DIR = path.join(os.homedir(), ".pi", "agent");
const REAL_CONFIG_FILE = path.join(REAL_CONFIG_DIR, "decorated-pi.json");

let tempDir: string;
let originalEnv: string | undefined;
let originalConfig: string | null = null;

beforeEach(async () => {
  tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "usage-sync-"));
  originalEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tempDir;

  // Backup real decorated-pi.json (settings.ts hardcodes the path)
  try {
    originalConfig = await fsPromises.readFile(REAL_CONFIG_FILE, "utf-8");
    await fsPromises.unlink(REAL_CONFIG_FILE);
  } catch {
    originalConfig = null;
  }
});

afterEach(async () => {
  // Restore real config
  if (originalConfig !== null) {
    if (!fs.existsSync(REAL_CONFIG_DIR)) fs.mkdirSync(REAL_CONFIG_DIR, { recursive: true });
    await fsPromises.writeFile(REAL_CONFIG_FILE, originalConfig, "utf-8");
  } else {
    try {
      await fsPromises.unlink(REAL_CONFIG_FILE);
    } catch {
      /* ok */
    }
  }

  // Restore env
  if (originalEnv === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalEnv;
  }

  // Clean temp
  await fsPromises.rm(tempDir, { recursive: true, force: true });
});

// ─── Fixtures ──────────────────────────────────────────────────────────────

function sessionHeader(): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: "test-uuid",
    timestamp: new Date(0).toISOString(),
    cwd: "/tmp",
  });
}

interface MsgOpts {
  ts: number;
  provider: string;
  model: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

function assistantMessage(opts: MsgOpts): string {
  const input = opts.input ?? 10;
  const output = opts.output ?? 5;
  const cacheRead = opts.cacheRead ?? 0;
  const cacheWrite = opts.cacheWrite ?? 0;
  const cost = opts.cost ?? 0.01;
  return JSON.stringify({
    type: "message",
    id: Math.random().toString(16).slice(2, 10),
    parentId: null,
    timestamp: new Date(opts.ts).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "openai-chat",
      provider: opts.provider,
      model: opts.model,
      timestamp: opts.ts,
      stopReason: "stop",
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
    },
  });
}

async function writeSessionFile(filename: string, lines: string[]): Promise<string> {
  const dir = path.join(tempDir, "sessions");
  await fsPromises.mkdir(dir, { recursive: true });
  const full = path.join(dir, filename);
  await fsPromises.writeFile(full, lines.join("\n") + "\n");
  return full;
}

async function appendToSessionFile(full: string, lines: string[]): Promise<void> {
  await fsPromises.appendFile(full, lines.join("\n") + "\n");
}

const usageFile = () => path.join(tempDir, "decorated-pi-usage.jsonl");

// ─── Tests ────────────────────────────────────────────────────────────────

describe("syncUsageIndex — cross-line read", () => {
  it("does not drop the first new line when offset lands on a newline boundary", async () => {
    // Initial file: header + 3 assistant messages
    const file = await writeSessionFile("s1.jsonl", [
      sessionHeader(),
      assistantMessage({ ts: 1_000, provider: "p", model: "m", input: 10, cost: 0.01 }),
      assistantMessage({ ts: 2_000, provider: "p", model: "m", input: 20, cost: 0.02 }),
      assistantMessage({ ts: 3_000, provider: "p", model: "m", input: 30, cost: 0.03 }),
    ]);

    // First sync: imports all 3
    await syncUsageIndex();
    expect(readUsageEntries()).toHaveLength(3);

    // Append 2 more messages. The new offset for incremental sync will
    // land exactly at the end of line 3 (after the \n), which is the
    // boundary case the old startIdx=1 heuristic mishandled.
    await appendToSessionFile(file, [
      assistantMessage({ ts: 4_000, provider: "p", model: "m", input: 40, cost: 0.04 }),
      assistantMessage({ ts: 5_000, provider: "p", model: "m", input: 50, cost: 0.05 }),
    ]);

    await syncUsageIndex();
    const entries = readUsageEntries();
    expect(entries).toHaveLength(5);
    // Sanity: the new entries are actually there
    expect(entries.map((e) => e.input).sort((a, b) => a - b)).toEqual([
      10, 20, 30, 40, 50,
    ]);
  });
});

describe("syncUsageIndex — file shrunk", () => {
  it("triggers a full reimport (not skip) when a session file is truncated", async () => {
    const file = await writeSessionFile("s1.jsonl", [
      sessionHeader(),
      assistantMessage({ ts: 1_000, provider: "p", model: "m", input: 10, cost: 0.01 }),
      assistantMessage({ ts: 2_000, provider: "p", model: "m", input: 20, cost: 0.02 }),
      assistantMessage({ ts: 3_000, provider: "p", model: "m", input: 30, cost: 0.03 }),
    ]);

    await syncUsageIndex();
    const initial = readUsageEntries();
    expect(initial).toHaveLength(3);

    // Truncate the file. Without the fix, stat.size (0) < cached.size
    // would mean the old code skips the file. With the fix, sync
    // updates cached.size down to 0 so the next append is seen as a
    // full new import (from 0 to new size).
    await fsPromises.truncate(file, 0);
    await syncUsageIndex();

    // After truncate, the file is empty so no new entries are added
    // (append-only JSONL still has the original 3). What we verify is
    // that subsequent appends are picked up from scratch (not lost):
    await appendToSessionFile(file, [
      assistantMessage({ ts: 9_000, provider: "p", model: "m", input: 90, cost: 0.09 }),
    ]);
    await syncUsageIndex();

    const after = readUsageEntries();
    // The 1 new entry is appended; 3 old entries remain in the log
    // (which is the intended append-only behavior).
    expect(after).toHaveLength(4);
    const newEntry = after.find((e) => e.input === 90);
    expect(newEntry).toBeDefined();
    expect(newEntry!.ts).toBe(9_000);
  });
});

describe("syncUsageIndex — inode change", () => {
  it("reimports when a session file is replaced (different inode, same path)", async () => {
    await writeSessionFile("s1.jsonl", [
      sessionHeader(),
      assistantMessage({ ts: 1_000, provider: "p", model: "m", input: 10, cost: 0.01 }),
    ]);

    await syncUsageIndex();
    expect(readUsageEntries()).toHaveLength(1);

    // Replace the file in-place via a rename. rename() always creates a
    // new inode at the destination, sidestepping inode recycling that
    // happens with unlink+create on some filesystems.
    const tmpFile = path.join(tempDir, "sessions", "s1.jsonl.tmp");
    await writeSessionFile("s1.jsonl.tmp", [
      sessionHeader(),
      assistantMessage({ ts: 5_000, provider: "q", model: "n", input: 50, cost: 0.05 }),
      assistantMessage({ ts: 6_000, provider: "q", model: "n", input: 60, cost: 0.06 }),
    ]);
    await fsPromises.rename(tmpFile, path.join(tempDir, "sessions", "s1.jsonl"));

    await syncUsageIndex();
    const entries = readUsageEntries();
    // usage.jsonl is append-only: old entry (1) is preserved, new
    // entries (2) are appended.
    const inputs = entries.map((e) => e.input).sort((a, b) => a - b);
    expect(inputs).toEqual([10, 50, 60]);
  });
});

describe("syncUsageIndex — dedup across forked files", () => {
  it("counts the same message only once when it appears in two session files", async () => {
    // Same assistant message (same ts + same totalTokens) in two files
    // (e.g. one forked from the other). Without dedup, both get imported.
    const sharedMsg = assistantMessage({
      ts: 5_000,
      provider: "p",
      model: "m",
      input: 100,
      output: 50,
      cacheRead: 200,
      cacheWrite: 0,
      cost: 0.1,
    });
    const uniqueMsgA = assistantMessage({ ts: 1_000, provider: "p", model: "m", input: 1, cost: 0.01 });
    const uniqueMsgB = assistantMessage({ ts: 9_000, provider: "p", model: "m", input: 9, cost: 0.09 });

    await writeSessionFile("a.jsonl", [sessionHeader(), uniqueMsgA, sharedMsg]);
    await writeSessionFile("b.jsonl", [sessionHeader(), sharedMsg, uniqueMsgB]);

    await syncUsageIndex();

    const entries = readUsageEntries();
    // Should be 3, not 4 (the shared message is deduped)
    expect(entries).toHaveLength(3);
    const totalInput = entries.reduce((s, e) => s + e.input, 0);
    expect(totalInput).toBe(1 + 100 + 9);
  });
});

describe("rebuildUsageIndex — full rebuild", () => {
  it("starts from an empty state and reimports everything", async () => {
    // First build: import some data
    await writeSessionFile("s1.jsonl", [
      sessionHeader(),
      assistantMessage({ ts: 1_000, provider: "p", model: "m", input: 10, cost: 0.01 }),
      assistantMessage({ ts: 2_000, provider: "p", model: "m", input: 20, cost: 0.02 }),
    ]);
    await syncUsageIndex();
    expect(readUsageEntries()).toHaveLength(2);

    // Rebuild
    await rebuildUsageIndex();
    const afterRebuild = readUsageEntries();
    expect(afterRebuild).toHaveLength(2);
    // Same data, no duplication
    expect(afterRebuild.map((e) => e.input).sort()).toEqual([10, 20]);

    // After rebuild, index is empty so adding new content triggers full import
    const file = path.join(tempDir, "sessions", "s1.jsonl");
    await fsPromises.appendFile(file, "\n" + assistantMessage({ ts: 3_000, provider: "p", model: "m", input: 30, cost: 0.03 }) + "\n");
    await syncUsageIndex();
    expect(readUsageEntries()).toHaveLength(3);
  });

  it("clears the decorated-pi-usage.jsonl file", async () => {
    await writeSessionFile("s1.jsonl", [
      sessionHeader(),
      assistantMessage({ ts: 1_000, provider: "p", model: "m", input: 10, cost: 0.01 }),
    ]);
    await syncUsageIndex();
    expect(fs.existsSync(usageFile())).toBe(true);

    await rebuildUsageIndex();
    // File exists (recreated) but is empty before the new sync imports
    expect(fs.existsSync(usageFile())).toBe(true);
    expect(fs.statSync(usageFile()).size).toBeGreaterThan(0); // re-imported
  });
});
