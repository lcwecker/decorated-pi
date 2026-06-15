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
import { fileURLToPath } from "node:url";

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
import { collectLspDependencyStatuses } from "./tools/lsp/servers.js";
import { registerAskTool } from "./tools/ask/index.js";
import { resolveMcpConfigs, migrateLegacyGlobalMcpConfig, collectMcpDependencyStatuses } from "./tools/mcp/config.js";
import { ensureMcpServerReady } from "./hooks/mcp.js";

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
  "- Before acting on a prompt, do sufficient research on the existing state — read files, search, investigate — and only proceed once you have a clear picture.",
  "- Exercise caution when performing any **write** operations, especially when you are in a research or exploration phase.",
  "- Before modifying code, match the user's existing code style (naming, formatting, patterns). Do not re-modify lines the user has manually edited since your last change.",
  "",
  "### Filesystem Safety, where NOT to write",
  "- CAUTION: Do not perform write operations in the following directories unless explicitly instructed: `node_modules`, `venv`, `env`, `__pycache__`, `.git` or any other hidden directories.",
].join("\n");

/** Remove the injected Pi documentation block from the base system prompt.
 *  Matches a line containing "Pi documentation" and deletes it plus all
 *  following non-empty lines, stopping at the first blank line. */
export function stripPiDocsBlock(prompt: string): string {
  const lines = prompt.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.includes("Pi documentation")) {
      i++;
      while (i < lines.length && lines[i].trim() !== "") i++;
      // Drop the terminating blank line as well so we don't leave orphan whitespace.
      if (i < lines.length && lines[i].trim() === "") i++;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

/** Sort the <available_skills> block in the system prompt by skill name.
 *  Pi core appends extension-provided skills after user/project skills and does
 *  not sort the XML; this makes the final prompt stable and cache-friendly. */
export function sortSkillsInSystemPrompt(prompt: string): string {
  const startMarker = "\n<available_skills>";
  const endMarker = "</available_skills>";
  const startIdx = prompt.indexOf(startMarker);
  if (startIdx === -1) return prompt;
  const endIdx = prompt.indexOf(endMarker, startIdx);
  if (endIdx === -1) return prompt;

  const before = prompt.slice(0, startIdx + startMarker.length);
  const after = prompt.slice(endIdx);
  const inner = prompt.slice(startIdx + startMarker.length, endIdx);

  const chunks: string[][] = [];
  let current: string[] = [];
  for (const line of inner.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "<skill>") {
      current = [line];
    } else if (trimmed === "</skill>") {
      current.push(line);
      chunks.push(current);
      current = [];
    } else if (current.length > 0) {
      current.push(line);
    }
  }

  const nameOf = (chunk: string[]) => {
    const line = chunk.find((l) => l.trim().startsWith("<name>"));
    if (!line) return "";
    const t = line.trim();
    return t.slice(6, t.indexOf("</name>"));
  };

  chunks.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));

  const sortedInner = "\n" + chunks.map((chunk) => chunk.join("\n")).join("\n") + "\n";
  return before + sortedInner + after;
}

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
  return out;
}

function canRegisterMcpServer(config: { name: string; command?: string }, deps: Array<{ module: string; state: string }>): boolean {
  if (!config.command) return true;
  const dep = deps.find((d) => d.module === `mcp:${config.name}`);
  return dep ? dep.state === "ok" : true;
}

/** Absolute path to the plugin's builtin skills directory.
 *  Used by `resources_discover` so the skill travels with the plugin
 *  regardless of which project pi is running in. */
export function getBuiltinSkillPaths(): string[] {
  return [fileURLToPath(new URL("./skills", import.meta.url))];
}

/** Register the plugin's builtin skill paths with Pi core. */
function installBuiltinSkills(pi: ExtensionAPI): void {
  pi.on("resources_discover", async (_event: any) => ({
    skillPaths: getBuiltinSkillPaths(),
  }));
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
    let prompt: string = stripPiDocsBlock(event.systemPrompt);
    prompt = sortSkillsInSystemPrompt(prompt);
    prompt = prompt.replace(/\nCurrent date: \d{4}-\d{2}-\d{2}/, "");
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
  if (isModuleEnabled("lsp")) {
    const lspDeps = collectLspDependencyStatuses(process.cwd());
    if (lspDeps.some((d) => d.state === "ok")) {
      registerLspTools(pi, new LspServerManager());
    }
    for (const dep of lspDeps) {
      sk.declareDependency({
        label: `lsp:${dep.label}`,
        module: `lsp:${dep.label}`,
        check: () => collectLspDependencyStatuses(process.cwd()).some((s) => s.label === dep.label && s.state === "ok"),
      });
    }
  }
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
    const mcpDeps = collectMcpDependencyStatuses(process.cwd());
    for (const dep of mcpDeps) {
      sk.declareDependency({
        label: dep.module,
        module: dep.module,
        check: () => collectMcpDependencyStatuses(process.cwd()).some((s) => s.module === dep.module && s.state === "ok"),
      });
    }
    const configs = resolveMcpConfigs(process.cwd()).filter(s => s.enabled);
    // Per-server readiness: cache hit → register from cache (fast).
    // Cache miss → connect synchronously, write cache, then register
    // live tools. This blocks startup only for cache-miss servers.
    // Skip servers whose binary is missing (dependency not met).
    for (const config of configs) {
      if (!canRegisterMcpServer(config, mcpDeps)) continue;
      await ensureMcpServerReady(pi, config, process.cwd());
    }
    registerMcpStatusCommand(pi);
  }

  // ── Builtin skills (travel with the plugin in every project) ─────────────
  installBuiltinSkills(pi);

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
