/**
 * decorated-pi — Essential utilities for pi
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { setupSafety } from "./safety/index.js";
import { setupModelIntegration } from "./model-integration";
import { setupSlash } from "./slash";
import { setupSubdirAgents } from "./subdir-agents";
import { setupSessionTitle } from "./session-title";
import { setupIO } from "./io";
import { setupLsp } from "./lsp/index";
import { collectLspDependencyStatuses } from "./lsp/servers";
import { setupProviders } from "./providers/index";
import { getSmartAtDependencyStatuses, setupSmartAt } from "./smart-at";
import { setupMcp } from "./mcp/index.js";
import { collectMcpDependencyStatuses } from "./mcp/builtin";
import { setupWakatime } from "./wakatime";
import { findSystemRtk, getRtkDependencyStatuses, setupRtkIntegration, type DependencyStatus } from "./rtk";
import { isModuleEnabled } from "./settings";

function collectDependencyStatuses(cwd: string): DependencyStatus[] {
  const statuses: DependencyStatus[] = [];
  if (isModuleEnabled("rtk")) statuses.push(...getRtkDependencyStatuses());
  if (isModuleEnabled("smart-at")) statuses.push(...getSmartAtDependencyStatuses(cwd));
  if (isModuleEnabled("lsp")) statuses.push(...collectLspDependencyStatuses(cwd));
  if (isModuleEnabled("mcp")) statuses.push(...collectMcpDependencyStatuses(cwd));
  return statuses;
}

function formatDependencyLines(statuses: DependencyStatus[]): string[] {
  const missing = statuses.filter((item) => item.state === "missing");
  const grouped = new Map<string, string[]>();

  for (const item of missing) {
    const labels = grouped.get(item.module) ?? [];
    labels.push(item.label);
    grouped.set(item.module, labels);
  }

  const lines = ["[decorated-pi] missing dependencies:"];
  for (const [module, labels] of grouped) {
    lines.push(`  [${module}] ${labels.join(", ")}`);
  }
  return lines;
}

function setupDependencyReminders(pi: ExtensionAPI) {
  let notifyTimer: ReturnType<typeof setTimeout> | undefined;

  pi.on("session_start", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (event.reason !== "startup" && event.reason !== "reload") return;

    const statuses = collectDependencyStatuses(ctx.cwd);
    const missing = statuses.filter((item) => item.state === "missing");
    if (missing.length === 0) return;

    if (notifyTimer) clearTimeout(notifyTimer);
    const message = formatDependencyLines(statuses).join("\n");

    // Defer until after pi finishes startup/reload UI rebuild, otherwise
    // notify() is appended to the chat and then wiped by rebuildChatFromMessages().
    notifyTimer = setTimeout(() => {
      notifyTimer = undefined;
      try {
        ctx.ui.notify(message, "info");
      } catch {
        // Extension context may be stale if another reload/session switch happened.
      }
    }, 0);
  });

  pi.on("session_shutdown", async () => {
    if (!notifyTimer) return;
    clearTimeout(notifyTimer);
    notifyTimer = undefined;
  });
}

const DECORATED_PI_GUIDANCE_MARKER = "## Decorated Pi Guidance";

function setupGuidance(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    // Remove "Current date: YYYY-MM-DD" from system prompt to improve cache stability
    let prompt = event.systemPrompt.replace(/\nCurrent date: \d{4}-\d{2}-\d{2}/, "");

    if (!prompt.includes(DECORATED_PI_GUIDANCE_MARKER)) {
      const guidance = [
        DECORATED_PI_GUIDANCE_MARKER,
        "",
        "- Before acting on a user's prompt, ensure you fully understand their needs. If the intent is ambiguous, ask clarifying questions. Proceed only when the intent is clear.",
        "- Look before you leap! Ensure you have conducted thorough research before taking any action.",
        "- Exercise caution when performing any **write** operations, especially when you are in a research or exploration phase.",
        "- You don't need to read **AGENTS.md** or **CLAUDE.md** files unless you're explicitly asked to, these files will loaded automatically if neccessary.",
        "- CAUTION: Do not perform write operations in the following directories unless explicitly instructed: `node_modules`, `venv`, `env`, `__pycache__`, `.git` or any other hidden directories.",
        "",
        "### Secret Redaction",
        "",
        "- When you see masked secret values (e.g. `sk-***...***` where `*`, `#`, or `?` are mask characters), the real value has been redacted by the system. Do not attempt to read or guess it. If you need the secret, use tools like `jq` or `grep` to extract it from the original source file.",
      ].join("\n");

      prompt = `${prompt}\n\n${guidance}`;
    }

    sortSystemPromptOptions(event.systemPromptOptions);
    return { systemPrompt: prompt };
  });
}

/** Sort all fields in systemPromptOptions alphabetically for stable system prompt. */
export function sortSystemPromptOptions(opts: {
  toolSnippets?: Record<string, string>;
  selectedTools?: string[];
  promptGuidelines?: string[];
  skills?: Array<{ name: string; description: string; filePath: string }>;
}) {
  const sortedToolNames = Object.keys(opts.toolSnippets ?? {}).sort((a, b) => a.localeCompare(b));
  const sortedToolSnippets: Record<string, string> = {};
  for (const name of sortedToolNames) {
    sortedToolSnippets[name] = opts.toolSnippets![name];
  }
  opts.toolSnippets = sortedToolSnippets;
  if (opts.selectedTools) {
    opts.selectedTools = sortedToolNames;
  }
  if (opts.promptGuidelines) {
    opts.promptGuidelines = [...opts.promptGuidelines].sort((a, b) => a.localeCompare(b));
  }
  if (opts.skills) {
    opts.skills = [...opts.skills].sort((a, b) => a.name.localeCompare(b.name));
  }
}

export default function (pi: ExtensionAPI) {
  // Always loaded — core commands and providers
  setupSlash(pi);
  setupProviders(pi);
  setupModelIntegration(pi);
  setupSubdirAgents(pi);
  setupSessionTitle(pi);
  setupGuidance(pi);
  setupDependencyReminders(pi);

  // Configurable modules
  if (isModuleEnabled("patch")) setupIO(pi);
  if (isModuleEnabled("safety")) setupSafety(pi);
  if (isModuleEnabled("lsp")) setupLsp(pi);
  if (isModuleEnabled("smart-at")) setupSmartAt(pi);
  if (isModuleEnabled("mcp")) setupMcp(pi);
  if (isModuleEnabled("wakatime")) setupWakatime(pi);
  if (isModuleEnabled("rtk") && findSystemRtk()) setupRtkIntegration(pi);
}