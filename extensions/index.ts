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
import { setupGuidance } from "./guidance";
import { setupLsp } from "./lsp/index";
import { collectLspDependencyStatuses } from "./lsp/servers";
import { setupProviders } from "./providers/index";
import { getSmartAtDependencyStatuses, setupSmartAt } from "./smart-at";
import { setupMcp } from "./mcp/index.js";
import { collectMcpDependencyStatuses } from "./mcp/builtin";
import { setupWakatime } from "./wakatime";
import { findSystemRtk, getRtkDependencyStatuses, setupRtkIntegration, type DependencyStatus } from "./rtk-integration";
import { isModuleEnabled } from "./settings";

function collectDependencyStatuses(cwd: string): DependencyStatus[] {
  const statuses: DependencyStatus[] = [];
  if (isModuleEnabled("rtk-integration")) statuses.push(...getRtkDependencyStatuses());
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
  if (isModuleEnabled("rtk-integration") && findSystemRtk()) setupRtkIntegration(pi);
}
