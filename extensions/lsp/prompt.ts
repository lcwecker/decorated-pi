/**
 * LSP System Prompt — injects LSP guidance into agent system prompt
 *
 * Based on @spences10/pi-lsp by Scott Spence
 * https://github.com/spences10/my-pi/tree/main/packages/pi-lsp (MIT License)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { list_supported_languages } from "./servers.js";

export const LSP_TOOL_NAMES = new Set([
  "lsp_diagnostics",
  "lsp_find_symbol",
  "lsp_hover",
  "lsp_definition",
  "lsp_references",
  "lsp_document_symbols",
  "lsp_rename",
]);

const LSP_GUIDANCE_MARKER = "### LSP Guidance";

export function setup_lsp_prompt(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    if (!should_inject_lsp_prompt(event.systemPromptOptions)) return;
    if (event.systemPrompt.includes(LSP_GUIDANCE_MARKER)) return;

    const languages = list_supported_languages().join(", ");
    const guidance = [
      LSP_GUIDANCE_MARKER,
      "",
      `Consider using LSP tools when reading or editing source files. Supported languages: ${languages}. Use them when debugging language-server-supported errors, checking types, symbol definitions or API documentation from code, finding references more precisely than text search, and renaming symbols across a project.`,
    ].join("\n");

    return {
      systemPrompt: `${event.systemPrompt}\n\n${guidance}`,
    };
  });
}

export function should_inject_lsp_prompt(options?: {
  selectedTools?: string[];
}): boolean {
  const tools = options?.selectedTools;
  return !tools || tools.some((tool) => LSP_TOOL_NAMES.has(tool));
}
