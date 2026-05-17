/**
 * File mtime tracking for stale-read protection.
 *
 * - `read` tool records mtime when the LLM reads a file
 * - `patch` tool checks mtime before editing — rejects if file changed since last read
 * - `patch` tool updates mtime after a successful write
 */

import * as fs from "node:fs";
import * as path from "node:path";

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

/** Clear all tracked file times (e.g., on session start). */
export function clearReadMarkers(): void {
  readMarkers.clear();
}

/** Resolve a relative path to absolute (for consistent map keys). */
export function resolveAbsolutePath(cwd: string, filePath: string): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  return path.normalize(path.resolve(cwd, filePath));
}