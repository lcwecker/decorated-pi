/**
 * Builtin MCP servers — aggregate. Each server has its own file; this
 * module re-exports them and the all-server list.
 */
import type { McpServerConfig } from "../config.js";
import { CONTEXT7_BUILTIN } from "./context7.js";
import { EXA_BUILTIN } from "./exa.js";
import { CODEGRAPH_BUILTIN, CODEGRAPH_GUIDANCE } from "./codegraph.js";

export { CONTEXT7_BUILTIN } from "./context7.js";
export { EXA_BUILTIN } from "./exa.js";
export { CODEGRAPH_BUILTIN, CODEGRAPH_GUIDANCE, codegraphEnabled } from "./codegraph.js";

/** All builtin servers — flat list for `resolveMcpConfigs` to merge. */
export const BUILTIN_MCP_SERVERS: Omit<McpServerConfig, "source">[] = [
  CONTEXT7_BUILTIN,
  EXA_BUILTIN,
  CODEGRAPH_BUILTIN,
];
