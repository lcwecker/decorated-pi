/**
 * image-vision — when read is called on an image file, replace the result with
 * a vision model analysis instead of returning raw bytes.
 */

import { fileTypeFromFile } from "file-type";
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as os from "node:os";
import { extname, resolve } from "node:path";
import OpenAI from "openai";
import type { Model } from "@earendil-works/pi-ai";
import { getImageModelKey, parseModelKey } from "../settings.js";
import type { Module, Skeleton } from "./skeleton.js";

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function expandHome(filePath: string): string {
  if (filePath.startsWith("~/")) return resolve(os.homedir(), filePath.slice(2));
  if (filePath === "~") return os.homedir();
  return filePath;
}

async function detectImageMimeType(filePath: string): Promise<string | null> {
  try {
    const type = await fileTypeFromFile(filePath);
    if (!type || !SUPPORTED_IMAGE_TYPES.has(type.mime)) return null;
    return type.mime;
  } catch {
    return null;
  }
}

const DEFAULT_PROMPT = "Please describe this image in detail, including any text, diagrams, UI elements, or code visible in it.";

export async function analyzeImage(
  model: Model<any>, imageBase64: string, mediaType: string,
  apiKey: string, extraHeaders: Record<string, string>,
): Promise<string> {
  if (model.api === "anthropic-messages") {
    return analyzeAnthropic(model, imageBase64, mediaType, apiKey, extraHeaders);
  }
  if (model.api === "openai-codex-responses") {
    return analyzeCodex(model, imageBase64, mediaType, apiKey, extraHeaders);
  }
  return analyzeOpenAI(model, imageBase64, mediaType, apiKey, extraHeaders);
}

async function analyzeOpenAI(
  model: Model<any>, imageBase64: string, mediaType: string,
  apiKey: string, extraHeaders: Record<string, string>,
): Promise<string> {
  const client = new OpenAI({ apiKey, baseURL: model.baseUrl, defaultHeaders: extraHeaders });
  const resp = await client.chat.completions.create({
    model: model.id,
    messages: [{ role: "user", content: [
      { type: "text", text: DEFAULT_PROMPT },
      { type: "image_url", image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
    ]}],
    max_completion_tokens: 4096,
  }, { signal: AbortSignal.timeout(60_000) });
  return resp.choices[0]?.message?.content ?? "No analysis returned.";
}

function codexResponsesUrl(baseUrl?: string): string {
  const base = (baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
  return base.endsWith("/codex/responses") ? base
    : base.endsWith("/codex") ? `${base}/responses`
    : `${base}/codex/responses`;
}

function extractCodexAccountId(apiKey: string): string {
  try {
    const parts = apiKey.split(".");
    if (parts.length !== 3) return "";
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? "";
  } catch {
    return "";
  }
}

function appendCodexSseDelta(outputText: string, line: string): string {
  if (!line.startsWith("data: ")) return outputText;
  const data = line.slice(6).trim();
  if (data === "[DONE]") return outputText;
  try {
    const parsed = JSON.parse(data);
    if (parsed.type === "response.output_text.delta") {
      return outputText + (parsed.delta ?? "");
    }
  } catch { /* skip malformed */ }
  return outputText;
}

async function analyzeCodex(
  model: Model<any>, imageBase64: string, mediaType: string,
  apiKey: string, extraHeaders: Record<string, string>,
): Promise<string> {
  // Codex uses /codex/responses, not the standard /responses path.
  const url = codexResponsesUrl(model.baseUrl);

  // Codex auth: extract accountId from JWT, set special headers.
  const accountId = extractCodexAccountId(apiKey);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
    "Originator": "pi",
    "OpenAI-Beta": "responses=experimental",
    "accept": "text/event-stream",
    ...extraHeaders,
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model.id,
      store: false,
      stream: true,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: DEFAULT_PROMPT },
          { type: "input_image", image_url: `data:${mediaType};base64,${imageBase64}`, detail: "auto" },
        ],
      }],
      text: { format: { type: "text" } },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Codex API error ${resp.status}: ${text.slice(0, 300)}`);
  }
  // Codex only supports SSE streaming; read the event stream.
  const reader = resp.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";
  let outputText = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) outputText = appendCodexSseDelta(outputText, line);
  }
  buffer += decoder.decode();
  for (const line of buffer.split(/\r?\n/)) outputText = appendCodexSseDelta(outputText, line);
  return outputText || "No analysis returned.";
}


async function analyzeAnthropic(
  model: Model<any>, imageBase64: string, mediaType: string,
  apiKey: string, extraHeaders: Record<string, string>,
): Promise<string> {
  const ep = `${model.baseUrl.replace(/\/+$/, "")}/messages`;
  const resp = await fetch(ep, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", ...extraHeaders },
    body: JSON.stringify({
      model: model.id, max_tokens: 4096,
      messages: [{ role: "user", content: [
        { type: "text", text: DEFAULT_PROMPT },
        { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
      ]}],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`Vision API error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = (await resp.json()) as any;
  return data.content?.[0]?.text ?? "No analysis returned.";
}

