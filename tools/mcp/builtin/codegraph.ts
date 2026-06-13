/**
 * codegraph builtin MCP server — config + project artefact check.
 *
 * Enabled state is controlled like any other MCP server: through the
 * MCP config (global `~/.pi/agent/mcp.json` under `mcpServers`, or
 * project `.pi/agent/mcp.json`) or via the `/mcp` command. There is no
 * separate /dp-settings toggle; codegraph is just one MCP server.
 */
import * as fs from "node:fs";
import * as path from "node:path";
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
