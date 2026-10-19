/**
 * retry — agent-loop side of the /retry command.
 *
 * The in-flight guard is reset on two events. `agent_start` covers the run the
 * command started. `agent_settled` covers the corner where no run follows: pi
 * counts as busy while a run starts (1.2+), so `/retry` pressed in that window
 * aborts a run that has not begun and queues its message into it — if the
 * message goes down with the abort, no `agent_start` ever comes and the guard
 * would stay set, rejecting every later `/retry`. `agent_settled` fires only
 * once pi will not continue on its own.
 *
 * These resets live here so the command stays out of the agent loop:
 * `commands/retry.ts` creates the state object and `index.ts` hands it to this
 * module.
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
      agent_settled: [
        () => {
          state.inProgress = false;
        },
      ],
    },
  };
}
