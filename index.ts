/**
 * decorated-pi — entry point.
 *
 * Three categories:
 *   - tools/    : LLM-callable tools
 *   - hooks/    : event handlers (registered via skeleton)
 *   - commands/ : slash commands
 *
 * Plus:
 *   - system-prompt guidelines: hard-coded base + per-module imports,
 *     concatenated in array order, injected via pi.on("before_agent_start", ...)
 *     in `installGuidelines` below.
 *
 * Skeleton is the only place that calls pi.on(...) for hooks. Tools,
 * commands, and guideline injection register themselves directly with pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { setupProviders } from "./providers/index.js";
import { createSkeleton } from "./hooks/skeleton.js";

import { setupRedact, REDACT_GUIDANCE } from "./hooks/redact.js";
import { externalizeModule } from "./hooks/externalize.js";
import { trackMtimeModule } from "./hooks/track-mtime.js";
import { injectAgentsMdModule, INJECT_AGENTS_MD_GUIDANCE } from "./hooks/inject-agents-md.js";
import { imageVisionModule } from "./hooks/image-vision.js";
import { smartAtModule } from "./hooks/smart-at.js";
import { sessionTitleModule } from "./hooks/session-title.js";
import { piToolFilterModule } from "./hooks/pi-tool-filter.js";
import { setupCompaction } from "./hooks/compaction.js";
import { mcpModule } from "./hooks/mcp.js";
import { setupWakatime, wakatimeModule } from "./hooks/wakatime.js";
import { setupRtk } from "./hooks/rtk.js";

import { registerPatchTool } from "./tools/patch/index.js";
import { registerLspTools } from "./tools/lsp/tools.js";
import { LspServerManager } from "./tools/lsp/manager.js";
import { registerMcpToolsFromCache } from "./tools/mcp/index.js";
import { resolveMcpConfigs } from "./tools/mcp/config.js";
import { loadMcpCache } from "./tools/mcp/cache.js";
import { CODEGRAPH_GUIDANCE } from "./tools/mcp/builtin/codegraph.js";

import { registerDpModelCommand } from "./commands/dp-model.js";
import { registerDpSettingsCommand } from "./commands/dp-settings.js";
import { registerMcpStatusCommand } from "./commands/mcp-status.js";
import { registerRetryCommand } from "./commands/retry.js";

import { isModuleEnabled } from "./settings.js";

// ─── System-prompt guidelines (hard-coded base, per-module imports) ────────
//
// Array order = prompt order. Add a new module's guidance by importing
// its constant and pushing it here. No priority / sort logic — just push.

const BASE_GUIDANCE = [
  "## Decorated Pi Guidance",
  "",
  "### Workflow, how to approach tasks",
  "- Before acting on a prompt: 1. ensure you fully understand the user's intent — if ambiguous, ask clarifying questions; 2. have researched the existing state — read files, search, investigate. Proceed only when both are clear.",
  "- Exercise caution when performing any **write** operations, especially when you are in a research or exploration phase.",
  "- Before modifying code, match the user's existing code style (naming, formatting, patterns). Do not re-modify lines the user has manually edited since your last change.",
  "",
  "### Filesystem Safety, where NOT to write",
  "- CAUTION: Do not perform write operations in the following directories unless explicitly instructed: `node_modules`, `venv`, `env`, `__pycache__`, `.git` or any other hidden directories.",
].join("\n");

/** Build the list of guideline strings to inject, in prompt order.
 *  Always-on rules first, then per-module guidelines (skipping disabled
 *  modules). Add new per-module guidelines by importing the constant
 *  here and pushing it inside an `isModuleEnabled(...)` guard. */
function buildGuidelines(): string[] {
  const out: string[] = [
    BASE_GUIDANCE,
    REDACT_GUIDANCE,             // from hooks/redact.ts — always on (safety module)
    INJECT_AGENTS_MD_GUIDANCE,   // from hooks/inject-agents-md.ts — always on (smart-at module)
  ];
  if (isModuleEnabled("codegraph")) out.push(CODEGRAPH_GUIDANCE);
  return out;
}

/** Install a single before_agent_start handler that appends every
 *  guideline in order, stripping the volatile "Current date: …" line
 *  for cache stability. Idempotent — re-injection is a no-op via marker. */
function installGuidelines(pi: ExtensionAPI): void {
  const blocks = buildGuidelines();
  const joined = blocks.join("\n\n");
  const marker = "## Decorated Pi Guidance";

  pi.on("before_agent_start", async (event: any) => {
    if (!event.systemPrompt) return undefined;
    let prompt: string = event.systemPrompt.replace(/\nCurrent date: \d{4}-\d{2}-\d{2}/, "");
    if (prompt.includes(marker)) return undefined; // already injected this turn
    return { systemPrompt: `${prompt}\n\n${joined}` };
  });
}

export default function (pi: ExtensionAPI) {
  // ── Providers (always on) ──────────────────────────────────────────────
  setupProviders(pi);

  // ── Skeleton (hooks) ───────────────────────────────────────────────────
  const sk = createSkeleton();

  // Order matters for tool_result compose chain:
  //   1. redact → externalize → track-mtime → inject-agents-md → image-vision → wakatime
  // The first module registered for a given event runs first (compose chain).
  setupRedact(sk);
  sk.register(externalizeModule);
  sk.register(trackMtimeModule);
  sk.register(injectAgentsMdModule);
  sk.register(imageVisionModule);

  // session_start handlers (parallel)
  // pi-tool-filter must register first so native tools are dropped before
  // anything else inspects the tool list.
  sk.register(piToolFilterModule);
  sk.register(sessionTitleModule);
  sk.register(smartAtModule);
  sk.register(wakatimeModule);

  // Compaction + RTK (these also install their own pi.on via setup<>()).
  setupCompaction(sk);
  setupRtk(sk, pi);
  setupWakatime(sk, pi);

  // ── Tools (conditional on module switches) ────────────────────────────
  if (isModuleEnabled("patch")) registerPatchTool(pi);
  if (isModuleEnabled("lsp")) registerLspTools(pi, new LspServerManager());

  // MCP: hook AND tool are gated together. Disabling the module
  // means no session_start handler runs, no tools register, and no
  // background connections are attempted.
  if (isModuleEnabled("mcp")) {
    sk.register(mcpModule);
    const configs = resolveMcpConfigs(process.cwd()).filter(s => s.enabled);
    const cache = loadMcpCache(process.cwd());
    if (cache) registerMcpToolsFromCache(pi, cache, configs);
  }

  // ── System-prompt guidelines (single handler, array order = prompt order) ──
  installGuidelines(pi);

  // ── Commands ──────────────────────────────────────────────────────────
  registerDpModelCommand(pi);
  registerDpSettingsCommand(pi);
  registerMcpStatusCommand(pi);
  registerRetryCommand(pi);

  // ── Install skeleton (last) ────────────────────────────────────────────
  sk.install(pi);
}
