/**
 * compaction — custom compaction model + auto-resume.
 *
 * On `session_before_compact`, runs pi-coding-agent's `compact()` against
 * the model configured in settings (rather than the agent's current model)
 * and returns the result so pi uses our summary instead of running its
 * default. If the configured model is missing, auth fails, or the call
 * throws, we fall through (return undefined) and pi runs its own compaction.
 *
 * On `session_compact`, if the compaction was auto-triggered, sends a
 * "continue" message to resume the agent loop.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve } from "node:path";
import { getCompactModelKey } from "../settings.js";
import { parseModelKey } from "../settings.js";
import type { Module, Skeleton } from "./skeleton.js";

interface PiCompactionSettings {
  enabled: boolean;
}

interface AutoCompactionCandidate {
  messages: any[];
  usage: { tokens: number | null; contextWindow: number } | undefined;
}

const DEFAULT_PI_COMPACTION_SETTINGS: PiCompactionSettings = {
  enabled: true,
};

function readJsonObject(filePath: string): any | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function loadPiCompactionSettings(cwd: string): PiCompactionSettings {
  const globalSettings = readJsonObject(resolve(os.homedir(), ".pi", "agent", "settings.json"));
  const projectSettings = readJsonObject(resolve(cwd, ".pi", "settings.json"));
  const merged = {
    ...DEFAULT_PI_COMPACTION_SETTINGS,
    ...(globalSettings?.compaction ?? {}),
    ...(projectSettings?.compaction ?? {}),
  };
  return {
    enabled: merged.enabled !== false,
  };
}

function getLastAssistantMessage(messages: any[]): any | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

/** Mirror pi's _runAutoCompaction(reason, willRetry) decision:
 *   - overflow → willRetry=true → auto-resume the agent
 *   - threshold → willRetry=false → no auto-resume (user continues manually)
 *   - manual /compact → no resume
 * Detected from the post-agent-end candidate: overflow shows up as a
 * context-overflow error on the last assistant message; threshold is a
 * pre-emptive compaction and we intentionally skip auto-resume for it. */
function shouldAutoResumeCompaction(
  candidate: AutoCompactionCandidate | null,
  settings: PiCompactionSettings,
  customInstructions?: string,
): boolean {
  if (customInstructions !== undefined) return false;
  if (!candidate || !settings.enabled) return false;
  const lastAssistant = getLastAssistantMessage(candidate.messages);
  if (!lastAssistant) return false;
  const contextWindow = candidate.usage?.contextWindow ?? 0;
  return contextWindow > 0 && isContextOverflow(lastAssistant, contextWindow);
}

function getConfiguredCompactModel(registry: any): Model<any> | null {
  const key = getCompactModelKey();
  if (!key) return null;
  const parsed = parseModelKey(key);
  if (!parsed) return null;
  return registry.find(parsed.provider, parsed.modelId) ?? null;
}

/** Per-session state. Indexed by sessionId (from ctx.sessionManager) so
 *  two concurrent pi sessions don't trample each other's flags. */
interface SessionState {
  postAgentEndCandidate: AutoCompactionCandidate | null;
  currentCompactionIsAuto: boolean;
}

const sessionStates = new Map<string, SessionState>();

function getSessionState(sessionId: string): SessionState {
  let s = sessionStates.get(sessionId);
  if (!s) {
    s = { postAgentEndCandidate: null, currentCompactionIsAuto: false };
    sessionStates.set(sessionId, s);
  }
  return s;
}

export const compactionModule: Module = {
  name: "compaction",
  hooks: {
    session_shutdown: [
      (_event, ctx) => {
        // Clean up state when the session ends so the Map doesn't grow.
        sessionStates.delete(ctx.sessionManager.getSessionId());
      },
    ],
    input: [
      (_event, ctx) => {
        getSessionState(ctx.sessionManager.getSessionId()).postAgentEndCandidate = null;
      },
    ],
    before_agent_start: [
      (_event, ctx) => {
        getSessionState(ctx.sessionManager.getSessionId()).postAgentEndCandidate = null;
      },
    ],
    agent_start: [
      (_event, ctx) => {
        getSessionState(ctx.sessionManager.getSessionId()).postAgentEndCandidate = null;
      },
    ],
    agent_end: [
      (event, ctx) => {
        getSessionState(ctx.sessionManager.getSessionId()).postAgentEndCandidate = {
          messages: event.messages,
          usage: ctx.getContextUsage(),
        };
      },
    ],
    session_before_compact: [
      async (event, ctx, pi) => {
        const sessionState = getSessionState(ctx.sessionManager.getSessionId());
        const compactionSettings = loadPiCompactionSettings(ctx.cwd);
        // Pi only auto-compacts after agent_end (see _checkCompaction in
        // agent-session.js), so we detect "auto" via the post-agent-end
        // overflow heuristic. Manual /compact carries customInstructions
        // and skips auto-resume.
        const isAutoResume = shouldAutoResumeCompaction(
          sessionState.postAgentEndCandidate,
          compactionSettings,
          event.customInstructions,
        );
        sessionState.postAgentEndCandidate = null;

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
            `🗜️ Compacting with ${model.id} (${preparation.tokensBefore.toLocaleString()} tokens)...`,
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
          // Only mark as auto-resumed if OUR hook did the compaction. If we
          // had fallen through to pi's default path above, pi's own
          // _runAutoCompaction would call agent.continue() on overflow;
          // marking here would cause a duplicate resume message on top.
          sessionState.currentCompactionIsAuto = isAutoResume;
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
    session_compact: [
      (_event, ctx, pi) => {
        const sessionState = getSessionState(ctx.sessionManager.getSessionId());
        const shouldResume = sessionState.currentCompactionIsAuto;
        sessionState.currentCompactionIsAuto = false;
        if (!shouldResume) return;
        pi.sendMessage({
          customType: "auto_compact_resume",
          content: "The context was just auto-compacted. Continue the current task based on the summary above. Do not repeat completed work. If unsure about progress, briefly summarize current state then continue.",
          display: false,
        }, { triggerTurn: true });
      },
    ],
  },
};

export function setupCompaction(sk: Skeleton): void {
  sk.register(compactionModule);
}

export const __modelIntegrationTest = {
  shouldAutoResumeCompaction,
};
