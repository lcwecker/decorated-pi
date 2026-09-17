/**
 * /retry — continue after interruption.
 *
 * The in-flight guard is reset on `agent_start` by hooks/retry.ts; this
 * command only creates the state object and returns it for index.ts to wire.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRetryState, type RetryState } from "../hooks/retry.js";

export function registerRetryCommand(pi: ExtensionAPI): RetryState {
  const state = createRetryState();
  pi.registerCommand("retry", {
    description: "Continue after interruption",
    handler: async (_args, ctx) => {
      if (state.inProgress) { ctx.ui.notify("Retry is already in progress", "warning"); return; }
      if (!ctx.isIdle()) ctx.abort();
      state.inProgress = true;
      pi.sendMessage({ customType: "retry-trigger", content: "Continue.", display: false }, { triggerTurn: true });
    },
  });
  return state;
}
