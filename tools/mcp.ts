/**
 * MCP servers this pack contributes.
 *
 * The protocol, the connection lifecycle, tool registration and `/mcp`
 * belong to pi's built-in MCP extension. What is left here is the part pi
 * cannot know: the server definitions the pack ships. They are handed
 * over with `pi.registerMcpServer()`, which connects them next to the
 * servers from `mcp.json` — and an `mcp.json` entry of the same name takes
 * precedence over the registration.
 *
 * Registered servers are declared with `exposure: "direct"` so their tools
 * reach the model the way any other tool does. pi names them
 * `mcp__<server>__<tool>`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { resolveDependency } from "../settings.js";
import type { DependencyStatus } from "../hooks/skeleton.js";

export const CODEGRAPH_SERVER_NAME = "codegraph";

/** Command of the codegraph server — also its dependency-gate key. */
const CODEGRAPH_COMMAND = "codegraph";

/** codegraph — local code knowledge graph served by the `codegraph` CLI. */
export const CODEGRAPH_BUILTIN = {
  type: "stdio",
  command: CODEGRAPH_COMMAND,
  args: ["serve", "--mcp"],
  exposure: "direct",
} satisfies McpServerConfig;

/** codegraph indexes one project. Without `.codegraph/` there is nothing to serve. */
export function hasCodegraphIndex(cwd: string): boolean {
  try {
    return fs.statSync(path.join(cwd, ".codegraph")).isDirectory();
  } catch {
    return false;
  }
}

/** Binary commands of the builtin servers, for the dependency-path settings view. */
export function listMcpBinaryNames(): string[] {
  return [CODEGRAPH_COMMAND];
}

/**
 * Hand the pack's servers to pi's built-in MCP extension. Called once per
 * extension load; the registration itself is not persisted, and pi re-reads
 * `mcp.json` on its own each time. pi reads the registrations when a session
 * starts, so the cwd passed here is the one that decides whether codegraph is
 * offered — a session that later moves to another directory picks the current
 * answer up on the next `/reload`.
 */
export function registerBuiltinMcpServers(pi: ExtensionAPI, cwd: string): void {
  // Same gate as the dependency-gate entry below: an index without the CLI
  // registers nothing, so /mcp never lists a server that cannot start. The
  // reading of a settings path wins over PATH, and re-resolving after the CLI
  // is installed takes a `/reload` — the same rule the pre-handover client
  // followed.
  const codegraph = hasCodegraphIndex(cwd) ? resolveDependency(CODEGRAPH_COMMAND) : null;
  if (codegraph) {
    register(pi, CODEGRAPH_SERVER_NAME, { ...CODEGRAPH_BUILTIN, command: codegraph });
  }
}

/**
 * `registerMcpServer` throws for a config it rejects and for a name another
 * extension registered. That throw would happen while this extension loads,
 * and pi drops an extension whose factory throws — one rejected registration
 * would take every tool, hook and command in the pack with it. A clash is
 * visible in `/mcp`, which lists the server that won the name.
 */
function register(pi: ExtensionAPI, name: string, config: McpServerConfig): void {
  try {
    pi.registerMcpServer(name, config);
  } catch {
    /* /mcp reports the servers that are actually in effect */
  }
}

/**
 * Dependency-gate entries for the builtin servers. codegraph needs its CLI,
 * and only in a project that has an index — the same condition that registers
 * it.
 */
export function collectBuiltinMcpDependencyStatuses(cwd: string): DependencyStatus[] {
  if (!hasCodegraphIndex(cwd)) return [];
  const resolved = resolveDependency(CODEGRAPH_COMMAND);
  return [
    {
      module: `mcp:${CODEGRAPH_SERVER_NAME}`,
      label: CODEGRAPH_COMMAND,
      state: resolved ? "ok" : "missing",
      detail: "Install the codegraph CLI, or set its path with /dp-settings.",
      path: resolved ?? undefined,
    },
  ];
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Moves the `mcpServers` entries out of a legacy file into the file pi reads.
 * Entries already present in the target win, and a corrupt target file is left
 * untouched.
 */
function moveServerEntries(legacyPath: string, newPath: string): void {
  let legacy: Record<string, any> | null = null;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
  } catch {
    return;
  }
  if (!isPlainObject(legacy)) return;
  const legacyServers = legacy.mcpServers ?? legacy["mcp-servers"];
  if (!isPlainObject(legacyServers)) return;
  if (Object.keys(legacyServers).length === 0) return;

  let newConfig: Record<string, any> = { mcpServers: {} };
  if (fs.existsSync(newPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(newPath, "utf-8"));
      if (!isPlainObject(parsed)) return;
      newConfig = parsed;
      if (!isPlainObject(newConfig.mcpServers)) newConfig.mcpServers = {};
    } catch {
      return;
    }
  }

  for (const [name, entry] of Object.entries(legacyServers)) {
    if (!(name in newConfig.mcpServers)) newConfig.mcpServers[name] = entry;
  }

  // A read-only project directory must not take the extension down: pi drops
  // an extension whose factory throws. The legacy file is left in place when
  // the write fails, so the migration runs again on the next load.
  try {
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.writeFileSync(newPath, JSON.stringify(newConfig, null, 2) + "\n", "utf-8");

    delete legacy.mcpServers;
    delete legacy["mcp-servers"];
    fs.writeFileSync(legacyPath, JSON.stringify(legacy, null, 2) + "\n", "utf-8");
  } catch {
    /* Nothing to migrate to — a server list pi cannot read is a server list
       the user still has, one `/reload` away from a writable directory. */
  }
}

/**
 * Global servers of versions before the dedicated file: they lived in the
 * pack's own `decorated-pi.json`. pi reads `mcp.json`, so the entries move
 * there once — both files are in the agent dir, so this cannot collide with
 * the project migration below.
 */
export function migrateLegacyGlobalMcpConfig(): void {
  const agentDir = getAgentDir();
  moveServerEntries(path.join(agentDir, "decorated-pi.json"), path.join(agentDir, "mcp.json"));
}

/**
 * Project servers: pi's built-in MCP extension reads `<cwd>/.pi/mcp.json`,
 * versions of this pack before the handover read `<cwd>/.pi/agent/mcp.json`.
 *
 * Launched from the home directory — or with the agent dir pointed inside the
 * project — `<cwd>/.pi/agent/mcp.json` *is* pi's global `mcp.json`. Moving its
 * entries into a project file would hide them from every other directory and
 * the key removal below would delete them, so the migration stops there.
 */
export function migrateProjectMcpConfig(cwd: string): void {
  const legacyPath = path.join(cwd, ".pi/agent/mcp.json");
  if (path.resolve(legacyPath) === path.resolve(getAgentDir(), "mcp.json")) return;
  moveServerEntries(legacyPath, path.join(cwd, ".pi/mcp.json"));
}
