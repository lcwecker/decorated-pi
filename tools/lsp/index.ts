/**
 * LSP Extension — language server integration for Pi.
 *
 * Provides: lsp_diagnostics.
 *
 * Returns the manager so `index.ts` can hand it to `hooks/lsp.ts`, which owns
 * the session_shutdown cleanup. No hook is registered here.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LspServerManager } from "./manager.js";
import { registerLspTools } from "./tools.js";

export function setupLsp(
  pi: ExtensionAPI,
  manager: LspServerManager = new LspServerManager(),
): LspServerManager {
  registerLspTools(pi, manager);
  return manager;
}
