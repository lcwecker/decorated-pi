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
  description: "Local code knowledge graph (colbymchenry/codegraph). Enable via /dp-settings.",
};

/** Predicate for `resolveMcpConfigs` to gate the codegraph server. */
export function codegraphEnabled(): boolean {
  return isCodegraphModuleEnabled();
}

export const CODEGRAPH_GUIDANCE = [
  "### CodeGraph, code source map (pre-built, prefer over grep)",
  "- This project's `codegraph_*` MCP tools are enabled (via /dp-settings). Prefer them over grep/glob/Read for code structure questions:",
  "  - `codegraph_explore` — first call for \"how does X work\" / architecture / survey questions",
  "  - `codegraph_impact` — before refactoring or deleting code",
  "  - `codegraph_callers` / `codegraph_callees` — trace call flow up/down",
  "  - `codegraph_search` — find symbols by name (FTS5 full-text)",
  "  - `codegraph_node` — get a single symbol's full source",
  "- Treat returned source as already read; do not re-open shown files. The graph is pre-built — grep is just repeating work it already did.",
  "- If a tool reports the project isn't initialized, ask the user to run `codegraph init -i` in their terminal; the tools will work once the index is built.",
].join("\n");
