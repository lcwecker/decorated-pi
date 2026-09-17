/**
 * retry — agent-loop side of the /retry command.
 *
 * The in-flight guard is reset on `agent_start`. That reset lives here so the
 * command stays out of the agent loop: `commands/retry.ts` creates the state
 * object and `index.ts` hands it to this module.
 */

import type { Module } from "./skeleton.js";

export interface RetryState {
  inProgress: boolean;
}

export function createRetryState(): RetryState {
  return { inProgress: false };
}

export function createRetryModule(state: RetryState): Module {
  return {
    name: "retry",
    hooks: {
      agent_start: [
        () => {
          state.inProgress = false;
        },
      ],
    },
  };
}
