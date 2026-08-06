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
import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { createSkeleton } from "./hooks/skeleton.js";

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
import { setupRtk } from "./hooks/rtk.js";
import { createCodeReviewModule } from "./hooks/code-review.js";

import { registerPatchTool } from "./tools/patch/index.js";
import { registerLspTools } from "./tools/lsp/tools.js";
import { LspServerManager } from "./tools/lsp/manager.js";
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

    const sortedInner =
        "\n" + chunks.map((chunk) => chunk.join("\n")).join("\n") + "\n";
    return before + sortedInner + after;
}

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

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

interface PiPackageResolveOptions {
    env?: Record<string, string | undefined>;
    entrypoint?: string;
    commandPath?: string;
    executablePath?: string;
    isBunBinary?: boolean;
}

function isPiPackageDir(dir: string): boolean {
    try {
        const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
            name?: string;
        };
        return manifest.name === PI_PACKAGE_NAME;
    } catch {
        return false;
    }
}

function findPiPackageFromPath(startPath: string | undefined): string | undefined {
    if (!startPath || !existsSync(startPath)) return undefined;

    let current: string;
    try {
        const realPath = realpathSync(startPath);
        current = statSync(realPath).isDirectory() ? realPath : dirname(realPath);
    } catch {
        return undefined;
    }

    while (true) {
        if (isPiPackageDir(current)) return current;
        const parent = dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

function findPiCommand(env: Record<string, string | undefined>): string | undefined {
    const pathValue = env.PATH;
    if (!pathValue) return undefined;
    const names = process.platform === "win32"
        ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => `pi${ext.toLowerCase()}`)
        : ["pi"];

    for (const dir of pathValue.split(delimiter)) {
        if (!dir) continue;
        for (const name of names) {
            const candidate = resolve(dir, name);
            if (existsSync(candidate)) return candidate;
        }
    }
    return undefined;
}

/** Resolve the package root of the Pi instance hosting this extension. */
export function resolveActivePiPackageDir(
    options: PiPackageResolveOptions = {},
): string | undefined {
    const env = options.env ?? process.env;
    const override = env.PI_PACKAGE_DIR;
    if (override) {
        const resolvedOverride = findPiPackageFromPath(override);
        if (resolvedOverride) return resolvedOverride;
    }

    const fromEntrypoint = findPiPackageFromPath(options.entrypoint ?? process.argv[1]);
    if (fromEntrypoint) return fromEntrypoint;

    const fromCommand = findPiPackageFromPath(options.commandPath ?? findPiCommand(env));
    if (fromCommand) return fromCommand;

    const isBunBinary = options.isBunBinary ?? Boolean((process.versions as any).bun);
    if (isBunBinary) {
        try {
            return dirname(realpathSync(options.executablePath ?? process.execPath));
        } catch {
            return undefined;
        }
    }
    return undefined;
}

export function buildPiDocsSkill(piPackageDir: string): string {
    return [
        "---",
        "name: pi-docs",
        "description: pi docs resources",
        "---",
        "",
        "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
        `- Main documentation: \`${join(piPackageDir, "README.md")}\``,
        `- Additional docs: \`${join(piPackageDir, "docs")}\``,
        `- Examples: \`${join(piPackageDir, "examples")}\` (extensions, custom tools, SDK)`,
        "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)",
        "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
        "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
        "",
    ].join("\n");
}

/** Write the builtin pi-docs skill with paths for the active Pi installation. */
export function getBuiltinSkillPaths(piPackageDir: string): string[] {
    const generatedRoot = join(tmpdir(), "decorated-pi", String(process.pid), "skills");
    const generatedSkillDir = join(generatedRoot, "pi-docs");
    mkdirSync(generatedSkillDir, { recursive: true });
    writeFileSync(join(generatedSkillDir, "SKILL.md"), buildPiDocsSkill(piPackageDir), "utf-8");
    return [generatedRoot];
}

/** Register the plugin's builtin skill paths with Pi core. */
function installBuiltinSkills(pi: ExtensionAPI): void {
    const piPackageDir = resolveActivePiPackageDir();
    pi.on("resources_discover", async (_event: any) => ({
        skillPaths: piPackageDir ? getBuiltinSkillPaths(piPackageDir) : [],
    }));
}

/** Install a single before_agent_start handler that appends every
 *  guideline in order. Idempotent — re-injection is a no-op via marker. */
function installGuidelines(pi: ExtensionAPI): void {
    const blocks = buildGuidelines();
    const joined = blocks.join("\n\n");
    const marker = "## Decorated Pi Guidance";

    pi.on("before_agent_start", async (event: any) => {
        if (!event.systemPrompt) return undefined;
        let prompt: string = stripPiDocsBlock(event.systemPrompt);
        prompt = sortSkillsInSystemPrompt(prompt);
        if (prompt.includes(marker)) return undefined; // already injected this turn
        return { systemPrompt: `${prompt}\n\n${joined}` };
    });
}

export default async function (pi: ExtensionAPI) {
    const codeReviewRuntime = new CodeReviewRuntime();

    // Snapshot the module settings that pi is about to load. /dp-settings
    // compares against this to avoid prompting for reload when the user
    // has only returned the settings to the currently-loaded state.
    captureModuleSnapshot();

    // ── Skeleton (hooks) ───────────────────────────────────────────────────
    const sk = createSkeleton();

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
    if (isModuleEnabled("rtk")) setupRtk(sk);
    if (isModuleEnabled("wakatime")) setupWakatime(sk);

    // Code review is command-driven and never registered as an LLM-callable tool.
    registerCodeReviewRenderer(pi, codeReviewRuntime);

    // ── Tools (conditional on module switches) ────────────────────────────
    if (isModuleEnabled("patchOverrideEdit")) registerPatchTool(pi);
    if (isModuleEnabled("lsp")) {
        const lspDeps = collectLspDependencyStatuses(process.cwd());
        registerLspTools(pi, new LspServerManager());
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

    // ── Builtin skills (travel with the plugin in every project) ─────────────
    installBuiltinSkills(pi);

    // ── System-prompt guidelines (single handler, array order = prompt order) ──
    installGuidelines(pi);

    // ── Commands ──────────────────────────────────────────────────────────
    registerDpModelCommand(pi);
    registerDpSettingsCommand(pi);
    if (isModuleEnabled("retry")) registerRetryCommand(pi);
    if (isModuleEnabled("usage")) registerUsageCommand(pi);
    registerCodeReviewCommand(pi, codeReviewRuntime);

    // ── Install skeleton (last) ────────────────────────────────────────────
    sk.install(pi);
}
