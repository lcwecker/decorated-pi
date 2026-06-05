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
import {
    findSystemRtk,
    getRtkDependencyStatuses,
    setupRtkIntegration,
    type DependencyStatus,
} from "./rtk";
import { isModuleEnabled, isCodegraphModuleEnabled } from "./settings";

function collectDependencyStatuses(cwd: string): DependencyStatus[] {
    const statuses: DependencyStatus[] = [];
    if (isModuleEnabled("rtk")) statuses.push(...getRtkDependencyStatuses());
    if (isModuleEnabled("smart-at"))
        statuses.push(...getSmartAtDependencyStatuses(cwd));
    if (isModuleEnabled("lsp"))
        statuses.push(...collectLspDependencyStatuses(cwd));
    if (isModuleEnabled("mcp"))
        statuses.push(...collectMcpDependencyStatuses(cwd));
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

/**
 * True when the codegraph guidance should be injected into the system
 * prompt. Mirrors the MCP broker's gating (`computeCodegraphEnabled` in
 * `mcp/builtin.ts`): once the user enables the codegraph module via
 * /dp-settings, the server is registered and the 8 `codegraph_*` tools
 * become available. We do NOT probe for `.codegraph/codegraph.db` — the
 * project may or may not have run `codegraph init` yet; if it hasn't,
 * the tools will error at call time and the guidance tells the LLM to
 * ask the user to run `codegraph init -i` in their terminal.
 */
export function isCodegraphActive(): boolean {
    return isCodegraphModuleEnabled();
}

function setupGuidance(pi: ExtensionAPI) {
    pi.on("before_agent_start", async (event) => {
        // Remove "Current date: YYYY-MM-DD" from system prompt to improve cache stability
        let prompt = event.systemPrompt.replace(
            /\nCurrent date: \d{4}-\d{2}-\d{2}/,
            "",
        );

        if (!prompt.includes(DECORATED_PI_GUIDANCE_MARKER)) {
            const sections: string[] = [
                DECORATED_PI_GUIDANCE_MARKER,
                "",
                "### Workflow",
                "- Before acting on a prompt: 1. ensure you fully understand the user's intent — if ambiguous, ask clarifying questions; 2. have researched the existing state — read files, search, investigate. Proceed only when both are clear.",
                "- Exercise caution when performing any **write** operations, especially when you are in a research or exploration phase.",
                "- Before modifying code, match the user's existing code style (naming, formatting, patterns). Do not re-modify lines the user has manually edited since your last change.",
                "",
                "### Context Loading",
                "- You don't need to read **AGENTS.md** or **CLAUDE.md** files unless you're explicitly asked to, these files will loaded automatically if necessary.",
                "",
                "### Filesystem Safety",
                "- CAUTION: Do not perform write operations in the following directories unless explicitly instructed: `node_modules`, `venv`, `env`, `__pycache__`, `.git` or any other hidden directories.",
                "",
                "### Secret Masking",
                "- When you see masked secret values (e.g. `sk-***...***` where `*`, `#`, or `?` are mask characters), the real value has been redacted by the system. Do not attempt to read or guess it. If you need the secret, use tools like `jq` or `grep` to extract it from the original source file.",
            ];

            // Only inject the CodeGraph guidance when the module is
            // enabled in /dp-settings. We deliberately do NOT claim
            // `.codegraph/` exists — that probe was removed because
            // dp-settings is the single source of truth and we want a
            // stable prompt prefix for cache reuse. If a tool returns
            // "project not initialized", the LLM should tell the user
            // to run `codegraph init -i` in their terminal.
            if (isCodegraphActive()) {
                sections.push(
                    "",
                    "### CodeGraph",
                    "- This project's `codegraph_*` MCP tools are enabled (via /dp-settings). Prefer them over grep/glob/Read for code structure questions:",
                    "  • `codegraph_explore` — first call for \"how does X work\" / architecture / survey questions",
                    "  • `codegraph_impact` — before refactoring or deleting code",
                    "  • `codegraph_callers` / `codegraph_callees` — trace call flow up/down",
                    "  • `codegraph_search` — find symbols by name (FTS5 full-text)",
                    "  • `codegraph_node` — get a single symbol's full source",
                    "- Treat returned source as already read; do not re-open shown files. The graph is pre-built — grep is just repeating work it already did.",
                    "- If a tool reports the project isn't initialized, ask the user to run `codegraph init -i` in their terminal; the tools will work once the index is built.",
                );
            }

            prompt = `${prompt}\n\n${sections.join("\n")}`;
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
    const sortedToolNames = Object.keys(opts.toolSnippets ?? {}).sort((a, b) =>
        a.localeCompare(b),
    );
    const sortedToolSnippets: Record<string, string> = {};
    for (const name of sortedToolNames) {
        sortedToolSnippets[name] = opts.toolSnippets![name];
    }
    opts.toolSnippets = sortedToolSnippets;
    if (opts.selectedTools) {
        opts.selectedTools = sortedToolNames;
    }
    if (opts.promptGuidelines) {
        opts.promptGuidelines = [...opts.promptGuidelines].sort((a, b) =>
            a.localeCompare(b),
        );
    }
    if (opts.skills) {
        opts.skills = [...opts.skills].sort((a, b) =>
            a.name.localeCompare(b.name),
        );
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
