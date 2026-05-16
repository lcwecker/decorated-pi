/**
 * ARK Coding Plan — OAuth/subscription provider with hardcoded models
 *
 * Provider: "ark-coding"
 * Base URL: https://ark.cn-beijing.volces.com/api/coding/v3 (OpenAI-compatible)
 * Auth: OAuth/subscription login → prompt for API key
 *
 * All models hardcoded. No dynamic fetching, no config file caching.
 * - No auth → no models in /model (clean UX, via hasConfiguredAuth)
 * - Login → models become available immediately
 * - Startup → models registered unconditionally (hardcoded)
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

const PROVIDER_ID = "ark-coding";
const PROVIDER_DISPLAY_NAME = "ARK Coding Plan";
const BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";

// ── Hardcoded models (parameters from models.dev) ─────────────────────────

const MODELS: ProviderModelConfig[] = [
  { id: "deepseek-v3.2", name: "DeepSeek V3.2", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 163_840, maxTokens: 65_536, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "glm-4.7", name: "GLM 4.7", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 202_752, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "glm-5.1", name: "GLM 5.1", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 202_752, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "kimi-k2.5", name: "Kimi K2.5", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 262_144, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "kimi-k2.6", name: "Kimi K2.6", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 262_144, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "minimax-m2.5", name: "MiniMax M2.5", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 204_800, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "minimax-m2.7", name: "MiniMax M2.7", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 196_608, maxTokens: 196_608, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "doubao-seed-2.0-code", name: "Doubao Seed 2.0 Code", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 256_000, maxTokens: 128_000, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "doubao-seed-2.0-pro", name: "Doubao Seed 2.0 Pro", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 256_000, maxTokens: 128_000, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "doubao-seed-2.0-lite", name: "Doubao Seed 2.0 Lite", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 256_000, maxTokens: 32_000, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "doubao-seed-code", name: "Doubao Seed Code", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 256_000, maxTokens: 16_384, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
];

// ── Entry ──────────────────────────────────────────────────────────────────

export function setupArkCoding(pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_DISPLAY_NAME,
    baseUrl: BASE_URL,
    api: "openai-completions",
    authHeader: true,
    models: MODELS,
    oauth: {
      name: PROVIDER_DISPLAY_NAME,

      async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        const apiKey = (await callbacks.onPrompt({
          message: "Enter ARK Coding Plan API key:",
          placeholder: "your-api-key",
        })).trim();

        if (!apiKey) throw new Error("API key cannot be empty.");

        return {
          refresh: apiKey,
          access: apiKey,
          expires: Date.now() + 1000 * 365.24 * 24 * 3600 * 1000, // ~1000 years
        };
      },

      refreshToken(cred: OAuthCredentials): Promise<OAuthCredentials> {
        return Promise.resolve(cred); // API key never expires
      },

      getApiKey(cred: OAuthCredentials): string {
        return cred.access;
      },
    },
  });
}
