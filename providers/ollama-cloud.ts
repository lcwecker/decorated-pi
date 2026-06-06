/**
 * Ollama Cloud — OAuth/subscription provider with hardcoded models
 *
 * Provider: "ollama-cloud"
 * Base URL: https://ollama.com/v1 (OpenAI-compatible)
 * Auth: OAuth/subscription login → prompt for API key
 *
 * All models hardcoded from models.dev. No dynamic fetching, no config file caching.
 * - No auth → no models in /model (clean UX, via hasConfiguredAuth)
 * - Login → models become available immediately
 * - Startup → models registered unconditionally (hardcoded)
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

const PROVIDER_ID = "ollama-cloud";
const PROVIDER_DISPLAY_NAME = "Ollama Cloud";
const BASE_URL = "https://ollama.com/v1";

// ── Hardcoded models (from models.dev) ────────────────────────────────────

const MODELS: ProviderModelConfig[] = [
  { id: "cogito-2.1:671b", name: "cogito-2.1:671b", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 163_840, maxTokens: 32_000, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "deepseek-v3.1:671b", name: "deepseek-v3.1:671b", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 163_840, maxTokens: 163_840, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "deepseek-v3.2", name: "deepseek-v3.2", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 163_840, maxTokens: 65_536, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "deepseek-v4-flash", name: "deepseek-v4-flash", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 1_048_576, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "deepseek-v4-pro", name: "deepseek-v4-pro", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 1_048_576, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "devstral-2:123b", name: "devstral-2:123b", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 262_144, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "devstral-small-2:24b", name: "devstral-small-2:24b", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 262_144, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "gemini-3-flash-preview", name: "gemini-3-flash-preview", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 65_536, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "gemma3:12b", name: "gemma3:12b", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "gemma3:27b", name: "gemma3:27b", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "gemma3:4b", name: "gemma3:4b", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "gemma4:31b", name: "gemma4:31b", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 262_144, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "glm-4.6", name: "glm-4.6", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 202_752, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "glm-4.7", name: "glm-4.7", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 202_752, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "glm-5", name: "glm-5", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 202_752, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "glm-5.1", name: "glm-5.1", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 202_752, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "gpt-oss:120b", name: "gpt-oss:120b", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 32_768, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "gpt-oss:20b", name: "gpt-oss:20b", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 32_768, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "kimi-k2-thinking", name: "kimi-k2-thinking", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 262_144, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "kimi-k2.5", name: "kimi-k2.5", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 262_144, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "kimi-k2.6", name: "kimi-k2.6", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 262_144, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "kimi-k2:1t", name: "kimi-k2:1t", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 262_144, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "minimax-m2", name: "minimax-m2", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 204_800, maxTokens: 128_000, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "minimax-m2.1", name: "minimax-m2.1", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 204_800, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "minimax-m2.5", name: "minimax-m2.5", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 204_800, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "minimax-m2.7", name: "minimax-m2.7", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 196_608, maxTokens: 196_608, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "ministral-3:14b", name: "ministral-3:14b", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 128_000, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "ministral-3:3b", name: "ministral-3:3b", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 128_000, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "ministral-3:8b", name: "ministral-3:8b", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 128_000, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "mistral-large-3:675b", name: "mistral-large-3:675b", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 262_144, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "nemotron-3-nano:30b", name: "nemotron-3-nano:30b", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "nemotron-3-super", name: "nemotron-3-super", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 65_536, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "qwen3-coder-next", name: "qwen3-coder-next", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 65_536, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "qwen3-coder:480b", name: "qwen3-coder:480b", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 65_536, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "qwen3-next:80b", name: "qwen3-next:80b", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 32_768, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "qwen3-vl:235b", name: "qwen3-vl:235b", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 32_768, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "qwen3-vl:235b-instruct", name: "qwen3-vl:235b-instruct", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 131_072, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "qwen3.5:397b", name: "qwen3.5:397b", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 65_536, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
  { id: "rnj-1:8b", name: "rnj-1:8b", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 4_096, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } as any },
];

// ── Entry ──────────────────────────────────────────────────────────────────

export function setupOllamaCloud(pi: ExtensionAPI) {
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
          message: "Enter Ollama Cloud API key:",
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
