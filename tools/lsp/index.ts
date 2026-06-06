/**
 * LSP Extension — language server integration for Pi.
 *
 * Provides: lsp_diagnostics, lsp_document_symbols.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LspServerManager } from "./manager.js";
import { registerLspTools } from "./tools.js";

export function setupLsp(pi: ExtensionAPI) {
  const manager = new LspServerManager();
  registerLspTools(pi, manager);

  pi.on("session_shutdown", async () => {
    await manager.clearLanguageState();
  });
}
