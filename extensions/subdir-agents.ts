/**
 * Subdir Agents — 动态加载子目录的 AGENTS.md
 *
 * 当 agent 读取或编辑子目录中的文件时，自动发现该目录及父目录中的 AGENTS.md/CLAUDE.md，
 * 将其内容注入到 tool result 中。
 *
 * 状态通过 pi.appendEntry() 持久化到 session JSONL 文件中，resume / reload 时恢复。
 * compaction 视为上下文边界：仅恢复当前 branch 上最后一个 compaction 之后的已加载状态。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, resolve, relative, join, normalize } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const CUSTOM_TYPE = "decorated-pi.subdir-agents";
const AGENTS_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

interface SessionLikeEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

const discovered = new Set<string>();
const pendingPaths = new Map<string, string>();
let sessionCwd = process.cwd();

function normalizeAbsPath(cwd: string, p: string): string {
  return normalize(resolve(cwd, p));
}

function lastCompactionIndex(entries: SessionLikeEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "compaction") return i;
  }
  return -1;
}

function restoreFromBranch(ctx: { cwd: string; sessionManager: { getBranch: () => Array<SessionLikeEntry> } }) {
  discovered.clear();
  const branch = ctx.sessionManager.getBranch();
  const start = lastCompactionIndex(branch) + 1;
  for (const entry of branch.slice(start)) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
    const paths = entry.data as string[] | undefined;
    if (!Array.isArray(paths)) continue;
    for (const p of paths) {
      if (typeof p === "string" && p.trim()) {
        discovered.add(normalizeAbsPath(ctx.cwd, p));
      }
    }
  }
}

function findNewAgents(filePath: string, cwd: string): Array<{ path: string; content: string }> {
  const resolvedCwd = resolve(cwd);
  let dir = dirname(resolve(cwd, filePath));
  const results: Array<{ path: string; content: string }> = [];

  while (true) {
    const rel = relative(resolvedCwd, dir);
    if (rel === "" || rel.startsWith("..")) break;

    for (const name of AGENTS_NAMES) {
      const agentsPath = normalize(join(dir, name));
      if (existsSync(agentsPath) && !discovered.has(agentsPath)) {
        try {
          const content = readFileSync(agentsPath, "utf-8");
          discovered.add(agentsPath);
          results.push({
            path: relative(cwd, agentsPath),
            content,
          });
        } catch {
          // ignore
        }
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return results.reverse();
}

export const __subdirAgentsTest = {
  restoreFromBranch,
  findNewAgents,
};

export function setupSubdirAgents(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    sessionCwd = ctx.cwd;
    restoreFromBranch(ctx);
  });

  pi.on("session_compact", () => {
    discovered.clear();
    pendingPaths.clear();
  });

  pi.on("tool_call", (event) => {
    if (event.toolName === "read" || event.toolName === "edit") {
      const path = (event.input as { path?: string }).path;
      if (path) {
        pendingPaths.set(event.toolCallId, path);
      }
    }
  });

  pi.on("tool_result", (event, ctx) => {
    const path = pendingPaths.get(event.toolCallId);
    pendingPaths.delete(event.toolCallId);

    if (!path || !event.content || !Array.isArray(event.content)) {
      return;
    }

    const cwd = ctx.cwd ?? sessionCwd;
    const agents = findNewAgents(path, cwd);
    if (agents.length === 0) return;

    const injections = agents
      .map((a) => `[Directory Context: ${a.path}]\n${a.content}`)
      .join("\n\n---\n\n");

    const names = agents.map((a) => a.path).join(", ");
    const label = agents.length === 1 ? "AGENTS.md" : "AGENTS.md files";
    ctx.ui.notify(`📋 Loaded ${label}: ${names}`, "info");

    const absolutePaths = agents.map((a) => resolve(cwd, a.path));
    const relativePaths = absolutePaths.map((p) => relative(cwd, p));
    pi.appendEntry(CUSTOM_TYPE, relativePaths);

    const newContent = [...event.content];
    newContent.push({
      type: "text",
      text: `\n\n${injections}`,
    });

    return { content: newContent };
  });

  pi.on("session_shutdown", () => {
    discovered.clear();
    pendingPaths.clear();
    sessionCwd = process.cwd();
  });
}