/** Build one isolated image-vision module instance. The pending-fallback
 *  set belongs to the module closure, so reloads and parallel sessions
 *  cannot share or leak pending tool-call IDs. */
export function createImageVisionModule(): Module {
  const pendingImageFallbacks = new Set<string>();

  return {
    name: "image-vision",
    hooks: {
      session_start: [
        () => pendingImageFallbacks.clear(),
      ],
      tool_call: [
        async (event, ctx) => {
          if (event.toolName !== "read") return;
          const filePath: string | undefined = (event.input as any)?.file ?? (event.input as any)?.path;
          if (!filePath) return;
          const mimeType = await detectImageMimeType(resolve(ctx.cwd, expandHome(filePath)));
          if (!mimeType) return;
          const imageKey = getImageModelKey();
          if (!imageKey) return;
          pendingImageFallbacks.add(event.toolCallId);
          if (ctx.hasUI) {
            const p = parseModelKey(imageKey);
            if (p) {
              ctx.ui.notify(
                `🖼️ Analyzing image with ${p.provider}/${p.modelId}...`,
                "info",
              );
            }
          }
        },
      ],
      tool_result: [
        async (event, ctx) => {
          if (!pendingImageFallbacks.delete(event.toolCallId)) return;
          const filePath: string | undefined = (event.input as any)?.file ?? (event.input as any)?.path;
          if (!filePath) return;
          const imageKey = getImageModelKey();
          if (!imageKey) return;
          const parsed = parseModelKey(imageKey);
          if (!parsed) return;
          const imageModel = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
          if (!imageModel) return;
          try {
            const absPath = resolve(ctx.cwd, expandHome(filePath));
            const imageData = fs.readFileSync(absPath);
            const imageBase64 = imageData.toString("base64");
            const mimeType = (await detectImageMimeType(absPath)) ?? "image/png";
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(imageModel as Model<any>);
            if (!auth.ok) return;
            const analysis = await analyzeImage(
              imageModel as Model<any>, imageBase64, mimeType,
              auth.apiKey ?? "", auth.headers ?? {},
            );
            return {
              ...event,
              content: [{ type: "text", text: analysis }],
              details: { imageModel: imageKey, originalPath: filePath },
            };
          } catch (error) {
            if (ctx.hasUI) {
              ctx.ui.notify(
                `Image analysis failed: ${error instanceof Error ? error.message : error}`,
                "warning",
              );
            }
            return {
              ...event,
              content: [{ type: "text", text: `Image analysis failed` }],
            };
          }
        },
      ],
      session_shutdown: [
        () => pendingImageFallbacks.clear(),
      ],
    },
  };
}

export function setupImageVision(sk: Skeleton): void {
  sk.register(createImageVisionModule());
}

export const __imageVisionTest = { expandHome, analyzeCodex, appendCodexSseDelta, codexResponsesUrl, extractCodexAccountId };
