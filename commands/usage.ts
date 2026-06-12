/**
 * /usage — token usage statistics dashboard.
 *
 * Incrementally syncs pi session JSONL files into a local index
 * (~/.pi/agent/decorated-pi-usage.jsonl), then aggregates by time
 * slice and model for interactive display.
 *
 * Zero agent-loop hooks — purely command-driven.
 */

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";

import { loadUsageIndex, saveUsageIndex } from "../settings.js";
import { UsageReportComponent } from "../ui/usage.js";

// ─── Paths ─────────────────────────────────────────────────────────────────

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function usageFilePath(): string {
  return path.join(agentDir(), "decorated-pi-usage.jsonl");
}

function sessionsDir(): string {
  return path.join(agentDir(), "sessions");
}

// ─── Types ─────────────────────────────────────────────────────────────────

interface UsageEntry {
  ts: number;
  model: string;
  sessionFile: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface Aggregate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  hitRate: number; // 0-100
}

export interface UsageReport {
  currentSession: Aggregate;
  today: Aggregate;
  thisWeek: Aggregate;
  thisMonth: Aggregate;
  allTime: Aggregate;
  byModel: ModelSlice[];
}

export interface ModelSlice {
  model: string;
  currentSession: Aggregate;
  today: Aggregate;
  thisWeek: Aggregate;
  thisMonth: Aggregate;
  allTime: Aggregate;
}

// ─── Session file scanning ─────────────────────────────────────────────────

async function collectSessionFiles(
  dir: string,
  files: string[],
  signal?: AbortSignal,
): Promise<void> {
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (signal?.aborted) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectSessionFiles(full, files, signal);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  } catch {
    // skip unreadable dirs
  }
}

// ─── Ingestion ─────────────────────────────────────────────────────────────

async function ingestSessionFile(
  filePath: string,
  offset: number,
  seenHashes: Set<string>,
  signal?: AbortSignal,
): Promise<void> {
  const fd = await fsPromises.open(filePath, "r");
  try {
    const stat = await fd.stat();
    const remaining = stat.size - offset;
    if (remaining <= 0) return;

    const buf = Buffer.alloc(remaining);
    await fd.read(buf, 0, remaining, offset);
    const text = buf.toString("utf-8");

    // When offset > 0, we may start at a line boundary (byte before
    // offset is \n) or in the middle of a line. If mid-line, skip until
    // after the next \n so we don't try to parse a half line. If at
    // a boundary, start at position 0 so we don't drop the first
    // complete line in the delta.
    let textStart = 0;
    if (offset > 0) {
      const prevBuf = Buffer.alloc(1);
      await fd.read(prevBuf, 0, 1, offset - 1);
      if (prevBuf[0] !== 0x0a /* \n */) {
        // mid-line: skip the residual
        const nl = text.indexOf("\n");
        if (nl === -1) return; // no complete line in the delta yet
        textStart = nl + 1;
      }
      // else: at a line boundary, textStart stays 0
    }

    const lines = text.slice(textStart).split("\n");

    const entries: UsageEntry[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (signal?.aborted) return;
      if (i % 500 === 0) await new Promise<void>((r) => setImmediate(r));

      const line = lines[i];
      if (!line) continue;

      try {
        const e = JSON.parse(line);
        if (e.type !== "message" || e.message?.role !== "assistant") continue;

        const msg = e.message;
        const usage = msg.usage;
        if (!usage) continue;

        const ts =
          typeof msg.timestamp === "number"
            ? msg.timestamp
            : typeof e.timestamp === "string"
              ? new Date(e.timestamp).getTime()
              : Date.now();

        // dedup across forked/branched session files
        const totalTokens =
          (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
        const hash = `${ts}:${totalTokens}`;
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);

        const model = `${msg.provider ?? "unknown"}/${msg.model ?? "unknown"}`;

        entries.push({
          ts,
          model,
          sessionFile: filePath,
          input: usage.input || 0,
          output: usage.output || 0,
          cacheRead: usage.cacheRead || 0,
          cacheWrite: usage.cacheWrite || 0,
          cost: usage.cost?.total || 0,
        });
      } catch {
        // skip malformed lines
      }
    }

    if (entries.length > 0) {
      const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await fsPromises.appendFile(usageFilePath(), body);
    }
  } finally {
    await fd.close();
  }
}

// ─── Incremental sync ──────────────────────────────────────────────────────

