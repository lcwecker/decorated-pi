/**
 * Slash — 所有扩展命令
 *
 * /extend-model     → 模型选择器 (TAB 切换 Image/Compact)
 * /retry            → 中断后继续
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelPickerComponent } from "./extend-model.js";

// ─── /extend-model ─────────────────────────────────────────────────────────

function setupExtendModelCommand(pi: ExtensionAPI) {
  pi.registerCommand("extend-model", {
    description: "Configure image and compact models",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        await ctx.ui.custom<void>(
          (tui, theme, _kb, done) =>
            new ModelPickerComponent(tui, theme, ctx.modelRegistry, () => done(undefined))
        );
        return;
      }
      ctx.ui.notify("extend-model requires interactive mode.", "warning");
    },
  });
}

// ─── /retry ────────────────────────────────────────────────────────────────

function setupRetryCommand(pi: ExtensionAPI) {
  let shouldInjectRetryNote = false;
  let retryInProgress = false;

  pi.registerCommand("retry", {
    description: "Continue after interruption",
    handler: async (_args, ctx) => {
      if (retryInProgress) {
        ctx.ui.notify("Retry is already in progress", "warning");
        return;
      }
      if (!ctx.isIdle()) ctx.abort();

      retryInProgress = true;
      shouldInjectRetryNote = true;
      pi.sendMessage(
        { customType: "retry-trigger", content: "Continue.", display: false },
        { triggerTurn: true }
      );
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (!shouldInjectRetryNote) return;
    shouldInjectRetryNote = false;
    return { systemPrompt: event.systemPrompt + "\n\nThe previous turn was interrupted by the system." };
  });

  pi.on("agent_start", () => { retryInProgress = false; });
}

// ─── 入口 ───────────────────────────────────────────────────────────────────

export function setupSlash(pi: ExtensionAPI) {
  setupExtendModelCommand(pi);
  setupRetryCommand(pi);
}
