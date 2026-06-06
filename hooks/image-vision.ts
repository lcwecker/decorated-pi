/**
 * image-vision — when read is called on an image file, replace the result with
 * a vision model analysis instead of returning raw bytes.
 */

import { fileTypeFromFile } from "file-type";
import * as fs from "node:fs";
import { extname, resolve } from "node:path";
import OpenAI from "openai";
import type { Model } from "@earendil-works/pi-ai";
import { getImageModelKey, parseModelKey } from "../settings.js";
import type { Module, Skeleton } from "./skeleton.js";

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

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

const pendingImageFallbacks = new Set<string>();

export const imageVisionModule: Module = {
  name: "image-vision",
  hooks: {
    tool_call: [
      async (event, ctx) => {
        if (event.toolName !== "read") return;
        const filePath: string | undefined = (event.input as any)?.file ?? (event.input as any)?.path;
        if (!filePath) return;
        const mimeType = await detectImageMimeType(resolve(ctx.cwd, filePath));
        if (!mimeType) return;
        if (!getImageModelKey()) return;
        pendingImageFallbacks.add(event.toolCallId);
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
          const absPath = resolve(ctx.cwd, filePath);
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
            content: [{ type: "text", text: `[Image analysis via ${parsed.provider}/${parsed.modelId}]\n\n${analysis}` }],
            details: { imageModel: imageKey, originalPath: filePath },
          };
        } catch (error) {
          return {
            ...event,
            content: [{ type: "text", text: `Image analysis failed: ${error instanceof Error ? error.message : error}` }],
          };
        }
      },
    ],
  },
};

export function setupImageVision(sk: Skeleton): void {
  sk.register(imageVisionModule);
}