export async function syncUsageIndex(signal?: AbortSignal): Promise<void> {
  const index = loadUsageIndex();
  const files: string[] = [];
  const seenHashes = new Set<string>();

  await collectSessionFiles(sessionsDir(), files, signal);

  for (const filePath of files) {
    if (signal?.aborted) return;

    let stat: fs.Stats;
    try {
      stat = await fsPromises.stat(filePath);
    } catch {
      delete index[filePath];
      continue;
    }

    const cached = index[filePath];

    // Trigger a full reimport if any of:
    //   - no cache entry (first time seeing this file)
    //   - inode changed (file was replaced with a different inode)
    //   - inode was recycled BUT the file is shorter than we remembered
    //     (truncation/rotation)
    if (
      !cached ||
      cached.inode !== stat.ino ||
      stat.size < cached.size
    ) {
      // full reimport
      await ingestSessionFile(filePath, 0, seenHashes, signal);
    } else if (stat.size > cached.size) {
      // append-only → import delta
      await ingestSessionFile(filePath, cached.size, seenHashes, signal);
    }
    // else: unchanged

    index[filePath] = { inode: stat.ino, size: stat.size, mtime: stat.mtimeMs };
  }

  // prune stale entries
  const existing = new Set(files);
  for (const key of Object.keys(index)) {
    if (!existing.has(key)) delete index[key];
  }

  saveUsageIndex(index);
}

/** Full rebuild: clear index + JSONL, re-import everything. */
export async function rebuildUsageIndex(signal?: AbortSignal): Promise<void> {
  saveUsageIndex({});
  try {
    await fsPromises.truncate(usageFilePath(), 0);
  } catch {
    // file may not exist yet
  }
  await syncUsageIndex(signal);
}

// ─── Read our JSONL ────────────────────────────────────────────────────────

export function readUsageEntries(): UsageEntry[] {
  try {
    if (!fs.existsSync(usageFilePath())) return [];
    const text = fs.readFileSync(usageFilePath(), "utf-8");
    const entries: UsageEntry[] = [];
    for (const line of text.trim().split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as UsageEntry);
      } catch {
        // skip
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ─── Aggregation ───────────────────────────────────────────────────────────

function emptyAggregate(): Aggregate {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, hitRate: 0 };
}

function getPeriods(): { todayMs: number; weekStartMs: number; monthStartMs: number } {
  const now = new Date();
  const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const dow = now.getDay();
  const monOffset = dow === 0 ? 6 : dow - 1; // Monday = 0
  const weekStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() - monOffset).getTime();

  const monthStartMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  return { todayMs, weekStartMs, monthStartMs };
}

function accum(a: Aggregate, e: UsageEntry): void {
  a.input += e.input;
  a.output += e.output;
  a.cacheRead += e.cacheRead;
  a.cacheWrite += e.cacheWrite;
  a.cost += e.cost;
  a.turns++;
}

function computeHitRate(a: Aggregate): void {
  const total = a.input + a.cacheRead + a.cacheWrite;
  a.hitRate = total > 0 ? Math.round((100 * a.cacheRead) / total) : 0;
}

export function aggregate(entries: UsageEntry[], currentSessionFile?: string): UsageReport {
  const { todayMs, weekStartMs, monthStartMs } = getPeriods();

  type SliceKey = "currentSession" | "today" | "thisWeek" | "thisMonth" | "allTime";

  const overall: Record<SliceKey, Aggregate> = {
    currentSession: emptyAggregate(),
    today: emptyAggregate(),
    thisWeek: emptyAggregate(),
    thisMonth: emptyAggregate(),
    allTime: emptyAggregate(),
  };

  const modelMap = new Map<string, Record<SliceKey, Aggregate>>();
  const modelLastUsed = new Map<string, number>();
  const isCurrentSession = (e: UsageEntry) =>
    currentSessionFile ? e.sessionFile === currentSessionFile : false;

  for (const e of entries) {
    accum(overall.allTime, e);
    if (e.ts >= todayMs) accum(overall.today, e);
    if (e.ts >= weekStartMs) accum(overall.thisWeek, e);
    if (e.ts >= monthStartMs) accum(overall.thisMonth, e);
    if (isCurrentSession(e)) accum(overall.currentSession, e);

    let m = modelMap.get(e.model);
    if (!m) {
      m = {
        currentSession: emptyAggregate(),
        today: emptyAggregate(),
        thisWeek: emptyAggregate(),
        thisMonth: emptyAggregate(),
        allTime: emptyAggregate(),
      };
      modelMap.set(e.model, m);
    }
    accum(m.allTime, e);
    if (e.ts >= todayMs) accum(m.today, e);
    if (e.ts >= weekStartMs) accum(m.thisWeek, e);
    if (e.ts >= monthStartMs) accum(m.thisMonth, e);
    if (isCurrentSession(e)) accum(m.currentSession, e);

    // track most recent usage per model
    if (e.ts > (modelLastUsed.get(e.model) ?? 0)) {
      modelLastUsed.set(e.model, e.ts);
    }
  }

  // compute hit rates
  for (const key of Object.keys(overall) as SliceKey[]) {
    computeHitRate(overall[key]);
  }
  for (const m of modelMap.values()) {
    for (const key of Object.keys(m) as SliceKey[]) {
      computeHitRate(m[key]);
    }
  }

  const byModel: ModelSlice[] = Array.from(modelMap.entries())
    .map(([model, slices]) => ({ model, ...slices }))
    .sort(
      (a, b) =>
        (modelLastUsed.get(b.model) ?? 0) - (modelLastUsed.get(a.model) ?? 0) ||
        a.model.localeCompare(b.model),
    );

  return { ...overall, byModel };
}

