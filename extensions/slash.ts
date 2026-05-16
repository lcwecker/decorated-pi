/**
 * Slash — 所有扩展命令
 *
 * /dp-model    → 模型选择器 (TAB 切换 Image/Compact)
 * /dp-settings → 模块开关 (safety / lsp / smart-at)
 * /retry       → 中断后继续
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelPickerComponent } from "./extend-model.js";
import { getAllModuleSettings, setModuleEnabled, type ModuleSettings } from "./settings.js";
import { Container, SettingsList, type TUI, type Theme as PiTheme, type SettingsListTheme, type Component } from "@earendil-works/pi-tui";

// ─── Border component (matches native DynamicBorder) ────────────────────────

class DynamicBorder implements Component {
  private colorFn: (str: string) => string;

  constructor(theme: PiTheme) {
    this.colorFn = (str: string) => theme.fg("border", str);
  }

  invalidate() {}

  render(width: number): string[] {
    return [this.colorFn("─".repeat(Math.max(1, width)))];
  }
}

// ─── SettingsList Theme (matches native getSettingsListTheme) ───────────────

function getSettingsListTheme(theme: PiTheme): SettingsListTheme {
  return {
    label: (text: string, selected: boolean) => selected ? theme.fg("accent", text) : text,
    value: (text: string, selected: boolean) => selected ? theme.fg("accent", text) : theme.fg("muted", text),
    description: (text: string) => theme.fg("dim", text),
    cursor: theme.fg("accent", "→ "),
    hint: (text: string) => theme.fg("dim", text),
  };
}

// ─── /dp-model ─────────────────────────────────────────────────────────────

function setupDpModelCommand(pi: ExtensionAPI) {
  pi.registerCommand("dp-model", {
    description: "Configure image and compact models",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        await ctx.ui.custom<void>(
          (tui, theme, _kb, done) =>
            new ModelPickerComponent(tui, theme, ctx.modelRegistry, () => done(undefined))
        );
        return;
      }
      ctx.ui.notify("dp-model requires interactive mode.", "warning");
    },
  });
}

// ─── /dp-settings ──────────────────────────────────────────────────────────

const MODULE_LABELS: Record<keyof ModuleSettings, string> = {
  safety: "Safety Layer",
  lsp: "LSP Tools",
  "smart-at": "Smart @ Search",
};

const MODULE_DESCS: Record<keyof ModuleSettings, string> = {
  safety: "Command guard, protected paths, read guard, secret redaction",
  lsp: "Language server diagnostics, hover, definition, references, symbols, rename",
  "smart-at": "Project-aware file search replacing default autocomplete",
};

class ModuleSettingsComponent extends Container {
  private settingsList: SettingsList;

  constructor(tui: TUI, theme: PiTheme, onDone: () => void) {
    super();
    const modules = getAllModuleSettings();
    const keys = Object.keys(MODULE_LABELS) as (keyof ModuleSettings)[];

    const items = keys.map(k => ({
      id: k,
      label: MODULE_LABELS[k],
      description: MODULE_DESCS[k],
      currentValue: modules[k] ? "on" : "off",
      values: ["on", "off"],
    }));

    this.addChild(new DynamicBorder(theme));

    this.settingsList = new SettingsList(
      items, 10, getSettingsListTheme(theme),
      (id: string, newValue: string) => {
        setModuleEnabled(id as keyof ModuleSettings, newValue === "on");
        tui.requestRender();
      },
      () => onDone(),
      { enableSearch: true },
    );

    this.addChild(this.settingsList);
    this.addChild(new DynamicBorder(theme));
  }

  handleInput(data: string) {
    this.settingsList.handleInput(data);
  }
}

function setupDpSettingsCommand(pi: ExtensionAPI) {
  pi.registerCommand("dp-settings", {
    description: "Toggle decorated-pi modules on/off",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        await ctx.ui.custom<void>(
          (tui, theme, _kb, done) =>
            new ModuleSettingsComponent(tui, theme, () => done(undefined))
        );
        ctx.ui.notify("Module settings updated. /reload to apply.", "info");
        return;
      }
      ctx.ui.notify("dp-settings requires interactive mode.", "warning");
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
  setupDpModelCommand(pi);
  setupDpSettingsCommand(pi);
  setupRetryCommand(pi);
}
