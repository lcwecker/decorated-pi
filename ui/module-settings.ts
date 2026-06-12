/**
 * Module Settings UI — used by /dp-settings command.
 * Lists all modules with on/off toggle.
 */

import type { ExtensionAPI, ExtensionContext, Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Spacer, Text, type TUI, type SettingsListTheme, type Component } from "@earendil-works/pi-tui";
import { getAllModuleSettings, setModuleEnabled, type ModuleSettings } from "../settings.js";

const MODULE_LABELS: Record<keyof ModuleSettings, string> = {
  patch: "patch",
  safety: "Secret Redaction",
  lsp: "LSP",
  "smart-at": "@ overload",
  mcp: "MCP",
  wakatime: "WakaTime",
  "rtk": "RTK",
  "codegraph": "Codegraph",
  ask: "Ask",
  todo: "Todo",
};

const MODULE_DESCS: Record<keyof ModuleSettings, string> = {
  patch: "Replace edit/write with patch tool (targeted string replacement)",
  safety: "Redact secrets from read / bash output before they enter model context",
  lsp: "Language server diagnostics, hover, definition, references, symbols, rename",
  "smart-at": "Project-aware file search replacing default autocomplete",
  mcp: "MCP client for context7 and exa (zero-config)",
  wakatime: "Send coding activity heartbeats to WakaTime",
  "rtk": "Rewrite bash through system RTK when available",
  "codegraph": "Codegraph MCP server for code structure queries",
  ask: "Interactive ask tool for user clarification (blocks loop until answered)",
  todo: "Session todo list management tool",
};

class DynamicBorder implements Component {
  private colorFn: (str: string) => string;
  constructor(theme: PiTheme) { this.colorFn = (str: string) => theme.fg("border", str); }
  invalidate() {}
  render(width: number): string[] { return [this.colorFn("─".repeat(Math.max(1, width)))]; }
}

function getSettingsListTheme(theme: PiTheme): SettingsListTheme {
  return {
    label: (text: string, selected: boolean) => selected ? theme.fg("accent", text) : text,
    value: (text: string, selected: boolean) => selected ? theme.fg("accent", text) : theme.fg("muted", text),
    description: (text: string) => theme.fg("dim", text),
    cursor: theme.fg("accent", "→ "),
    hint: (text: string) => theme.fg("dim", text),
  };
}

export class ModuleSettingsComponent extends Container {
  private settingsList: SettingsList;

  constructor(tui: TUI, theme: PiTheme, onDone: () => void) {
    super();
    const modules = getAllModuleSettings();
    const keys = Object.keys(MODULE_LABELS) as (keyof ModuleSettings)[];
    const items = keys.filter(k => modules[k] !== undefined).map(k => ({
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
