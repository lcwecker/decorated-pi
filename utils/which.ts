/**
 * Locate a binary by name. Pure Node — no shell required.
 *
 * Why no shell: the previous implementation called `bash -c "command -v X"`,
 * which depended on `command` being a builtin in the user's shell. That's
 * true for bash/zsh/sh/ash/dash, but not for nushell/fish/pwsh — so a user
 * with `SHELL=/usr/bin/nu` saw the whole extension fail to start with
 * "External command failed" errors from the `command` builtin lookup.
 *
 * Walking $PATH with fs.accessSync(X_OK) is universal:
 *   - No shell dependency
 *   - No builtin dependency
 *   - Works on minimal Linux (alpine, busybox, distroless)
 *   - Works regardless of $SHELL
 *   - No execFileSync overhead per call
 *
 * `extendPath` lets callers inject extra search locations (user-configured
 * override paths, module-specific fallback dirs like ~/.wakatime, project
 * node_modules/.bin). Each entry can be a file path (checked directly) or
 * a directory (searched for `name` inside). extendPath entries are tried
 * before $PATH, so callers control priority by ordering.
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

export interface WhichOptions {
  /** Extra locations to search before $PATH. Each entry can be a file
   *  path (e.g. "/custom/bin/rtk") or a directory (e.g. "~/.wakatime").
   *  Tried in array order; first executable match wins. */
  extendPath?: string[];
}

export function which(name: string, opts?: WhichOptions): string | null {
  if (!name) return null;

  // Absolute or relative path in name: check the file directly.
  if (name.includes("/") || name.includes("\\")) {
    try {
      accessSync(name, constants.X_OK);
      return resolve(name);
    } catch {
      return null;
    }
  }

  if (process.platform === "win32") {
    // Windows: `where` is a built-in command that handles PATHEXT
    // (the per-user list of executable extensions — typically
    // .COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSC;.MSC;.PS1) and PATH lookup.
    // We don't replicate that in pure Node; we defer to it.
    try {
      const out = execFileSync("where", [name], { encoding: "utf-8" }).trim();
      return out.split(/\r?\n/)[0] || null;
    } catch {
      return null;
    }
  }

  // Build the search list: extendPath entries first, then $PATH dirs.
  // extendPath entries can be files (checked directly) or directories
  // (searched for `name` inside). We stat each to tell them apart.
  const home = homedir();
  const expandHome = (d: string): string => {
    if (d === "~") return home;
    if (d.startsWith("~/") || d.startsWith("~\\")) return home + d.slice(1);
    return d;
  };

  const tryCandidate = (candidate: string): string | null => {
    try {
      accessSync(candidate, constants.X_OK);
      return resolve(candidate);
    } catch {
      return null;
    }
  };

  // 1. extendPath (caller-injected): override paths + module fallbacks.
  for (const entry of opts?.extendPath ?? []) {
    const expanded = expandHome(entry);
    let isDir = false;
    try {
      isDir = statSync(expanded).isDirectory();
    } catch {
      // Doesn't exist or not accessible — skip.
      continue;
    }
    const candidate = isDir ? resolve(expanded, name) : expanded;
    const found = tryCandidate(candidate);
    if (found) return found;
  }

  // 2. $PATH walk — mirrors the standard `which(1)` command's behavior:
  // exact match in each directory, no recursion.
  //
  // `~` expansion: bash expands `~/bin` when sourced from .bashrc via
  // `export PATH=~/bin:$PATH`, but not when PATH is set in launchd,
  // systemd Environment=, Docker ENV, or GUI app launchers. We expand
  // it here so we don't regress on those paths.
  const dirs = (process.env.PATH || "").split(delimiter).map(expandHome);
  for (const dir of dirs) {
    if (!dir) continue;
    const found = tryCandidate(resolve(dir, name));
    if (found) return found;
  }
  return null;
}
