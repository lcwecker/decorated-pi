/**
 * LSP Child Process Environment — restricted env for LSP server processes
 *
 * Based on @spences10/pi-lsp by Scott Spence
 * https://github.com/spences10/my-pi/tree/main/packages/pi-lsp (MIT License)
 */
import { create_child_process_env as create_shared_child_process_env } from "@spences10/pi-child-env";

export function create_child_process_env(
  explicit_env: Record<string, string> = {},
  source_env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return create_shared_child_process_env({
    profile: "lsp",
    explicit_env,
    source_env,
  });
}
