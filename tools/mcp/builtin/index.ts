/**
 * Builtin MCP servers — aggregate. Each server has its own file; this
 * module re-exports them and the all-server list.
 *
 * Web search is not here: it is the native `websearch` tool
 * (tools/websearch/), which speaks JSON-RPC to the hosted endpoints directly
 * and therefore needs no server entry, no cached schema and no connection
 * lifecycle.
 */
import type { McpServerConfig } from "../config.js";
import { CONTEXT7_BUILTIN } from "./context7.js";
import { CODEGRAPH_BUILTIN } from "./codegraph.js";

export { CONTEXT7_BUILTIN } from "./context7.js";
export { CODEGRAPH_BUILTIN } from "./codegraph.js";

/** All builtin servers — flat list for `resolveMcpConfigs` to merge. */
export const BUILTIN_MCP_SERVERS: Omit<McpServerConfig, "source">[] = [
  CONTEXT7_BUILTIN,
  CODEGRAPH_BUILTIN,
];
