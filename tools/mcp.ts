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

/** Server names this pack has shipped: codegraph, and context7 up to 0.11.0. */
const PACK_SERVER_NAMES = [CODEGRAPH_SERVER_NAME, "context7"];

/**
 * Reads a JSON object. An absent file reads as an empty object; one that holds
 * anything else reports `null`, which leaves the caller nothing to write.
 */
function readJsonObject(filePath: string): Record<string, any> | null {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whether a server entry is a leftover on/off flag rather than a server pi can
 * run.
 *
 * Versions before the handover remembered the state of their builtin servers by
 * writing `{"<name>": {"enabled": true}}` — `toggleMcpServerEnabled` targeted
 * `~/.pi/agent/mcp.json` for the global scope, the file its own reader used,
 * and `.pi/agent/mcp.json` for the project scope. pi reads the former as its
 * global config now and answers such an entry with `needs either "command"
 * (stdio) or "url" (streamable HTTP)` on every start, while the flag says
 * nothing it can act on: the servers are registrations from the extension API.
 */
function isLeftoverEnabledFlag(name: string, entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const keys = Object.keys(entry);
  if (keys.length > 0 && keys.every((key) => key === "enabled") && typeof entry.enabled === "boolean") {
    return true;
  }
  // The names this pack ships go even when the entry carries more than the
  // flag: the builtin is the pack's to hand over, and an entry pi cannot run
  // under one of those names is a leftover by definition.
  const transportless = typeof entry.command !== "string" && typeof entry.url !== "string";
  return transportless && PACK_SERVER_NAMES.includes(name);
}

/**
 * Moves the `mcpServers` entries out of a legacy file into the file pi reads,
 * dropping the leftover flags either file still carries. Entries already
 * present in the target win, and a corrupt target file is left untouched.
 */
function moveServerEntries(legacyPath: string, newPath: string): void {
  const legacy = readJsonObject(legacyPath);
  const newConfig = readJsonObject(newPath);
  if (newConfig === null) return;

  const legacyServers: unknown = legacy ? (legacy.mcpServers ?? legacy["mcp-servers"]) : undefined;
  const hadLegacy = isPlainObject(legacyServers) && Object.keys(legacyServers).length > 0;

  const existing = newConfig.mcpServers;
  const servers: Record<string, any> = isPlainObject(existing) ? existing : {};
  newConfig.mcpServers = servers;
  let changed = false;

  for (const name of Object.keys(servers)) {
    if (!isLeftoverEnabledFlag(name, servers[name])) continue;
    delete servers[name];
    changed = true;
  }

  if (isPlainObject(legacyServers)) {
    for (const [name, entry] of Object.entries(legacyServers)) {
      if (name in servers) continue;
      if (isLeftoverEnabledFlag(name, entry)) continue;
      servers[name] = entry;
      changed = true;
    }
  }

  if (!changed && !hadLegacy) return;

  // A read-only project directory must not take the extension down: pi drops
  // an extension whose factory throws. The legacy file is left in place when
  // the write fails, so the migration runs again on the next load.
  try {
    if (changed) {
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      fs.writeFileSync(newPath, JSON.stringify(newConfig, null, 2) + "\n", "utf-8");
    }

    if (hadLegacy && legacy) {
      delete legacy.mcpServers;
      delete legacy["mcp-servers"];
      fs.writeFileSync(legacyPath, JSON.stringify(legacy, null, 2) + "\n", "utf-8");
    }
  } catch {
    /* Nothing to migrate to — a server list pi cannot read is a server list
       the user still has, one `/reload` away from a writable directory. */
  }
}

/**
 * Global servers of versions before the dedicated file: they lived in the
 * pack's own `decorated-pi.json`, and its own `mcp.json` reader pointed at
 * `~/.pi/agent/mcp.json` all along. pi reads `mcp.json`, so the real entries
 * move there once — both files are in the agent dir, so this cannot collide
 * with the project migration below — and the enabled flags versions before the
 * handover kept in either file are dropped: pi validates that file now and
 * warns about an entry it cannot run.
 */
export function migrateLegacyGlobalMcpConfig(): void {
  const agentDir = getAgentDir();
  moveServerEntries(path.join(agentDir, "decorated-pi.json"), path.join(agentDir, "mcp.json"));
}

/**
 * Project servers: pi's built-in MCP extension reads `<cwd>/.pi/mcp.json`,
 * versions of this pack before the handover read `<cwd>/.pi/agent/mcp.json`.
 *
 * The legacy path is where the pre-handover toggle wrote, so it carries the
 * same enabled flags the global migration drops.
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
