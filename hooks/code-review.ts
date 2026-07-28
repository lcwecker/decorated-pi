/** Code-review history/context lifecycle. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Module } from "./skeleton.js";
import {
  CODE_REVIEW_STATE_ENTRY,
  CODE_REVIEW_VIEW_MESSAGE,
  CodeReviewRuntime,
  type ReviewRunDetails,
} from "../tools/code-review/index.js";

/** Hide the visible review history card from LLM context. */
export function sanitizeCodeReviewContext(messages: AgentMessage[]): AgentMessage[] {
  const sanitized: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role !== "custom" || message.customType !== CODE_REVIEW_VIEW_MESSAGE) {
      sanitized.push(message);
    }
  }
  return sanitized;
}

export function createCodeReviewModule(runtime: CodeReviewRuntime): Module {
  return {
    name: "code-review",
    hooks: {
      context: [
        (event) => {
          const messages = sanitizeCodeReviewContext(event.messages);
          if (messages.length === event.messages.length && messages.every((message, i) => message === event.messages[i])) {
            return undefined;
          }
          return { ...event, messages };
        },
      ],
      session_start: [
        (_event, ctx) => {
          for (const entry of ctx.sessionManager.getEntries() as any[]) {
            if (entry.type !== "custom" || entry.customType !== CODE_REVIEW_STATE_ENTRY) continue;
            const runId = entry.data?.runId;
            const details = entry.data?.details as ReviewRunDetails | undefined;
            if (typeof runId === "string" && details) runtime.restore(runId, details);
          }
        },
      ],
      session_shutdown: [
        (_event, _ctx, pi) => {
          const ended = runtime.shutdown();
          if (ended) pi.appendEntry(CODE_REVIEW_STATE_ENTRY, ended);
        },
      ],
    },
  };
}
