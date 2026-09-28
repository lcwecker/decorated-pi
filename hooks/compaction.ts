/**
 * compaction — custom compaction model.
 *
 * On `session_before_compact`, summarizes the context with the model
 * configured in settings (rather than the agent's current model) and returns
 * the result so pi uses our summary instead of running its default. The
 * summarization request goes through pi's model runtime
 * (`ctx.modelRegistry.complete`), which owns authentication resolution —
 * endpoint placeholders, header deletion markers, `before_provider_headers`,
 * and provider env. If the configured model is missing or the call throws,
 * we fall through (return undefined) and pi runs its own compaction.
 *
 * After an automatic compaction the work should carry on by itself; a manual
 * `/compact` is the user's own call and stays put. Pi covers two of those cases
 * already: overflow recovery calls `agent.continue()` itself, and a threshold
 * compaction that lands mid-run keeps the run alive. This module covers the
 * third — an automatic compaction that ended the run — by riding pi's
 * `agent_before_settle` boundary, where `continue: true` becomes one more
 * provider request. That boundary is pi 0.87+; on 0.86 the handler registers
 * and is never dispatched, which leaves auto-compaction without a resume there.
 * Resumes are capped (MAX_CONSECUTIVE_RESUMES) and the cap resets on user input.
 */

import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { uuidv7, type Model } from "@earendil-works/pi-ai";
import { getCompactModelKey } from "../settings.js";
import { parseModelKey } from "../settings.js";
import type { Module, Skeleton } from "./skeleton.js";

type CompactionReason = "manual" | "threshold" | "overflow";

interface CompactionEventMetadata {
  reason: CompactionReason;
  willRetry: boolean;
}

function formatCompactionMode(event: CompactionEventMetadata): string {
  return event.willRetry ? `${event.reason}, retrying` : event.reason;
}

function getConfiguredCompactModel(registry: any): Model<any> | null {
  const key = getCompactModelKey();
  if (!key) return null;
  const parsed = parseModelKey(key);
  if (!parsed) return null;
  return registry.find(parsed.provider, parsed.modelId) ?? null;
}

/** Custom-message type carried by the resume turn. */
export const RESUME_CUSTOM_TYPE = "auto_compact_resume";

/** Instruction the resumed turn starts from. */
export const RESUME_TEXT =
  "The context was just auto-compacted. Continue the current task based on the summary above. " +
  "Do not repeat completed work. If unsure about progress, briefly summarize current state then continue.";

/** Most resumes granted back-to-back with no user turn in between. A context
 *  window whose `keepRecentTokens` sits at or above `contextWindow -
 *  reserveTokens` comes out of a compaction still over the threshold, so
 *  without a cap it can compact → resume → compact again and buy a model turn
 *  every round. Pi's boundary docs ask handlers to guard continuation. */
export const MAX_CONSECUTIVE_RESUMES = 3;

/** Auto-compaction bookkeeping, keyed by session id: one process can host
 *  several sessions (SDK/RPC), and one session's `agent_start` must not cancel
 *  another session's resume. */
interface ResumeState {
  /** An auto-compaction is the last thing that happened: nothing has asked the
   *  model for another request yet. Cleared by every sign that pi continued on
   *  its own — the `agent_start` of its own overflow retry, and the assistant
   *  message a mid-run threshold compaction is followed by. */
  pending: boolean;
  /** Resumes granted since the user last submitted input. */
  granted: number;
}

const resumeStates = new Map<string, ResumeState>();

function resumeState(ctx: ExtensionContext): ResumeState {
  const id = ctx.sessionManager.getSessionId();
  let state = resumeStates.get(id);
  if (!state) {
    state = { pending: false, granted: 0 };
    resumeStates.set(id, state);
  }
  return state;
}

/** Test-only: drop the per-session resume state between specs. */
export function resetAwaitingResume(): void {
  resumeStates.clear();
}

/** Compute final file lists from file operations, mirroring pi's
 *  `computeFileLists`: files that were both read and modified count as
 *  modified only. */
function computeFileLists(fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }) {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
  return { readFiles: readOnly, modifiedFiles: [...modified].sort() };
}

/** Format file lists as XML sections, mirroring pi's `formatFileOperations`. */
function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

/** Build the summarization user prompt from the preparation's messages.
 *  Mirrors pi's official custom-compaction example: the full context is
 *  serialized to text and summarized with a structured template, carrying
 *  over any previous summary and the session's custom compaction focus. */
