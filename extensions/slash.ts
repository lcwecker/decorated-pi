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
import { getMcpStatus, refreshServerCache, updateConfigEnabled } from "./mcp/index.js";
import { toggleMcpServerEnabled } from "./mcp/builtin.js";
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
  safety: "Secret Redaction",
  lsp: "LSP",
  "smart-at": "@ overload",
  mcp: "MCP",
  wakatime: "WakaTime",
  "rtk": "RTK",
};

const MODULE_DESCS: Record<keyof ModuleSettings, string> = {
  patch: "Replace edit/write with patch tool (old_str/new_str replacement + overwrite)",
  safety: "Redact secrets from read / bash output before they enter model context",
  lsp: "Language server diagnostics, hover, definition, references, symbols, rename",
  "smart-at": "Project-aware file search replacing default autocomplete",
  mcp: "MCP client for context7 and exa (zero-config)",
  wakatime: "Send coding activity heartbeats to WakaTime",
  "rtk": "Rewrite bash through system RTK when available",
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
        ctx.ui.notify("Module settings updated. /reload to apply.", "warning");
        return;
      }
      ctx.ui.notify("dp-settings requires interactive mode.", "warning");
    },
  });
}

// ─── /mcp ──────────────────────────────────────────────────────────────────

class McpStatusComponent extends Container {
  private linesComponent: Text;
  private hintComponent: Text;
  private notifyComponent: Text;
  private tui: TUI;
  private theme: PiTheme;
  private done: () => void;
  private registry: any;
  private selected = 0;
  private servers: ReturnType<typeof getMcpStatus> = [];
  private notifyText = "";
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing = new Set<string>();
  private autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

  private cwd: string;

  constructor(tui: TUI, theme: PiTheme, registry: any, onDone: () => void, cwd: string) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.done = onDone;
    this.registry = registry;
    this.cwd = cwd;

    this.addChild(new DynamicBorder(theme));
    this.addChild(new Spacer(1));

    this.linesComponent = new Text("", 1, 0);
    this.addChild(this.linesComponent);

    this.addChild(new Spacer(1));

    this.notifyComponent = new Text("", 1, 0);
    this.addChild(this.notifyComponent);

