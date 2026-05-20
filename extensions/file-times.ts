/**
 * File mtime tracking for stale-read protection.
 *
 * - `read` tool records mtime when the LLM reads a file
 * - `patch` tool checks mtime before editing — rejects if file changed since last read
 * - `patch` tool updates mtime after a successful write
 * - Markers are persisted to session custom entries and restored from the
 *   current branch after the last compaction boundary.
 */

import * as fs from "node:fs";
import * as path from "node:path";

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

/** Last-known mtime for each absolute file path (ms since epoch). */
const readMarkers = new Map<string, number>();

/** Get current file mtime in ms. Throws if file doesn't exist. */
function getFileMtime(absPath: string): number {
  const stat = fs.statSync(absPath);
  return stat.mtimeMs;
}

/** Record that the LLM has seen the current version of a file.
 *  Called after `read` tool completes and after `patch` writes. */
export function recordReadTime(absPath: string): void {
  if (!fs.existsSync(absPath)) return;
  readMarkers.set(absPath, getFileMtime(absPath));
}

/** Check if file has been modified since last read.
 *  Returns an error message if stale, or undefined if ok to edit. */
export function checkStaleFile(absPath: string, displayPath: string): string | undefined {
  // If file doesn't exist on disk, always allow — creating a new file
  // doesn't require reading it first, and recreating a deleted file is safe.
  if (!fs.existsSync(absPath)) {
    return undefined;
  }

  const lastRead = readMarkers.get(absPath);
  if (lastRead === undefined) {
    // File exists but never read — must read first to avoid blind edits
    return (
      `File not read yet: ${displayPath}. ` +
      `Please read the file with the read tool before editing.`
    );
  }

  const currentMtime = getFileMtime(absPath);
  if (currentMtime > lastRead) {
    return (
      `File modified since last read: ${displayPath}. ` +
      `Please re-read the file with the read tool before editing.`
    );
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
  return !!value
    && typeof value === "object"
    && typeof (value as any).path === "string"
    && typeof (value as any).mtimeMs === "number";
}

/** Build a session-persisted marker payload for the current file version. */
export function createFileTimeMarkerData(cwd: string, absPath: string): FileTimeMarkerData | undefined {
  if (!fs.existsSync(absPath)) return undefined;
  return {
    path: toStoredPath(cwd, absPath),
    mtimeMs: getFileMtime(absPath),
  };
}

/** Restore markers from the current branch, ignoring anything before the last compaction. */
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

/** Clear all tracked file times (e.g., on session start or compaction). */
export function clearReadMarkers(): void {
  readMarkers.clear();
}

/** Resolve a relative path to absolute (for consistent map keys). */
export function resolveAbsolutePath(cwd: string, filePath: string): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  return path.normalize(path.resolve(cwd, filePath));
}
