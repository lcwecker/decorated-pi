/**
 * inject-agents-md — when read/edit is called, scan parent dirs for AGENTS.md/CLAUDE.md
 * and inject their content into the tool result so the LLM sees the relevant context.
 *
 * State is persisted to session via pi.appendEntry so it survives resume/reload.
 */

import { dirname, resolve, relative, join, normalize } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Module } from "./skeleton.js";

const CUSTOM_TYPE = "decorated-pi.subdir-agents";
const AGENTS_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

interface SessionLikeEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

const discovered = new Set<string>();
const pendingPaths = new Map<string, string>();
let lastCwd = "";

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
          results.push({ path: relative(cwd, agentsPath), content });
        } catch { /* ignore */ }
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return results.reverse();
}

export const __subdirAgentsTest = { restoreFromBranch, findNewAgents };

export const injectAgentsMdModule: Module = {
  name: "inject-agents-md",
  hooks: {
    session_start: [
      (_event, ctx) => {
        lastCwd = ctx.cwd;
        restoreFromBranch({ cwd: ctx.cwd, sessionManager: ctx.sessionManager as any });
      },
    ],
    session_compact: [
      () => {
        discovered.clear();
        pendingPaths.clear();
      },
    ],
    tool_call: [
      (event) => {
        if (event.toolName !== "read" && event.toolName !== "edit") return;
        const path = (event.input as { path?: string })?.path;
        if (path) pendingPaths.set(event.toolCallId, path);
      },
    ],
    tool_result: [
      (event, ctx, pi) => {
        const path = pendingPaths.get(event.toolCallId);
        pendingPaths.delete(event.toolCallId);
        if (!path || !event.content || !Array.isArray(event.content)) return;
        const cwd = ctx.cwd ?? lastCwd;
        const agents = findNewAgents(path, cwd);
        if (agents.length === 0) return;

        const injections = agents
          .map((a) => `[Directory Context: ${a.path}]\n${a.content}`)
          .join("\n\n---\n\n");
        const names = agents.map((a) => a.path).join(", ");
        const label = agents.length === 1 ? "AGENTS.md" : "AGENTS.md files";
        if (ctx.hasUI) ctx.ui.notify(`📋 Loaded ${label}: ${names}`, "info");

        const relativePaths = agents.map((a) => resolve(cwd, a.path)).map((p) => relative(cwd, p));
        pi.appendEntry(CUSTOM_TYPE, relativePaths);

        const newContent = [...event.content];
        newContent.push({ type: "text", text: `\n\n${injections}` });
        return { ...event, content: newContent };
      },
    ],
    session_shutdown: [
      () => {
        discovered.clear();
        pendingPaths.clear();
        lastCwd = "";
      },
    ],
  },
};

/**
 * System-prompt guidance for the inject-agents-md hook — tells the
 * LLM not to waste tool calls re-reading AGENTS.md / CLAUDE.md, since
 * this hook already auto-injects them.
 */
export const INJECT_AGENTS_MD_GUIDANCE = [
  "### Context Loading, AGENTS.md / CLAUDE.md are auto-injected",
  "- You don't need to read **AGENTS.md** or **CLAUDE.md** files unless you're explicitly asked to, these files will loaded automatically if necessary.",
].join("\n");
