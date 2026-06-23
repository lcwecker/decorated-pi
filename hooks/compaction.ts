/**
 * compaction — custom compaction model.
 *
 * On `session_before_compact`, runs pi-coding-agent's `compact()` against
 * the model configured in settings (rather than the agent's current model)
 * and returns the result so pi uses our summary instead of running its
 * default. If the configured model is missing, auth fails, or the call
 * throws, we fall through (return undefined) and pi runs its own compaction.
 *
 * Auto-retry/resume is handled by pi natively; `reason` and `willRetry`
 * on compaction events describe manual, threshold, and overflow flows.
 */

import { compact } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
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

export const compactionModule: Module = {
  name: "compaction",
  hooks: {
    session_before_compact: [
      async (event, ctx, pi) => {
        const model = getConfiguredCompactModel(ctx.modelRegistry);
        if (!model) return; // No custom compact model configured → let pi run its default compaction.
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
          if (ctx.hasUI) ctx.ui.notify(`Compact model auth failed: ${auth.error}`, "warning");
          return; // Auth failed → fall through to default compaction; pi handles its own resume.
        }
        const { preparation, customInstructions, signal } = event;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `📦 Compacting with ${model.id} (${formatCompactionMode(event)}, ${preparation.tokensBefore.toLocaleString()} tokens)...`,
            "info",
          );
        }
        // Mirror pi's native behavior: compact() uses the agent session's
        // current thinking level (agent-session.js passes this.thinkingLevel
        // to compact() in both manual and auto compaction paths).
        const thinkingLevel = pi.getThinkingLevel();
        try {
          // Delegate to pi-coding-agent's compact() — it does both
          // summarization (using our model) and file-op extraction, and
          // returns the exact CompactionResult shape pi's runner expects.
          const result = await compact(
            preparation,
            model,
            auth.apiKey ?? "",
            auth.headers,
            customInstructions,
            signal,
            thinkingLevel,
          );
          return { compaction: result };
        } catch (err) {
          if (signal.aborted) return;
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
