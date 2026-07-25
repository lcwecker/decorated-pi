/**
 * track-mtime — file mtime tracking for stale-read protection.
 *
 * - `read` tool records mtime when the LLM reads a file
 * - `patch` tool checks mtime before editing — rejects if file changed since last read
 * - `patch` tool updates mtime after a successful write
 *
 * Markers are persisted via pi.appendEntry and restored from the current branch
 * after the last compaction boundary.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Module, Skeleton } from "./skeleton.js";

export const FILE_TIMES_CUSTOM_TYPE = "decorated-pi.file-times";

export interface FileTimeMarkerData {
  path: string;
  mtimeMs: number;
}

interface SessionLikeEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

/** Owning tracker for read-time markers. One instance per extension load,
 *  so reloads and parallel sessions cannot share or leak markers. */
export class FileTimeTracker {
  private readonly readMarkers = new Map<string, number>();

  clear(): void {
    this.readMarkers.clear();
  }

  record(absPath: string): void {
    if (!fs.existsSync(absPath)) return;
    this.readMarkers.set(absPath, fs.statSync(absPath).mtimeMs);
  }

  check(absPath: string, displayPath: string): string | undefined {
    if (!fs.existsSync(absPath)) return undefined;
    const lastRead = this.readMarkers.get(absPath);
    if (lastRead === undefined) {
      return `Please read the file with the read tool before editing. File not read yet: ${displayPath}.`;
    }
    const currentMtime = fs.statSync(absPath).mtimeMs;
    if (currentMtime > lastRead) {
      return `Please re-read the file with the read tool before editing. File modified since last read: ${displayPath}.`;
    }
    return undefined;
  }

  restore(entries: SessionLikeEntry[], cwd: string): void {
    this.clear();
    const start = lastCompactionIndex(entries) + 1;
    for (const entry of entries.slice(start)) {
      if (entry.type !== "custom" || entry.customType !== FILE_TIMES_CUSTOM_TYPE) continue;
      if (!isFileTimeMarkerData(entry.data)) continue;
      const absPath = resolveAbsolutePath(cwd, entry.data.path);
      this.readMarkers.set(absPath, entry.data.mtimeMs);
    }
  }

  toMarker(cwd: string, absPath: string): FileTimeMarkerData | undefined {
    if (!fs.existsSync(absPath)) return undefined;
    return { path: toStoredPath(cwd, absPath), mtimeMs: fs.statSync(absPath).mtimeMs };
  }
}

function getFileMtime(absPath: string): number {
  return fs.statSync(absPath).mtimeMs;
}

// ─── Pure helpers (kept module-level — no state) ────────────────────────────

function toStoredPath(cwd: string, absPath: string): string {
  const normalizedCwd = path.normalize(cwd);
  const normalizedAbs = path.normalize(absPath);
  const rel = path.relative(normalizedCwd, normalizedAbs);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  return normalizedAbs;
}

function lastCompactionIndex(entries: SessionLikeEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "compaction") return i;
  }
  return -1;
}

function isFileTimeMarkerData(value: unknown): value is FileTimeMarkerData {
  return !!value && typeof value === "object"
    && typeof (value as any).path === "string"
    && typeof (value as any).mtimeMs === "number";
}

export function resolveAbsolutePath(cwd: string, filePath: string): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  return path.normalize(path.resolve(cwd, filePath));
}

// Re-export for tests / external consumers that still build markers directly.
export function createFileTimeMarkerData(cwd: string, absPath: string): FileTimeMarkerData | undefined {
  if (!fs.existsSync(absPath)) return undefined;
  return { path: toStoredPath(cwd, absPath), mtimeMs: getFileMtime(absPath) };
}

// ─── Module ───────────────────────────────────────────────────────────────

const READ_WRITE_EDIT_PATCH = new Set(["read", "write", "edit", "patch"]);

export function createTrackMtimeModule(tracker: FileTimeTracker): Module {
  return {
    name: "track-mtime",
    hooks: {
      session_start: [
        (_event, ctx) => {
          tracker.restore(ctx.sessionManager.getBranch() as SessionLikeEntry[], ctx.cwd);
        },
      ],
      session_compact: [
        () => tracker.clear(),
      ],
      session_shutdown: [
        () => tracker.clear(),
      ],
      tool_call: [
        (event, ctx) => {
          if (event.toolName !== "patch") return;
          const filePath = (event.input as any)?.path;
          if (typeof filePath !== "string" || !filePath.trim()) return;
          const cwd: string = ctx.cwd ?? process.cwd();
          const reason = tracker.check(resolveAbsolutePath(cwd, filePath), filePath);
          if (reason) return { block: true, reason };
        },
      ],
      tool_result: [
        (event, ctx, pi) => {
          if (!READ_WRITE_EDIT_PATCH.has(event.toolName)) return;
          const filePath = (event.input as any)?.path;
          if (typeof filePath !== "string" || !filePath.trim()) return;
          // For read: always record. For write/edit/patch: only on success.
          if (event.toolName !== "read" && event.isError) return;
          const cwd: string = ctx.cwd ?? process.cwd();
          const absPath = resolveAbsolutePath(cwd, filePath);
          tracker.record(absPath);
          const marker = tracker.toMarker(cwd, absPath);
          if (marker) pi.appendEntry(FILE_TIMES_CUSTOM_TYPE, marker);
        },
      ],
    },
  };
}

export function setupTrackMtime(sk: Skeleton): void {
  sk.register(createTrackMtimeModule(new FileTimeTracker()));
}
