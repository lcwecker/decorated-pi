/**
 * lsp — session lifecycle for the LSP tools.
 *
 * The manager holds live language-server state; this module disposes it on
 * `session_shutdown`. The tool surface is registered by `tools/lsp/index.ts`,
 * which returns the same manager instance this module owns.
 */

import type { LspServerManager } from "../tools/lsp/manager.js";
import type { Module } from "./skeleton.js";

export function createLspModule(manager: LspServerManager): Module {
  return {
    name: "lsp",
    hooks: {
      session_shutdown: [
        async () => {
          await manager.clearLanguageState();
        },
      ],
    },
  };
}
