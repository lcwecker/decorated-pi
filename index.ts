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
 *     concatenated in array order and handed to the pi-docs module
 *     (hooks/pi-docs.ts), which appends them on every turn.
 *
 * The skeleton (hooks/skeleton.ts) is the only place that calls pi.on(...).
 * Everything else registers with pi directly (tools, commands).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createSkeleton } from "./hooks/skeleton.js";
import { createPiDocsModule } from "./hooks/pi-docs.js";

import { externalizeModule } from "./hooks/externalize.js";
import { normalizeCodeblocksModule } from "./hooks/normalize-codeblocks.js";
import { thinkingLabelStripModule } from "./hooks/thinking-label-strip.js";
import { FileTimeTracker, createTrackMtimeModule } from "./hooks/track-mtime.js";
import {
    createInjectAgentsMdModule,
    INJECT_AGENTS_MD_GUIDANCE,
} from "./hooks/inject-agents-md.js";
import { createImageVisionModule } from "./hooks/image-vision.js";
import { sessionTitleModule } from "./hooks/session-title.js";
import { piToolFilterModule } from "./hooks/pi-tool-filter.js";
import { setupCompaction } from "./hooks/compaction.js";
import { McpRuntime, createMcpModule } from "./hooks/mcp.js";
import { setupWakatime } from "./hooks/wakatime.js";
import { createCodeReviewModule } from "./hooks/code-review.js";
import { createLspModule } from "./hooks/lsp.js";
import { createRetryModule } from "./hooks/retry.js";

import { registerPatchTool } from "./tools/patch/index.js";
import { setupLsp } from "./tools/lsp/index.js";
import { collectLspDependencyStatuses } from "./tools/lsp/servers.js";
import { registerAskTool } from "./tools/ask/index.js";
import { CodeReviewRuntime, registerCodeReviewRenderer } from "./tools/code-review/index.js";
import {
    resolveMcpConfigs,
    migrateLegacyGlobalMcpConfig,
    collectMcpDependencyStatuses,
} from "./tools/mcp/config.js";

import { registerDpModelCommand } from "./commands/dp-model.js";
import { registerDpSettingsCommand } from "./commands/dp-settings.js";
import { registerMcpStatusCommand } from "./commands/mcp-status.js";
import { registerRetryCommand } from "./commands/retry.js";
import { registerUsageCommand } from "./commands/usage.js";
import { registerCodeReviewCommand } from "./commands/code-review.js";

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

// Adapted from hexiecs/talk-normal (MIT), prompt.md v0.6.2.
const TALK_NORMAL_GUIDANCE = [
    "## Your talking style",
    "",
    "- Be direct and informative. No filler, no fluff, but give enough to be useful.",
    "- Your single hardest constraint: prefer direct positive claims. Do not use negation-based contrastive phrasing in any language or position — neither `不是X，而是Y` (reject then correct) nor `X，而不是Y` (correct then reject). If a negative adverb sets up or follows a positive claim, restructure and state only the positive.",
    "  - BAD: 真正的创新者不是\"有创意的人\"，而是五种特质同时拉满的人 → GOOD: 真正的创新者是五种特质同时拉满的人",
    "  - BAD: It's not about intelligence, it's about taste → GOOD: Taste is what matters",
    "- Lead with the answer, then add context only if it genuinely helps.",
    "- Negation ban applies in any position: chained (`不是A，不是B，而是C`), symmetric (`适合X，不适合Y`), with or without an explicit `but / 而`. Name genuine distinctions as parallel positive clauses. Narrow exception: technical statements about necessary/sufficient conditions in logic, math, or formal proofs.",
    "- Kill filler: `I'd be happy to`, `Great question`, `It's worth noting`, `Certainly`, `Of course`, `Let me break this down`, `首先我们需要`, `值得注意的是`, `综上所述`, `让我们一起来看看`.",
    "- Never restate the question.",
    "- Yes/no questions: answer first, then give one sentence of reasoning.",
    "- Comparisons: give a recommendation with brief reasoning, not a balanced essay.",
    "- Code: give the code plus a usage example when non-trivial. Skip preambles like `Certainly! Here is...`.",
    "- Explanations: 3-5 sentences max for conceptual questions. Cover the essence, not every subtopic; if the user wants more, they will ask.",
    "- Use bullets or numbered lists only when the content has real parallel or sequential structure. No decorative structure.",
    "- Match depth to complexity: simple question = short answer, complex question = structured but still tight.",
    "- Do not end with conditional follow-up offers or next-step menus (`If you want, I can...`, `如果你愿意，我还可以...`, `如果你说X，我就Y`, `我下一步可以...`); take the real next step or name it directly.",
    "- Do not restate the same point in `plain language` / `翻成人话` / `in other words` after explaining it. Say it once, clearly.",
    "- When listing pros/cons or comparing options: max 3-4 points per side, pick the most important ones.",
    "- End with a concrete recommendation or next step when relevant. No summary-stamp closings: `In summary`, `Hope this helps`, `Feel free to ask`, `一句话总结`, `一句话落地`, `总结一下`, `简而言之`, `总而言之`, or any `一句话X：` / `X一下：` variant. State the final claim directly.",
].join("\n");

