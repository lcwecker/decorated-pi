/**
 * Extend Model — 模型 SDK
 *
 * 对外接口:
 *   analyzeImage(model, base64, mediaType, apiKey, headers) → Promise<string>
 *   getConfiguredImageModel(registry) → Model | null
 *
 * 内部事件:
 *   tool_call / tool_result: 图片 read → Vision API 回退
 *   session_before_compact:  自定义压缩模型
 *   session_compact:         压缩后自动继续
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  generateSummary, convertToLlm, serializeConversation,
  DynamicBorder, keyHint, rawKeyHint, Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container, fuzzyFilter, getKeybindings, Input,
  Spacer, Text, type TUI,
} from "@earendil-works/pi-tui";
import OpenAI from "openai";
import { fileTypeFromFile } from "file-type";
import type { Model } from "@earendil-works/pi-ai";
import {
  loadConfig, saveConfig, parseModelKey, formatModelKey,
  getImageModelKey, getCompactModelKey,
  setImageModelKey, setCompactModelKey,
} from "./settings.js";
import * as fs from "node:fs";
import { extname, resolve } from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
// SDK 接口
// ═══════════════════════════════════════════════════════════════════════════

export function getConfiguredImageModel(registry: any): Model<any> | null {
  const key = getImageModelKey();
  if (!key) return null;
  const parsed = parseModelKey(key);
  if (!parsed) return null;
  return registry.find(parsed.provider, parsed.modelId) ?? null;
}

const DEFAULT_PROMPT =
  "Please describe this image in detail, including any text, diagrams, UI elements, or code visible in it.";

export async function analyzeImage(
  model: Model<any>, imageBase64: string, mediaType: string,
  apiKey: string, extraHeaders: Record<string, string>
): Promise<string> {
  if (model.api === "anthropic-messages") {
    return analyzeAnthropic(model, imageBase64, mediaType, apiKey, extraHeaders);
  }
  return analyzeOpenAI(model, imageBase64, mediaType, apiKey, extraHeaders);
}

async function analyzeOpenAI(
  model: Model<any>, imageBase64: string, mediaType: string,
  apiKey: string, extraHeaders: Record<string, string>
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
  apiKey: string, extraHeaders: Record<string, string>
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

// ═══════════════════════════════════════════════════════════════════════════
// 图片检测（magic bytes）
// ═══════════════════════════════════════════════════════════════════════════

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

async function detectImageMimeType(filePath: string): Promise<string | null> {
  try {
    const type = await fileTypeFromFile(filePath);
    if (!type || !SUPPORTED_IMAGE_TYPES.has(type.mime)) return null;
    return type.mime;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// 图片 read 回退
// ═══════════════════════════════════════════════════════════════════════════

function setupImageReadFallback(pi: ExtensionAPI) {
  const pendingFallbacks = new Set<string>();

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "read") return;
    const filePath: string | undefined = (event.input as any)?.file ?? (event.input as any)?.path;
    if (!filePath) return;

    const mimeType = await detectImageMimeType(resolve(ctx.cwd, filePath));
    if (!mimeType) return;
    if (!getImageModelKey()) return;

    pendingFallbacks.add(event.toolCallId);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!pendingFallbacks.delete(event.toolCallId)) return;
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
      const mimeType = await detectImageMimeType(absPath) ?? "image/png";

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(imageModel as Model<any>);
      if (!auth.ok) return;

      const analysis = await analyzeImage(
        imageModel as Model<any>, imageBase64, mimeType,
        auth.apiKey ?? "", auth.headers ?? {}
      );
      return {
        content: [{ type: "text", text: `[Image analysis via ${parsed.provider}/${parsed.modelId}]\n\n${analysis}` }],
        details: { imageModel: imageKey, originalPath: filePath },
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Image analysis failed: ${error instanceof Error ? error.message : error}` }],
      };
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 模型选择器组件
// ═══════════════════════════════════════════════════════════════════════════

const TAB_IMAGE = 0;
const TAB_COMPACT = 1;

export class ModelPickerComponent extends Container {
  private searchInput: Input;
  private tui: TUI;
  private theme: Theme;
  private registry: any;
  private onDone: () => void;
  private activeTab = TAB_IMAGE;
  private imageKey: string | null;
  private compactKey: string | null;
  private allItems: { label: string; desc: string; model: Model<any> | null; modelName?: string }[] = [];
  private filtered: typeof this.allItems = [];
  private selectedIndex = 0;
  private tabTitle = new Text("", 1, 0);
  private subtitleText: Text;
  private listContainer: Container;

  constructor(tui: TUI, theme: unknown, registry: any, onDone: () => void) {
    super();
    this.tui = tui;
    this.theme = theme as Theme;
    this.registry = registry;
    this.onDone = onDone;
    this.imageKey = getImageModelKey();
    this.compactKey = getCompactModelKey();

    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(this.tabTitle);
    this.subtitleText = new Text("", 1, 0);
    this.addChild(this.subtitleText);
    this.addChild(new Spacer(1));

    this.searchInput = new Input();
    this.searchInput.onSubmit = () => { const s = this.filtered[this.selectedIndex]; if (s) this.selectModel(s.model); };
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));

    this.addChild(new Text(
      rawKeyHint("↑↓", "navigate") + "  " + keyHint("tui.input.tab", "switch") + "  " +
      keyHint("tui.select.confirm", "select") + "  " + keyHint("tui.select.cancel", "cancel"), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());

    this.loadModels().then(() => { this.switchTab(TAB_IMAGE); this.tui.requestRender(); });
  }

  private async loadModels() {
    this.registry.refresh();
    const available = this.registry.getAvailable() as Model<any>[];
    this.allItems = [{ label: "clear", desc: "(unset)", model: null }];
    for (const m of available) {
      this.allItems.push({ label: m.id, desc: `[${m.provider}]`, model: m as Model<any>, modelName: m.name });
    }
  }

  private currentKey() { return this.activeTab === TAB_IMAGE ? this.imageKey : this.compactKey; }
  private currentKind() { return this.activeTab === TAB_IMAGE ? "image" : "compact"; }

  private switchTab(tab: number) {
    this.activeTab = tab;
    const key = this.currentKey();
    const [clearItem, ...rest] = this.allItems;
    const items = rest.map(it => {
      const isCurrent = it.model && formatModelKey(it.model) === key;
      return { ...it, desc: `${it.desc}${isCurrent ? " ✓" : ""}` };
    });
    items.sort((a, b) => {
      const aCur = a.model && formatModelKey(a.model) === key;
      const bCur = b.model && formatModelKey(b.model) === key;
      if (aCur && !bCur) return -1; if (!aCur && bCur) return 1; return 0;
    });
    this.filtered = [clearItem, ...items];
    this.selectedIndex = 0;
    if (key) { const ix = this.filtered.findIndex(m => m.model && formatModelKey(m.model) === key); if (ix >= 0) this.selectedIndex = ix; }
    this.searchInput.setValue("");
    this.updateHeader();
    this.updateList();
  }

  private updateHeader() {
    const t = this.theme;
    const im = this.activeTab === TAB_IMAGE ? t.fg("accent", "●") : "○";
    const cm = this.activeTab === TAB_COMPACT ? t.fg("accent", "●") : "○";
    const il = this.activeTab === TAB_IMAGE ? t.bold("Image Model") : t.fg("dim", "Image Model");
    const cl = this.activeTab === TAB_COMPACT ? t.bold("Compact Model") : t.fg("dim", "Compact Model");
    this.tabTitle.setText(`${im} ${il}  |  ${cm} ${cl}`);
    const key = this.currentKey();
    this.subtitleText.setText(key ? t.fg("warning", `Current ${this.currentKind()} model: ${key}`) : t.fg("warning", `No ${this.currentKind()} model set`));
  }

  handleInput(keyData: string) {
    const kb = getKeybindings();
    if (kb.matches(keyData, "tui.input.tab")) { this.switchTab(this.activeTab === TAB_IMAGE ? TAB_COMPACT : TAB_IMAGE); this.tui.requestRender(); return; }
    if (kb.matches(keyData, "tui.select.up")) { this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1; this.updateList(); return; }
    if (kb.matches(keyData, "tui.select.down")) { this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1; this.updateList(); return; }
    if (kb.matches(keyData, "tui.select.confirm")) { const s = this.filtered[this.selectedIndex]; if (s) this.selectModel(s.model); return; }
    if (kb.matches(keyData, "tui.select.cancel")) { this.onDone(); return; }
    this.searchInput.handleInput(keyData); this.applyFilter();
  }

  private applyFilter() {
    const raw = this.searchInput.getValue();
    if (!raw) { this.switchTab(this.activeTab); return; }
    const [clearItem, ...rest] = this.filtered;
    this.filtered = [clearItem, ...fuzzyFilter(rest, raw, ({ label, desc }) => `${label} ${desc}`)];
    this.selectedIndex = 0; this.updateList();
  }

  private selectModel(model: Model<any> | null) {
    const kind = this.currentKind();
    if (model) {
      if (kind === "image") setImageModelKey(formatModelKey(model));
      else setCompactModelKey(formatModelKey(model));
    } else {
      if (kind === "image") setImageModelKey(null);
      else setCompactModelKey(null);
    }
    if (kind === "image") this.imageKey = model ? formatModelKey(model) : null;
    else this.compactKey = model ? formatModelKey(model) : null;
    this.switchTab(this.activeTab); this.tui.requestRender();
  }

  private updateList() {
    this.listContainer.clear();
    const t = this.theme;
    const mv = 10;
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(mv / 2), Math.max(0, this.filtered.length - mv)));
    const end = Math.min(start + mv, this.filtered.length);
    for (let i = start; i < end; i++) {
      const item = this.filtered[i]; if (!item) continue;
      const isClear = item.model === null;
      const isSel = i === this.selectedIndex;
      const line = isClear
        ? (isSel ? t.fg("accent", "→ ") + t.fg("error", "clear") + t.fg("muted", "  (unset)") : "  " + t.fg("muted", "clear  (unset)"))
        : (isSel ? t.fg("accent", "→ ") + t.fg("accent", item.label) + " " + t.fg("muted", item.desc) : "  " + item.label + " " + t.fg("muted", item.desc));
      this.listContainer.addChild(new Text(line, 0, 0));
    }
    if (start > 0 || end < this.filtered.length) this.listContainer.addChild(new Text(t.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 0, 0));
    const sel = this.filtered[this.selectedIndex];
    if (sel?.modelName) { this.listContainer.addChild(new Spacer(1)); this.listContainer.addChild(new Text(t.fg("muted", `  Name: ${sel.modelName}`), 0, 0)); }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 压缩辅助
// ═══════════════════════════════════════════════════════════════════════════

const TURN_PREFIX_PROMPT = `Summarize this turn prefix to provide context for the retained suffix.
Be concise. Focus on what's needed to understand the kept suffix.`;

async function generateTurnPrefixSummary(
  messages: Parameters<typeof generateSummary>[0],
  model: Parameters<typeof generateSummary>[1], reserveTokens: number,
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

function getConfiguredCompactModel(registry: any): Model<any> | null {
  const key = getCompactModelKey();
  if (!key) return null;
  const parsed = parseModelKey(key);
  if (!parsed) return null;
  return registry.find(parsed.provider, parsed.modelId) ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 主入口（注册所有事件）
// ═══════════════════════════════════════════════════════════════════════════

export function setupExtendModel(pi: ExtensionAPI) {
  setupImageReadFallback(pi);

  // 自定义压缩模型
  pi.on("session_before_compact", async (event, ctx) => {
    const model = getConfiguredCompactModel(ctx.modelRegistry);
    if (!model) return; // 没配 → Pi 默认

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) { ctx.ui.notify(`Compact model auth failed: ${auth.error}`, "warning"); return; }

    const { preparation, customInstructions, signal } = event;
    const { messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore,
      firstKeptEntryId, previousSummary, fileOps, settings } = preparation;

    ctx.ui.notify(`🗜️ Compacting with ${model.id} (${tokensBefore.toLocaleString()} tokens)...`, "info");

    try {
      let summary: string;
      if (isSplitTurn && turnPrefixMessages.length > 0) {
        const [hs, ps] = await Promise.all([
          messagesToSummarize.length > 0
            ? generateSummary(messagesToSummarize, model, settings.reserveTokens,
                auth.apiKey ?? "", auth.headers, signal, customInstructions, previousSummary)
            : Promise.resolve("No prior history."),
          generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens,
            auth.apiKey ?? "", auth.headers, signal),
        ]);
        summary = `${hs}\n\n---\n\n**Turn Context (split turn):**\n\n${ps}`;
      } else {
        summary = await generateSummary(messagesToSummarize, model, settings.reserveTokens,
          auth.apiKey ?? "", auth.headers, signal, customInstructions, previousSummary);
      }

      return { compaction: { summary, firstKeptEntryId, tokensBefore } };
    } catch (err) {
      if (signal.aborted) return;
      ctx.ui.notify(`Compact failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  });

  // 压缩后自动继续
  pi.on("session_compact", () => {
    pi.sendMessage({
      customType: "auto_compact_resume",
      content: "The context was just auto-compacted. Continue the current task based on the summary above. Do not repeat completed work. If unsure about progress, briefly summarize current state then continue.",
      display: false,
    }, { triggerTurn: true });
  });
}