export function buildSummaryPrompt(
  preparation: any,
  customInstructions?: string,
): string {
  const { messagesToSummarize, turnPrefixMessages, previousSummary } = preparation;
  const conversationText = serializeConversation(convertToLlm([
    ...messagesToSummarize,
    ...turnPrefixMessages,
  ]));
  const previousContext = previousSummary
    ? `\n\nPrevious session summary for context:\n${previousSummary}`
    : "";
  const focus = customInstructions ? `\n\nAdditional focus: ${customInstructions}` : "";
  return `You are a conversation summarizer. Create a comprehensive summary of this conversation that captures:${previousContext}

1. The main goals and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file modifications, or technical details
4. Current state of any ongoing work
5. Any blockers, issues, or open questions
6. Next steps that were planned or suggested

Be thorough but concise. The summary will replace the ENTIRE conversation history, so include all information needed to continue the work effectively.

Format the summary as structured markdown with clear sections.${focus}

<conversation>
${conversationText}
</conversation>`;
}

export const compactionModule: Module = {
  name: "compaction",
  hooks: {
    // A user turn re-bases both the pending flag and the cap: whatever the
    // next auto-compaction turns up is again unasked work.
    input: [
      (_event, ctx) => {
        const state = resumeState(ctx);
        state.pending = false;
        state.granted = 0;
      },
    ],
    // Any event that means the model gets another request on its own cancels
    // the pending resume: pi's overflow retry starts a run, and a mid-run
    // threshold compaction is followed by the assistant message it was
    // compacted for.
    agent_start: [
      (_event, ctx) => {
        resumeState(ctx).pending = false;
      },
    ],
    message_end: [
      (event, ctx) => {
        if (event.message?.role === "assistant") resumeState(ctx).pending = false;
        return undefined;
      },
    ],
    session_compact: [
      (event, ctx) => {
        // `/compact` is the user's own call, and `willRetry` means pi already
        // hands the interrupted turn back to the model itself.
        if (event.reason === "manual" || event.willRetry) return;
        resumeState(ctx).pending = true;
      },
    ],
    agent_before_settle: [
      (event, ctx) => {
        const state = resumeState(ctx);
        if (!state.pending) return;
        state.pending = false;
        // Errors and aborts keep pi's own retry/cancellation handling; only a
        // run that finished leaves work that needs picking back up.
        if (event.outcome !== "completed") return;
        if (state.granted >= MAX_CONSECUTIVE_RESUMES) return;
        state.granted += 1;
        return {
          entries: [
            ...(Array.isArray(event.entries) ? event.entries : []),
            {
              type: "custom_message",
              customType: RESUME_CUSTOM_TYPE,
              content: RESUME_TEXT,
              display: false,
            },
          ],
          continue: true,
        };
      },
    ],
    session_before_compact: [
      async (event, ctx) => {
        const model = getConfiguredCompactModel(ctx.modelRegistry);
        if (!model) return; // No custom compact model configured → let pi run its default compaction.
        const { preparation, customInstructions, signal } = event;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `📦 Compacting with ${model.id} (${formatCompactionMode(event)}, ${preparation.tokensBefore.toLocaleString()} tokens)...`,
            "info",
          );
        }
        try {
          // Bound the output like pi's native compaction: respect both the
          // reserve-token budget and the model's own output limit.
          const maxTokens = Math.min(
            Math.floor(0.8 * preparation.settings.reserveTokens),
            model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
          );
          const response = await ctx.modelRegistry.complete(model, {
            messages: [{
              role: "user",
              content: [{ type: "text", text: buildSummaryPrompt(preparation, customInstructions) }],
              timestamp: Date.now(),
            }],
          }, {
            maxTokens,
            signal,
            cacheRetention: "none",
            // Summaries are standalone requests — a fresh session id keeps
            // them out of provider session-based prompt caches.
            sessionId: uuidv7(),
          });
          let summary = response.content
            .filter((part): part is { type: "text"; text: string } => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim();
          if (!summary) {
            if (!signal?.aborted && ctx.hasUI) {
              ctx.ui.notify("Compaction summary was empty, using default compaction", "warning");
            }
            return;
          }
          // Preserve deterministic file-operation history in the summary and
          // result details, exactly like pi's native compact(). Appended
          // after the empty check so a model that produced no text still
          // falls through to default compaction.
          const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
          summary += formatFileOperations(readFiles, modifiedFiles);
          return {
            compaction: {
              summary,
              firstKeptEntryId: preparation.firstKeptEntryId,
              tokensBefore: preparation.tokensBefore,
              usage: response.usage,
              details: { readFiles, modifiedFiles },
            },
          };
        } catch (err) {
          if (signal?.aborted) return;
          // Returning undefined lets pi run its default compaction with the
          // active agent model. Surface the failure so the user knows their
          // custom model didn't take effect.
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Custom compact failed (${err instanceof Error ? err.message : err}); using default model.`,
              "warning",
            );
          }
        }
      },
    ],
  },
};

export function setupCompaction(sk: Skeleton): void {
  sk.register(compactionModule);
}

export const __modelIntegrationTest = {
  formatCompactionMode,
};