    this.hintComponent = new Text("", 1, 0);
    this.addChild(this.hintComponent);

    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder(theme));

    this.updateServers();
    this.renderView();

    // Auto-refresh while any server is still connecting
    this.autoRefreshTimer = setInterval(() => {
      this.updateServers();
      this.renderView();
      const allSettled = this.servers.every((s) => s.state !== "connecting");
      if (allSettled && this.autoRefreshTimer) {
        clearInterval(this.autoRefreshTimer);
        this.autoRefreshTimer = null;
      }
    }, 500);
  }

  private updateServers() {
    this.servers = getMcpStatus();
    if (this.selected >= this.servers.length) {
      this.selected = Math.max(0, this.servers.length - 1);
    }
  }

  private renderView() {
    if (this.servers.length === 0) {
      this.linesComponent.setText("No MCP servers configured.");
      this.hintComponent.setText(this.theme.fg("dim", "q close"));
      this.tui.requestRender();
      return;
    }

    const lines: string[] = [`MCP servers (${this.servers.length}):`, ""];

    const namePad = Math.max(...this.servers.map((s) => s.name.length), 12);

    for (let i = 0; i < this.servers.length; i++) {
      const s = this.servers[i];
      const isSelected = i === this.selected;
      const isDisabled = s.state === "disabled";
      const cursor = isSelected ? this.theme.fg("accent", "→ ") : "  ";

      let statusIcon: string;
      let statusColor: (s: string) => string;
      if (s.state === "connected") {
        statusIcon = "🟢";
        statusColor = (str: string) => this.theme.fg("accent", str);
      } else if (s.state === "connecting") {
        statusIcon = "🟡";
        statusColor = (str: string) => this.theme.fg("warning", str);
      } else if (s.state === "disabled") {
        statusIcon = "⚪";
        statusColor = (str: string) => this.theme.fg("dim", str);
      } else {
        statusIcon = "🔴";
        statusColor = (str: string) => this.theme.fg("error", str);
      }

      const name = isDisabled
        ? this.theme.fg("dim", s.name)
        : isSelected
          ? this.theme.fg("accent", s.name)
          : s.name;
      const namePadding = " ".repeat(Math.max(0, namePad - s.name.length));
      const desc = s.description ? ` — ${s.description.slice(0, 50)}` : "";
      const descDim = isDisabled ? this.theme.fg("dim", desc) : desc;
      lines.push(
        `${cursor}${name}${namePadding}  ${statusIcon} ${statusColor(s.state)}${descDim}`
      );

      if (isSelected) {
        lines.push(`    ${this.theme.fg("dim", s.url)}`);
        if (s.error) {
          lines.push(`    ${this.theme.fg("error", `Error: ${s.error}`)}`);
        }
        if (s.tools.length > 0) {
          lines.push(`    ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}:`);
          for (const tool of s.tools.slice(0, 6)) {
            const td = tool.description
              ? ` — ${tool.description.slice(0, 55)}`
              : "";
            lines.push(`      ${tool.name}${td}`);
          }
          if (s.tools.length > 6) {
            lines.push(`      ... and ${s.tools.length - 6} more`);
          }
        }
        lines.push("");
      }
    }

    this.linesComponent.setText(lines.join("\n"));

    const s = this.servers[this.selected];
    const toggleHint = s?.state === "disabled" ? "space enable" : "space disable";
    const hintParts = ["↑↓ navigate", toggleHint, "r refresh", "q close"];
    this.hintComponent.setText(this.theme.fg("dim", hintParts.join(" | ")));
    this.notifyComponent.setText(
      this.notifyText ? this.theme.fg("warning", this.notifyText) : ""
    );

    this.tui.requestRender();
  }

  private showNotify(text: string) {
    this.notifyText = text;
    this.renderView();
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => {
      this.notifyText = "";
      this.renderView();
    }, 3000);
  }

  private clearNotify() {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    this.notifyText = "";
  }

  handleInput(data: string) {
    const kb = getKeybindings();

    // Navigation
    if (kb.matches(data, "tui.select.up")) {
      this.selected = Math.max(0, this.selected - 1);
      this.clearNotify();
      this.renderView();
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      this.selected = Math.min(this.servers.length - 1, this.selected + 1);
      this.clearNotify();
      this.renderView();
      return;
    }

    // Quit
    if (
      data === "q" ||
      data === "\r" ||
      data === "\n" ||
      kb.matches(data, "tui.select.cancel")
    ) {
      if (this.autoRefreshTimer) { clearInterval(this.autoRefreshTimer); this.autoRefreshTimer = null; }
      if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = null; }
      this.done();
      return;
    }

    if (this.servers.length === 0) return;
    const s = this.servers[this.selected];

    // Toggle enable/disable
    if (data === " ") {
      const scope = s.source === "project" ? "project" : "global";
      const newEnabled = s.state === "disabled";
      const ok = toggleMcpServerEnabled(s.name, newEnabled, scope, this.cwd || undefined);
      if (ok) {
        updateConfigEnabled(s.name, newEnabled);
      }
      this.showNotify(
        ok
          ? `${newEnabled ? "Enabled" : "Disabled"} "${s.name}". Use /reload to apply.`
          : `Failed to toggle "${s.name}".`
      );
      this.updateServers();
      this.renderView();
      return;
    }

    // Refresh cache (reconnect + update)
    if (data === "r" || data === "r") {
      if (this.refreshing.has(s.name)) return;
      this.refreshing.add(s.name);
      const targetName = s.name;
      const targetIndex = this.selected;
      this.showNotify(`Refreshing "${targetName}"...`);
      (async () => {
        const result = await refreshServerCache(targetName, this.registry);
        this.refreshing.delete(targetName);
        // Only update UI if user hasn't navigated away
        if (this.selected === targetIndex) {
          this.updateServers();
          this.renderView();
          this.showNotify(result.ok ? `Refreshed "${targetName}".` : `Refresh failed: ${result.error}`);
        }
      })();
      return;
    }


  }

  dispose() {
    if (this.autoRefreshTimer) { clearInterval(this.autoRefreshTimer); this.autoRefreshTimer = null; }
    if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = null; }
  }
}

function setupMcpCommand(pi: ExtensionAPI) {
  pi.registerCommand("mcp", {
    description: "Show active MCP servers and their tools",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        await ctx.ui.custom<void>(
          (tui, theme, _kb, done) => new McpStatusComponent(tui, theme, ctx.modelRegistry, () => done(undefined), ctx.cwd)
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
      pi.sendMessage(
        { customType: "retry-trigger", content: "Continue.", display: false },
        { triggerTurn: true }
      );
    },
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
