/**
 * compaction — custom compaction model + auto-resume.
 *
 * Uses the configured compact model (from settings.ts) to summarize messages
 * on session_before_compact. After auto-compaction, sends a "continue" message
 * to resume the agent loop.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generateSummary, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
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
  reserveTokens: number;
}

interface AutoCompactionCandidate {
  messages: any[];
  usage: { tokens: number | null; contextWindow: number } | undefined;
}

const DEFAULT_PI_COMPACTION_SETTINGS: PiCompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
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
    reserveTokens: typeof merged.reserveTokens === "number" ? merged.reserveTokens : DEFAULT_PI_COMPACTION_SETTINGS.reserveTokens,
  };
}

function getLastAssistantMessage(messages: any[]): any | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

function shouldExpectAutoCompaction(
  messages: any[],
  usage: { tokens: number | null; contextWindow: number } | undefined,
  settings: PiCompactionSettings,
): boolean {
  if (!settings.enabled) return false;
  const lastAssistant = getLastAssistantMessage(messages);
  if (!lastAssistant) return false;
  const contextWindow = usage?.contextWindow ?? 0;
  if (contextWindow > 0 && isContextOverflow(lastAssistant, contextWindow)) return true;
  if (!usage || usage.tokens === null) return false;
  return usage.tokens > usage.contextWindow - settings.reserveTokens;
}

function shouldAutoResumeCompaction(
  prePromptCompactionPending: boolean,
  postAgentEndCandidate: AutoCompactionCandidate | null,
  settings: PiCompactionSettings,
  customInstructions?: string,
): boolean {
  if (customInstructions !== undefined) return false;
  if (prePromptCompactionPending) return true;
  if (!postAgentEndCandidate) return false;
  return shouldExpectAutoCompaction(postAgentEndCandidate.messages, postAgentEndCandidate.usage, settings);
}

function getConfiguredCompactModel(registry: any): Model<any> | null {
  const key = getCompactModelKey();
  if (!key) return null;
  const parsed = parseModelKey(key);
  if (!parsed) return null;
  return registry.find(parsed.provider, parsed.modelId) ?? null;
}

const TURN_PREFIX_PROMPT = `Summarize this turn prefix to provide context for the retained suffix. Be concise. Focus on what's needed to understand the kept suffix.`;

async function generateTurnPrefixSummary(
  messages: any[], model: Model<any>, reserveTokens: number,
  apiKey: string, headers: Record<string, string> | undefined, signal: AbortSignal,
): Promise<string> {
  const { complete } = await import("@earendil-works/pi-ai");
  const ct = serializeConversation(convertToLlm(messages));
  const resp = await complete(model, {
    systemPrompt: "You are a context summarization assistant. Produce a structured summary only.",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: `<conversation>\n${ct}\n</conversation>\n\n${TURN_PREFIX_PROMPT}` }], timestamp: Date.now() }],
  }, { maxTokens: Math.floor(0.5 * reserveTokens), signal, apiKey, headers });
  if (resp.stopReason === "error") throw new Error(resp.errorMessage ?? "Turn prefix summarization failed");
  return resp.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map(c => c.text).join("\n");
}

let prePromptCompactionPending = false;
let postAgentEndCandidate: AutoCompactionCandidate | null = null;
let currentCompactionIsAuto = false;

export const compactionModule: Module = {
  name: "compaction",
  hooks: {
    input: [() => { prePromptCompactionPending = true; postAgentEndCandidate = null; }],
    before_agent_start: [() => { prePromptCompactionPending = false; postAgentEndCandidate = null; }],
    agent_start: [() => { prePromptCompactionPending = false; postAgentEndCandidate = null; }],
    agent_end: [
      (event, ctx) => {
        prePromptCompactionPending = false;
        postAgentEndCandidate = { messages: event.messages, usage: ctx.getContextUsage() };
      },
    ],
    session_before_compact: [
      async (event, ctx) => {
        const compactionSettings = loadPiCompactionSettings(ctx.cwd);
        const { isContextOverflow } = await import("@earendil-works/pi-ai");
        const isAuto = shouldExpectAutoCompaction(
          postAgentEndCandidate?.messages ?? [],
          postAgentEndCandidate?.usage,
          compactionSettings,
          isContextOverflow,
        );
        // For simplicity, treat session_before_compact as auto if recent agent_end was likely-overflow
        // and no custom instructions given.
        const isAutoResume = isAuto && !event.customInstructions;
        currentCompactionIsAuto = isAutoResume;
        prePromptCompactionPending = false;
        postAgentEndCandidate = null;

        const model = getConfiguredCompactModel(ctx.modelRegistry);
        if (!model) return;
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
          if (ctx.hasUI) ctx.ui.notify(`Compact model auth failed: ${auth.error}`, "warning");
          return;
        }
        const { preparation, customInstructions, signal } = event;
        const { messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, firstKeptEntryId, previousSummary, settings } = preparation;
        if (ctx.hasUI) ctx.ui.notify(`🗜️ Compacting with ${model.id} (${tokensBefore.toLocaleString()} tokens)...`, "info");
        try {
          let summary: string;
          if (isSplitTurn && turnPrefixMessages.length > 0) {
            const [hs, ps] = await Promise.all([
              messagesToSummarize.length > 0
                ? generateSummary(messagesToSummarize, model, settings.reserveTokens, auth.apiKey ?? "", auth.headers, signal, customInstructions, previousSummary)
                : Promise.resolve("No prior history."),
              generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, auth.apiKey ?? "", auth.headers, signal),
            ]);
            summary = `${hs}\n\n---\n\n**Turn Context (split turn):**\n\n${ps}`;
          } else {
            summary = await generateSummary(messagesToSummarize, model, settings.reserveTokens, auth.apiKey ?? "", auth.headers, signal, customInstructions, previousSummary);
          }
          return { compaction: { summary, firstKeptEntryId, tokensBefore } };
        } catch (err) {
          if (signal.aborted) return;
          if (ctx.hasUI) ctx.ui.notify(`Compact failed: ${err instanceof Error ? err.message : err}`, "error");
        }
      },
    ],
    session_compact: [
      (_event, _ctx, pi) => {
        const shouldResume = currentCompactionIsAuto;
        currentCompactionIsAuto = false;
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
  shouldExpectAutoCompaction,
  shouldAutoResumeCompaction,
};
