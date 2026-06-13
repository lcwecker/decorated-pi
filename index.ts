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

import { createSkeleton } from "./hooks/skeleton.js";

import { setupRedact, REDACT_GUIDANCE } from "./hooks/redact.js";
import { externalizeModule } from "./hooks/externalize.js";
import { normalizeCodeblocksModule } from "./hooks/normalize-codeblocks.js";
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
import { registerAskTool } from "./tools/ask/index.js";
import { resolveMcpConfigs, migrateLegacyGlobalMcpConfig } from "./tools/mcp/config.js";
import { ensureMcpServerReady } from "./hooks/mcp.js";
import { CODEGRAPH_GUIDANCE, isCodegraphGuidanceActive } from "./tools/mcp/builtin/codegraph.js";

import { registerDpModelCommand } from "./commands/dp-model.js";
import { registerDpSettingsCommand } from "./commands/dp-settings.js";
import { registerMcpStatusCommand } from "./commands/mcp-status.js";
import { registerRetryCommand } from "./commands/retry.js";
import { registerUsageCommand } from "./commands/usage.js";

import { captureModuleSnapshot, isModuleEnabled } from "./settings.js";

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
 *  Always-on rules first, then per-module guidelines. REDACT_GUIDANCE is
 *  gated by the secretRedaction module; CodeGraph guidance follows the MCP
 *  server switch chain (mcp module on → codegraph server on → guidance
 *  injected). The mcp module check lives in `resolveMcpConfigs`, so this
 *  code only needs to look at the server's own `enabled` flag. */
function buildGuidelines(): string[] {
  const out: string[] = [
    BASE_GUIDANCE,
    INJECT_AGENTS_MD_GUIDANCE,   // from hooks/inject-agents-md.ts — always on
  ];
  if (isModuleEnabled("secretRedaction")) out.push(REDACT_GUIDANCE);
  if (isCodegraphGuidanceActive(process.cwd())) out.push(CODEGRAPH_GUIDANCE);
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

export default async function (pi: ExtensionAPI) {
  // Snapshot the module settings that pi is about to load. /dp-settings
  // compares against this to avoid prompting for reload when the user
  // has only returned the settings to the currently-loaded state.
  captureModuleSnapshot();

  // ── Skeleton (hooks) ───────────────────────────────────────────────────
  const sk = createSkeleton();

  // Order matters for tool_result compose chain:
  //   1. redact → normalize-codeblocks → externalize → track-mtime → inject-agents-md → image-vision → wakatime
  // The first module registered for a given event runs first (compose chain).
  if (isModuleEnabled("secretRedaction")) setupRedact(sk);
  sk.register(normalizeCodeblocksModule);
  sk.register(externalizeModule);
  sk.register(trackMtimeModule);
  sk.register(injectAgentsMdModule);
  sk.register(imageVisionModule);

  // session_start handlers (parallel)
  // pi-tool-filter must register first so native tools are dropped before
  // anything else inspects the tool list.
  sk.register(piToolFilterModule);
  sk.register(sessionTitleModule);
  if (isModuleEnabled("atOverride")) sk.register(smartAtModule);
  if (isModuleEnabled("wakatime")) sk.register(wakatimeModule);

  // Compaction + RTK (these also install their own pi.on via setup<>()).
  setupCompaction(sk);
  if (isModuleEnabled("rtk")) setupRtk(sk, pi);
  if (isModuleEnabled("wakatime")) setupWakatime(sk, pi);

  // ── Tools (conditional on module switches) ────────────────────────────
  if (isModuleEnabled("patchOverrideEdit")) registerPatchTool(pi);
  if (isModuleEnabled("lsp")) registerLspTools(pi, new LspServerManager());
  if (isModuleEnabled("ask")) registerAskTool(pi);

  // MCP: hook, tools, and /mcp command are gated together. Disabling the
  // module means no session_start handler runs, no tools register, no
  // /mcp command is available, and no background connections are attempted.
  if (isModuleEnabled("mcp")) {
    // One-time migration: legacy global MCP configs in
    // ~/.pi/agent/decorated-pi.json move to ~/.pi/agent/mcp.json. Run
    // explicitly here so `loadGlobalMcpConfigs` stays pure.
    migrateLegacyGlobalMcpConfig();
    sk.register(mcpModule);
    const configs = resolveMcpConfigs(process.cwd()).filter(s => s.enabled);
    // Per-server readiness: cache hit → register from cache (fast).
    // Cache miss → connect synchronously, write cache, then register
    // live tools. This blocks startup only for cache-miss servers.
    for (const config of configs) {
      await ensureMcpServerReady(pi, config, process.cwd());
    }
    registerMcpStatusCommand(pi);
  }

  // ── System-prompt guidelines (single handler, array order = prompt order) ──
  installGuidelines(pi);

  // ── Commands ──────────────────────────────────────────────────────────
  registerDpModelCommand(pi);
  registerDpSettingsCommand(pi);
  if (isModuleEnabled("retry")) registerRetryCommand(pi);
  if (isModuleEnabled("usage")) registerUsageCommand(pi);

  // ── Install skeleton (last) ────────────────────────────────────────────
  sk.install(pi);
}
