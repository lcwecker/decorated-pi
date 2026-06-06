/**
 * /retry — continue after interruption.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerRetryCommand(pi: ExtensionAPI): void {
  let retryInProgress = false;
  pi.registerCommand("retry", {
    description: "Continue after interruption",
    handler: async (_args, ctx) => {
      if (retryInProgress) { ctx.ui.notify("Retry is already in progress", "warning"); return; }
      if (!ctx.isIdle()) ctx.abort();
      retryInProgress = true;
      pi.sendMessage({ customType: "retry-trigger", content: "Continue.", display: false }, { triggerTurn: true });
    },
  });
  pi.on("agent_start", () => { retryInProgress = false; });
}
