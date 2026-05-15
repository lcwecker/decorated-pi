import { LspServerManager } from "./server-manager.js";
import { register_lsp_tools } from "./tools.js";
import { setup_lsp_prompt } from "./prompt.js";

export function setupLsp(pi: any) {
  const manager = new LspServerManager();

  setup_lsp_prompt(pi);
  register_lsp_tools(pi, manager);

  pi.on("session_shutdown", async () => {
    await manager.clear_language_state();
  });
}
