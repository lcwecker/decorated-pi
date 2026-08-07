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
 * Auto-retry/resume is handled by pi natively; `reason` and `willRetry`
 * on compaction events describe manual, threshold, and overflow flows.
 */

import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
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