/** Build the list of guideline strings to inject, in prompt order. */
function buildGuidelines(): string[] {
    return [
        BASE_GUIDANCE,
        TALK_NORMAL_GUIDANCE,
        INJECT_AGENTS_MD_GUIDANCE, // from hooks/inject-agents-md.ts — always on
    ];
}

function canRegisterMcpServer(
    config: { name: string; command?: string },
    deps: Array<{ module: string; state: string }>,
): boolean {
    if (!config.command) return true;
    const dep = deps.find((d) => d.module === `mcp:${config.name}`);
    return dep ? dep.state === "ok" : true;
}

export default async function (pi: ExtensionAPI) {
    const codeReviewRuntime = new CodeReviewRuntime();

    // Snapshot the module settings that pi is about to load. /dp-settings
    // compares against this to avoid prompting for reload when the user
    // has only returned the settings to the currently-loaded state.
    captureModuleSnapshot();

    // ── Skeleton (hooks) ───────────────────────────────────────────────────
    const sk = createSkeleton();

    // First in the before_agent_start chain: the pi-docs module strips Pi's
    // documentation block, syncs the builtin skill, sorts the skills block,
    // and appends the system-prompt guidelines.
    sk.register(createPiDocsModule(buildGuidelines().join("\n\n")));

    // Order matters for tool_result compose chain:
    //   1. normalize-codeblocks → externalize → track-mtime → inject-agents-md → image-vision → wakatime
    // The first module registered for a given event runs first (compose chain).
    sk.register(normalizeCodeblocksModule);
    sk.register(thinkingLabelStripModule);
    sk.register(externalizeModule);
    sk.register(createTrackMtimeModule(new FileTimeTracker()));
    sk.register(createInjectAgentsMdModule());
    sk.register(createImageVisionModule());

    // session_start handlers (parallel)
    // pi-tool-filter must register first so native tools are dropped before
    // anything else inspects the tool list.
    sk.register(piToolFilterModule);
    sk.register(createCodeReviewModule(codeReviewRuntime));
    sk.register(sessionTitleModule);
    // Compaction + optional integrations.
    setupCompaction(sk);
    if (isModuleEnabled("wakatime")) setupWakatime(sk);

    // Code review is command-driven and never registered as an LLM-callable tool.
    registerCodeReviewRenderer(pi, codeReviewRuntime);

    // ── Tools (conditional on module switches) ────────────────────────────
    if (isModuleEnabled("patchOverrideEdit")) registerPatchTool(pi);
    if (isModuleEnabled("lsp")) {
        const lspDeps = collectLspDependencyStatuses(process.cwd());
        // Tool surface + session lifecycle: setupLsp returns the manager that
        // hooks/lsp.ts disposes on session_shutdown.
        sk.register(createLspModule(setupLsp(pi)));
        for (const dep of lspDeps) {
            if (dep.state !== "ok") {
                sk.declareMissing({
                    name: dep.label,
                    module: "lsp",
                    hint: dep.detail,
                });
            }
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
        const mcpRuntime = new McpRuntime();
        sk.register(createMcpModule(mcpRuntime));
        const mcpDeps = collectMcpDependencyStatuses(process.cwd());
        for (const dep of mcpDeps) {
            if (dep.state !== "ok") {
                sk.declareMissing({
                    name: dep.label, // binary name (e.g. "codegraph")
                    module: "mcp",
                    hint: dep.detail,
                });
            }
        }
        const configs = resolveMcpConfigs(process.cwd()).filter(
            (s) => s.enabled,
        );
        // Per-server readiness: cache hit → register from cache (fast).
        // Cache miss → connect synchronously, write cache, then register
        // live tools. This blocks startup only for cache-miss servers.
        // Skip servers whose binary is missing (dependency not met).
        for (const config of configs) {
            if (!canRegisterMcpServer(config, mcpDeps)) continue;
            await mcpRuntime.ensureServerReady(pi, config, process.cwd());
        }
        registerMcpStatusCommand(pi, mcpRuntime);
    }

    // ── Commands ──────────────────────────────────────────────────────────
    registerDpModelCommand(pi);
    registerDpSettingsCommand(pi);
    if (isModuleEnabled("retry")) {
        // /retry creates its in-flight guard; hooks/retry.ts owns the reset.
        sk.register(createRetryModule(registerRetryCommand(pi)));
    }
    if (isModuleEnabled("usage")) registerUsageCommand(pi);
    registerCodeReviewCommand(pi, codeReviewRuntime);

    // ── Install skeleton (last) ────────────────────────────────────────────
    sk.install(pi);
}
