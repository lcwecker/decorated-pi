/**
 * Module Settings UI — used by /dp-settings command.
 *
 * Modules are grouped into three categories. The main view shows one
 * row per category; Enter opens a submenu listing the modules in that
 * category so the user can toggle each one.
 */

import type { Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, type TUI, type SettingsListTheme, type SettingItem, type Component } from "@earendil-works/pi-tui";
import { getAllModuleSettings, setModuleEnabled, type ModuleSettings } from "../settings.js";

type ModuleName =
  | "patchOverrideEdit"
  | "secretRedaction"
  | "lsp"
  | "atOverride"
  | "mcp"
  | "wakatime"
  | "rtk"
  | "ask"
  | "retry"
  | "usage";

const MODULE_LABELS: Record<ModuleName, string> = {
  patchOverrideEdit: "patchOverrideEdit",
  secretRedaction: "secretRedaction",
  lsp: "LSP",
  atOverride: "@ overload",
  mcp: "MCP",
  wakatime: "WakaTime",
  "rtk": "RTK",
  ask: "Ask",
  retry: "Retry",
  usage: "Usage",
};

const MODULE_DESCS: Record<ModuleName, string> = {
  patchOverrideEdit: "Replace Pi native edit/write with patch tool (targeted string replacement)",
  secretRedaction: "Redact secrets from read / bash output before they enter model context",
  lsp: "Language server diagnostics, hover, definition, references, symbols, rename",
  atOverride: "Project-aware file search replacing default autocomplete",
  mcp: "MCP client with builtin servers (context7, exa, codegraph)",
  wakatime: "Send coding activity heartbeats to WakaTime",
  "rtk": "Rewrite bash through system RTK when available",
  ask: "Interactive ask tool for user clarification (blocks loop until answered)",
  retry: "/retry command to continue after interruption",
  usage: "/usage command for token stats",
};

type CategoryId = "tools" | "hooks" | "commands";

interface CategoryDef {
  label: string;
  description: string;
  modules: ModuleName[];
}

const CATEGORIES: Record<CategoryId, CategoryDef> = {
  tools: {
    label: "Tools",
    description: "LLM-callable tools",
    modules: ["patchOverrideEdit", "ask", "lsp", "mcp"],
  },
  hooks: {
    label: "Hooks",
    description: "Agent-loop event handlers",
    modules: ["secretRedaction", "rtk", "wakatime"],
  },
  commands: {
    label: "Commands",
    description: "Slash commands",
    modules: ["atOverride", "retry", "usage"],
  },
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

const MODULE_TO_CATEGORY: Record<ModuleName, CategoryId> = {
  patchOverrideEdit: "tools",
  ask: "tools",
  lsp: "tools",
  mcp: "tools",
  secretRedaction: "hooks",
  "rtk": "hooks",
  wakatime: "hooks",
  atOverride: "commands",
  retry: "commands",
  usage: "commands",
};

function summaryFor(modules: Required<ModuleSettings>, ids: ModuleName[]): string {
  const onCount = ids.reduce((sum, id) => {
    const cat = MODULE_TO_CATEGORY[id];
    return sum + ((modules[cat] as Record<string, boolean>)[id] ? 1 : 0);
  }, 0);
  return `${onCount}/${ids.length} on`;
}

class CategorySubmenu extends Container {
  private list: SettingsList;

  constructor(categoryId: CategoryId, theme: PiTheme, done: (summary?: string) => void) {
    super();
    const modules = getAllModuleSettings();
    const category = CATEGORIES[categoryId];

    const items: SettingItem[] = category.modules.map((id) => ({
      id,
      label: MODULE_LABELS[id],
      description: MODULE_DESCS[id],
      currentValue: (modules[MODULE_TO_CATEGORY[id]] as Record<string, boolean>)[id] ? "on" : "off",
      values: ["on", "off"],
    }));

    this.list = new SettingsList(
      items,
      10,
      getSettingsListTheme(theme),
      (id: string, newValue: string) => {
        setModuleEnabled(id, newValue === "on");
        this.list.updateValue(id, newValue);
        // Stay open so the user can toggle multiple items; the parent
        // summary updates when the submenu is closed with Esc.
      },
      () => done(summaryFor(getAllModuleSettings(), category.modules)),
    );
    this.addChild(this.list);
  }

  handleInput(data: string) {
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    return this.list.render(width);
  }
}

export class ModuleSettingsComponent extends Container {
  private settingsList: SettingsList;

  constructor(tui: TUI, theme: PiTheme, onDone: () => void) {
    super();
    const modules = getAllModuleSettings();

    const categoryItems: SettingItem[] = (Object.keys(CATEGORIES) as CategoryId[]).map((id) => ({
      id,
      label: CATEGORIES[id].label,
      description: CATEGORIES[id].description,
      currentValue: summaryFor(modules, CATEGORIES[id].modules),
      submenu: (_currentValue, done) => new CategorySubmenu(id, theme, done),
    }));

    this.addChild(new DynamicBorder(theme));

    this.settingsList = new SettingsList(
      categoryItems,
      10,
      getSettingsListTheme(theme),
      () => {},
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