// ─── Formatting ────────────────────────────────────────────────────────────

export function formatTokens(n: number): string {
  if (n === 0) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  const m = n / 1_000_000;
  return m >= 100 ? `${Math.round(m)}M` : `${m.toFixed(2)}M`;
}

export function formatCost(c: number): string {
  if (c === 0) return "—";
  if (c < 0.01) return "<$0.01";
  if (c < 1000) return `$${c.toFixed(2)}`;
  const k = c / 1000;
  return `$${k.toFixed(1)}k`;
}

export function formatHitRate(hitRate: number, turns: number): string {
  if (turns === 0) return "—";
  return `${hitRate}%`;
}

export type ColumnId = "input" | "output" | "cacheRead" | "cacheWrite" | "hitRate" | "cost";

const WIDE_COLS: ColumnId[] = ["input", "output", "cacheRead", "cacheWrite", "hitRate", "cost"];
const MED_COLS: ColumnId[] = ["input", "output", "hitRate", "cost"];
const NARROW_COLS: ColumnId[] = ["hitRate", "cost"];

export function pickColumns(width: number): ColumnId[] {
  if (width >= 80) return WIDE_COLS;
  if (width >= 50) return MED_COLS;
  return NARROW_COLS;
}

export function formatCell(col: ColumnId, agg: Aggregate): string {
  switch (col) {
    case "input":
      return formatTokens(agg.input + agg.cacheRead + agg.cacheWrite);
    case "output":
      return formatTokens(agg.output);
    case "cacheRead":
      return formatTokens(agg.cacheRead);
    case "cacheWrite":
      return formatTokens(agg.cacheWrite);
    case "hitRate":
      return formatHitRate(agg.hitRate, agg.turns);
    case "cost":
      return formatCost(agg.cost);
  }
}

/** Row label → columns → rendered line string */
export function formatRow(
  label: string,
  labelWidth: number,
  agg: Aggregate,
  cols: ColumnId[],
  colWidths: Record<ColumnId, number>,
): string {
  const pad = "  ";
  let line = label.padEnd(labelWidth);
  for (const c of cols) {
    const val = formatCell(c, agg);
    line += pad + val.padStart(colWidths[c] ?? 0);
  }
  return line;
}

export function pickModelDisplay(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  if (maxLen <= 3) return name.slice(0, maxLen);
  return name.slice(0, maxLen - 1) + "…";
}

export function formatDivider(cols: ColumnId[], colWidths: Record<ColumnId, number>, labelW: number): string {
  const parts = ["─".repeat(labelW)];
  for (const c of cols) {
    parts.push("─".repeat((colWidths[c] ?? 0) + 2)); // +2 for padding
  }
  return parts.join("");
}

// ─── Command registration ──────────────────────────────────────────────────

export function registerUsageCommand(pi: ExtensionAPI): void {
  pi.registerCommand("usage", {
    description: "Show token usage statistics (overall + per-model)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const currentSessionFile = (ctx.sessionManager as any).getSessionFile?.() ??
        (ctx.sessionManager as any).getSessionPath?.() ?? undefined;

      // Phase 1: loading
      const report = await ctx.ui.custom<UsageReport | null>((tui, theme, _kb, done) => {
        const container = new Container();
        const borderFn = (s: string) => theme.fg("border", s);

        container.addChild(new DynamicBorder(borderFn));
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("accent", "  Usage Statistics"), 1, 0));
        container.addChild(new Text(theme.fg("muted", "  Syncing session data..."), 1, 0));
        container.addChild(new Spacer(1));
        container.addChild(new DynamicBorder(borderFn));
        container.addChild(new Text(theme.fg("dim", "  q close"), 1, 0));

        let finished = false;
        const controller = new AbortController();

        syncUsageIndex(controller.signal)
          .then(() => {
            if (finished) return;
            finished = true;
            try {
              const entries = readUsageEntries();
              done(aggregate(entries, currentSessionFile));
            } catch {
              done(null);
            }
          })
          .catch(() => {
            if (!finished) {
              finished = true;
              done(null);
            }
          });

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            if (matchesKey(data, "escape") || data === "q") {
              if (!finished) {
                finished = true;
                controller.abort();
                done(null);
              }
            }
          },
        };
      });

      if (!report) return;

      // Phase 2: display
      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        const rebuild = async () => {
          try {
            await rebuildUsageIndex();
            const entries = readUsageEntries();
            return aggregate(entries, currentSessionFile);
          } catch {
            return null;
          }
        };
        return new UsageReportComponent(theme, report, () => tui.requestRender?.(), () => done(), rebuild);
      });
    },
  });
}
