/**
 * image-vision — when read is called on an image file, replace the result with
 * a vision model analysis instead of returning raw bytes.
 *
 * The vision request goes through pi's model runtime (`modelRegistry.complete`)
 * rather than a hand-rolled SDK/fetch call. The runtime owns authentication
 * resolution: baseUrl placeholders (Cloudflare AI Gateway account/gateway ids),
 * header deletion markers, `before_provider_headers`, provider env, and routing
 * by the model's API (OpenAI responses, Codex `/codex/responses`, Anthropic
 * messages).
 */

import { fileTypeFromFile } from "file-type";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { getImageModelKey, parseModelKey } from "../settings.js";
import type { Module } from "./skeleton.js";

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

/** Analyze an image with the configured vision model through pi's model
 *  runtime. Returns the concatenated text content, or a placeholder when the
 *  model produced no text. */
export async function analyzeImage(
  model: Model<any>,
  imageBase64: string,
  mediaType: string,
  runtime: Pick<ModelRegistry, "complete">,
  signal?: AbortSignal,
): Promise<string> {
  const response = await runtime.complete(model, {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: DEFAULT_PROMPT },
        { type: "image", data: imageBase64, mimeType: mediaType },
      ],
      timestamp: Date.now(),
    }],
  }, {
    maxTokens: 4096,
    signal: signal ?? AbortSignal.timeout(60_000),
  });
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text || "No analysis returned.";
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
            const analysis = await analyzeImage(
              imageModel as Model<any>, imageBase64, mimeType, ctx.modelRegistry,
            );
            return {
              ...event,
              content: [{ type: "text", text: analysis }],
              details: { imageModel: imageKey, originalPath: filePath },
            };
          } catch (error) {
            // Vision analysis failed — step aside and let pi keep the original
            // image read result instead of replacing it with an error stub.
            if (ctx.hasUI) {
              ctx.ui.notify(
                `Image analysis failed: ${error instanceof Error ? error.message : error}`,
                "warning",
              );
            }
            return undefined;
          }
        },
      ],
      session_shutdown: [
        () => pendingImageFallbacks.clear(),
      ],
    },
  };
}

export const __imageVisionTest = { expandHome };
