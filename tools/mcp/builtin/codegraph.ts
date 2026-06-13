/**
 * codegraph builtin MCP server — config + system-prompt guidance.
 *
 * Enabled state is controlled like any other MCP server: through the
 * MCP config (global `~/.pi/agent/mcp.json` under `mcpServers`, or
 * project `.pi/agent/mcp.json`) or via the `/mcp` command. There is no
 * separate /dp-settings toggle; codegraph is just one MCP server.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveMcpConfigs } from "../config.js";
import type { McpServerConfig } from "../config.js";

export const CODEGRAPH_BUILTIN: Omit<McpServerConfig, "source"> = {
    name: "codegraph",
    command: "codegraph",
    args: ["serve", "--mcp"],
    enabled: false,
    description:
        "Local code knowledge graph (colbymchenry/codegraph). Enable via /mcp.",
    canUseInProject: (cwd: string) => fs.existsSync(path.join(cwd, ".codegraph")),
};

/** True when codegraph is enabled in the resolved MCP config AND the
 *  current project has a .codegraph/ index. Use this to decide whether
 *  to inject CodeGraph system-prompt guidance. */
export function isCodegraphGuidanceActive(cwd: string): boolean {
    const cfg = resolveMcpConfigs(cwd).find((s) => s.name === "codegraph");
    if (!cfg?.enabled) return false;
    if (cfg.canUseInProject && !cfg.canUseInProject(cwd)) return false;
    return true;
}

export const CODEGRAPH_GUIDANCE = [
    "### CodeGraph, code source map",
    "- This project's `codegraph_*` MCP tools are enabled. The graph is a pre-built index; grep/glob/Read of source code is repeating work the index already did.",
    "",
    "#### When to reach for it",
    '- Starting any task that touches code → `codegraph_explore("how does X work")` or `codegraph_files`',
    "- Looking for where a symbol is defined → `codegraph_search <name>`",
    "- Reading a function's body → `codegraph_node <name>` (or `codegraph_explore`)",
    "- Tracing call flow → `codegraph_callers` / `codegraph_callees`",
    "- Assessing refactor risk → `codegraph_impact <name>`",
    "",
    "#### Do NOT do this",
    "- `ls`, `find`, `grep -rn`, `rg` to discover symbols → use `codegraph_search`",
    "- `read` of an entire file to find a function → use `codegraph_explore` first",
    '- Reading 3+ files to understand a module → use `codegraph_explore("how does X work")`',
    "- `bash` with `cat`, `head`, `sed` to view source → use `codegraph_node` or `read` (single file only)",
    "",
    "#### If it errors",
    '- "Project not initialized" → ask the user to run `codegraph init -i` in their terminal',
    "- Empty results → fall back to grep/Read (the index is best-effort, not authoritative)",
    "- Tool timeout → `codegraph_status` to check; if indexer is dead, fall back",
].join("\n");
