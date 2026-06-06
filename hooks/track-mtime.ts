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

const readMarkers = new Map<string, number>();

function getFileMtime(absPath: string): number {
  return fs.statSync(absPath).mtimeMs;
}

export function recordReadTime(absPath: string): void {
  if (!fs.existsSync(absPath)) return;
  readMarkers.set(absPath, getFileMtime(absPath));
}

export function checkStaleFile(absPath: string, displayPath: string): string | undefined {
  if (!fs.existsSync(absPath)) return undefined;
  const lastRead = readMarkers.get(absPath);
  if (lastRead === undefined) {
    return `Please read the file with the read tool before editing. File not read yet: ${displayPath}.`;
  }
  const currentMtime = getFileMtime(absPath);
  if (currentMtime > lastRead) {
    return `Please re-read the file with the read tool before editing. File modified since last read: ${displayPath}.`;
  }
  return undefined;
}

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

export function createFileTimeMarkerData(cwd: string, absPath: string): FileTimeMarkerData | undefined {
  if (!fs.existsSync(absPath)) return undefined;
  return { path: toStoredPath(cwd, absPath), mtimeMs: getFileMtime(absPath) };
}

export function restoreReadMarkersFromBranch(entries: SessionLikeEntry[], cwd: string): void {
  clearReadMarkers();
  const start = lastCompactionIndex(entries) + 1;
  for (const entry of entries.slice(start)) {
    if (entry.type !== "custom" || entry.customType !== FILE_TIMES_CUSTOM_TYPE) continue;
    if (!isFileTimeMarkerData(entry.data)) continue;
    const absPath = resolveAbsolutePath(cwd, entry.data.path);
    readMarkers.set(absPath, entry.data.mtimeMs);
  }
}

export function clearReadMarkers(): void {
  readMarkers.clear();
}

export function resolveAbsolutePath(cwd: string, filePath: string): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  return path.normalize(path.resolve(cwd, filePath));
}

const READ_WRITE_EDIT_PATCH = new Set(["read", "write", "edit", "patch"]);

export const trackMtimeModule: Module = {
  name: "track-mtime",
  hooks: {
    session_compact: [
      () => clearReadMarkers(),
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
        recordReadTime(absPath);
        const marker = createFileTimeMarkerData(cwd, absPath);
        if (marker) pi.appendEntry(FILE_TIMES_CUSTOM_TYPE, marker);
      },
    ],
  },
};

export function setupTrackMtime(sk: Skeleton): void {
  sk.register(trackMtimeModule);
}
