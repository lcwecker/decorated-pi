/**
 * Slash — 所有扩展命令
 *
 * /dp-model    → 模型选择器 (TAB 切换 Image/Compact)
 * /dp-settings → 模块开关 (patch / safety / lsp / smart-at)
 * /retry       → 中断后继续
 */

import type { ExtensionAPI, ExtensionContext, Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import { ModelPickerComponent } from "./model-integration.js";
import { getAllModuleSettings, setModuleEnabled, type ModuleSettings } from "./settings.js";
import { getMcpStatus } from "./mcp/index.js";
import { Container, SettingsList, Spacer, Text, type TUI, type SettingsListTheme, type Component, getKeybindings } from "@earendil-works/pi-tui";

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
  patch: "patch",
  safety: "Safety Layer",
  lsp: "LSP",
  "smart-at": "@ overload",
  mcp: "MCP",
};

const MODULE_DESCS: Record<keyof ModuleSettings, string> = {
  patch: "Replace edit/write with patch tool (old_str/new_str replacement + overwrite)",
  safety: "Command guard, protected paths, read guard, secret redaction",
  lsp: "Language server diagnostics, hover, definition, references, symbols, rename",
  "smart-at": "Project-aware file search replacing default autocomplete",
  mcp: "MCP client for context7 and exa (zero-config)",
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

// ─── /mcp ──────────────────────────────────────────────────────────────────

class McpStatusComponent extends Container {
  private textComponent: Text;
  private tui: TUI;
  private theme: PiTheme;
  private done: () => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(tui: TUI, theme: PiTheme, onDone: () => void) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.done = onDone;

    this.addChild(new DynamicBorder(theme));
    this.addChild(new Spacer(1));

    this.textComponent = new Text("", 1, 0);
    this.addChild(this.textComponent);

    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg("dim", "Press q to close."), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder(theme));

    this.refresh();

    this.timer = setInterval(() => {
      this.refresh();
      const allSettled = getMcpStatus().every((s) => s.state !== "connecting");
      if (allSettled && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, 500);
  }

  private refresh() {
    const servers = getMcpStatus();

    if (servers.length === 0) {
      this.textComponent.setText("No MCP servers configured.");
      this.tui.requestRender();
      return;
    }

    const connected = servers.filter((s) => s.state === "connected");
    const connecting = servers.filter((s) => s.state === "connecting");
    const failed = servers.filter((s) => s.state === "failed");

    const lines: string[] = [
      `MCP servers (${servers.length}):`,
      "",
    ];

    for (const s of connected) {
      lines.push(this.theme.fg("accent", `• ${s.name}`) + ` (${s.source})`);
      lines.push(`  URL: ${s.url}`);
      lines.push(`  Tools: ${s.toolCount}`);
      for (const tool of s.tools) {
        const desc = tool.description ? ` — ${tool.description.slice(0, 60)}` : "";
        lines.push(`    - ${tool.name}${desc}`);
      }
      lines.push("");
    }

    for (const s of connecting) {
      lines.push(this.theme.fg("accent", `• ${s.name}`) + ` (${s.source})`);
      lines.push(`  URL: ${s.url}`);
      lines.push(`  Status: ${this.theme.fg("warning", "connecting...")}`);
      lines.push("");
    }

    for (const s of failed) {
      lines.push(this.theme.fg("accent", `• ${s.name}`) + ` (${s.source})`);
      lines.push(`  URL: ${s.url}`);
      lines.push(`  Status: ${this.theme.fg("error", "failed")} — ${s.error ?? "unknown error"}`);
      lines.push("");
    }

    this.textComponent.setText(lines.join("\n"));
    this.tui.requestRender();
  }

  handleInput(data: string) {
    const kb = getKeybindings();
    if (
      data === "q" ||
      data === "\r" ||
      data === "\n" ||
      kb.matches(data, "tui.select.cancel")
    ) {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.done();
    }
  }

  dispose() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function setupMcpCommand(pi: ExtensionAPI) {
  pi.registerCommand("mcp", {
    description: "Show active MCP servers and their tools",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        await ctx.ui.custom<void>(
          (tui, theme, _kb, done) => new McpStatusComponent(tui, theme, () => done(undefined))
        );
        return;
      }

      // Fallback for non-interactive (print / RPC) mode.
      const servers = getMcpStatus();
      if (servers.length === 0) {
        ctx.ui.notify("No MCP servers configured.", "info");
        return;
      }

      const lines: string[] = [`MCP servers (${servers.length}):`, ""];
      for (const s of servers) {
        lines.push(`• ${s.name} (${s.source})`);
        lines.push(`  URL: ${s.url}`);
        if (s.state === "connecting") {
          lines.push(`  Status: connecting...`);
        } else if (s.state === "failed") {
          lines.push(`  Status: failed — ${s.error ?? "unknown error"}`);
        } else {
          lines.push(`  Tools: ${s.toolCount}`);
          for (const tool of s.tools) {
            const desc = tool.description ? ` — ${tool.description.slice(0, 60)}` : "";
            lines.push(`    - ${tool.name}${desc}`);
          }
        }
        lines.push("");
      }

      pi.sendMessage({ customType: "mcp-status", content: lines.join("\n"), display: true }, { triggerTurn: false });
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
  setupMcpCommand(pi);
  setupRetryCommand(pi);
}
