/**
 * Baidu Qianfan Coding Plan — OAuth/subscription provider with hardcoded models
 *
 * Provider: "qianfan-coding"
 * Base URL: https://qianfan.baidubce.com/v2/coding (OpenAI-compatible)
 * Auth: OAuth/subscription login → prompt for API key
 *
 * All models hardcoded. No dynamic fetching, no config file caching.
 * - No auth → no models in /model (clean UX, via hasConfiguredAuth)
 * - Login → models become available immediately
 * - Startup → models registered unconditionally (hardcoded)
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

const PROVIDER_ID = "qianfan-coding";
const PROVIDER_DISPLAY_NAME = "Baidu Qianfan Coding Plan";
const BASE_URL = "https://qianfan.baidubce.com/v2/coding";

// ── Hardcoded models (parameters from models.dev + Baidu docs) ────────────

const MODELS: ProviderModelConfig[] = [
  { id: "deepseek-v3.2", name: "DeepSeek V3.2", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 163_840, maxTokens: 65_536, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "glm-4.7", name: "GLM 4.7", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 202_752, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "glm-5", name: "GLM 5", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 202_752, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "glm-5.1", name: "GLM 5.1", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 202_752, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "kimi-k2.5", name: "Kimi K2.5", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 262_144, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "minimax-m2.1", name: "MiniMax M2.1", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 204_800, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "minimax-m2.5", name: "MiniMax M2.5", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 204_800, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "ernie-4.5-turbo-20260402", name: "ERNIE 4.5 Turbo", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 12_288, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 1_048_576, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
];

// ── Entry ──────────────────────────────────────────────────────────────────

export function setupQianfanCoding(pi: ExtensionAPI) {
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
          message: "Enter Baidu Qianfan Coding Plan API key:",
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
