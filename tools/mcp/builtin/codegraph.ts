/**
 * codegraph builtin MCP server — config + system-prompt guidance.
 *
 * Injected by `index.ts` → `buildGuidelines()` when the codegraph
 * module is enabled (see `isModuleEnabled("codegraph")` in settings).
 */
import type { McpServerConfig } from "../config.js";
import { isCodegraphModuleEnabled } from "../../../settings.js";

export const CODEGRAPH_BUILTIN: Omit<McpServerConfig, "source"> = {
    name: "codegraph",
    command: "codegraph",
    args: ["serve", "--mcp"],
    enabled: false, // overridden by isCodegraphModuleEnabled() at resolve time
    description:
        "Local code knowledge graph (colbymchenry/codegraph). Enable via /dp-settings.",
};

/** Predicate for `resolveMcpConfigs` to gate the codegraph server. */
export function codegraphEnabled(): boolean {
    return isCodegraphModuleEnabled();
}

export const CODEGRAPH_GUIDANCE = [
    "### CodeGraph, code source map (USE FIRST, not \"prefer\")",
    "- This project's `codegraph_*` MCP tools are enabled. The graph is a pre-built index; grep/glob/Read of source code is repeating work the index already did.",
    "",
    "#### When to reach for it (FIRST tool call, not last resort)",
    "- Starting any task that touches code → `codegraph_explore(\"how does X work\")` or `codegraph_files`",
    "- Looking for where a symbol is defined → `codegraph_search <name>`",
    "- Reading a function's body → `codegraph_node <name>` (or `codegraph_explore`)",
    "- Tracing call flow → `codegraph_callers` / `codegraph_callees`",
    "- Assessing refactor risk → `codegraph_impact <name>`",
    "",
    "#### Do NOT do this",
    "- `ls`, `find`, `grep -rn`, `rg` to discover symbols → use `codegraph_search`",
    "- `read` of an entire file to find a function → use `codegraph_explore` first",
    "- Reading 3+ files to understand a module → use `codegraph_explore(\"how does X work\")`",
    "- `bash` with `cat`, `head`, `sed` to view source → use `codegraph_node` or `read` (single file only)",
    "",
    "#### If it errors",
    "- \"Project not initialized\" → ask the user to run `codegraph init -i` in their terminal",
    "- Empty results → fall back to grep/Read (the index is best-effort, not authoritative)",
    "- Tool timeout → `codegraph_status` to check; if indexer is dead, fall back",
].join("\n");
