/**
 * Module Settings UI — used by /dp-settings command.
 *
 * Modules are grouped into three categories. The main view shows one
 * row per category; Enter opens a submenu listing the modules in that
 * category so the user can toggle each one.
 */

import type { Theme as PiTheme, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, type TUI, type SettingsListTheme, type SettingItem, type Component } from "@earendil-works/pi-tui";
import { getAllModuleSettings, setModuleEnabled, type ModuleSettings, getDependencyPath, setDependencyPath, isDontBother, setDontBother, getDependencyView, listDependencyViewNames } from "../settings.js";
import { listLspBinaryNames } from "../tools/lsp/servers.js";
import { listMcpBinaryNames } from "../tools/mcp/config.js";

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

type CategoryId = "commands" | "hooks" | "tools";

interface CategoryDef {
  label: string;
  description: string;
  modules: ModuleName[];
}

const CATEGORIES: Record<CategoryId, CategoryDef> = {
  commands: {
    label: "Commands",
    description: "Slash commands",
    modules: ["atOverride", "retry", "usage"],
  },
  hooks: {
    label: "Hooks",
    description: "Agent-loop event handlers",
    modules: ["rtk", "secretRedaction", "wakatime"],
  },
  tools: {
    label: "Tools",
    description: "LLM-callable tools",
    modules: ["ask", "lsp", "mcp", "patchOverrideEdit"],
  },
};

// Hard-coded display order, alphabetized by visible label. Dependencies is
// inserted between Commands and Hooks in ModuleSettingsComponent below.
const CATEGORY_ORDER: CategoryId[] = ["commands", "hooks", "tools"];

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

/** Submenu for configuring binary path overrides. Each row is a binary
 *  that decorated-pi looks up at startup; Enter opens an input dialog
 *  where the user can type an absolute path (or clear it). */
function dependencyDisplayValue(name: string): string {
  const view = getDependencyView(name);
  if (view.path) return view.path;
  if (view.resolvedPath) return view.resolvedPath;
  if (view.resolvedState === undefined) return view.dontBother ? "(not checked, silenced)" : "(not checked)";
  return view.dontBother ? "(not found, silenced)" : "(not found)";
}

class DependencyBinarySubmenu extends Container {
  private list: SettingsList;
  private name: string;
  private ui: ExtensionUIContext;

  constructor(name: string, theme: PiTheme, ui: ExtensionUIContext, done: (summary?: string) => void) {
    super();
    this.name = name;
    this.ui = ui;

    const items: SettingItem[] = [
      {
        id: "path",
        label: "Path override",
        description: "Enter to edit; empty to clear override",
        currentValue: dependencyDisplayValue(name),
        values: ["edit"],
      },
      {
        id: "dontBother",
        label: "dontBother",
        description: "Silence missing-dependency notification for this binary",
        currentValue: isDontBother(name) ? "on" : "off",
        values: ["off", "on"],
      },
    ];

    this.list = new SettingsList(
      items,
      10,
      getSettingsListTheme(theme),
      (id: string, newValue: string) => {
        if (id === "dontBother") {
          setDontBother(this.name, newValue === "on");
          this.list.updateValue("dontBother", newValue);
          this.list.updateValue("path", dependencyDisplayValue(this.name));
          return;
        }
        this.list.updateValue("path", dependencyDisplayValue(this.name));
        void this.promptForPath();
      },
      () => done(dependencyDisplayValue(this.name)),
    );
    this.addChild(this.list);
  }

  handleInput(data: string) {
    this.list.handleInput(data);
  }

  private async promptForPath(): Promise<void> {
    const current = getDependencyPath(this.name) ?? "";
    const input = await this.ui.input(
      `Path for ${this.name} (empty to clear)`,
      current || `/absolute/path/to/${this.name}`,
    );
    if (input === undefined) return;
    setDependencyPath(this.name, input.trim() === "" ? null : input.trim());
    this.list.updateValue("path", dependencyDisplayValue(this.name));
  }

  render(width: number): string[] {
    return this.list.render(width);
  }
}

class DependenciesSubmenu extends Container {
  private list: SettingsList;
  private binaryNames: string[];

  constructor(theme: PiTheme, ui: ExtensionUIContext, done: (summary?: string) => void) {
    super();
    // Builtins we know about plus entries already present in config/shadow.
    this.binaryNames = listDependencyViewNames([
      "rtk",
      "wakatime-cli",
      ...listLspBinaryNames(),
      ...listMcpBinaryNames(),
    ]);

    const items: SettingItem[] = this.binaryNames.map((name) => ({
      id: name,
      label: name,
      description: "Enter to configure path override and dontBother",
      currentValue: dependencyDisplayValue(name),
      submenu: (_currentValue, submenuDone) => new DependencyBinarySubmenu(name, theme, ui, submenuDone),
    }));

    this.list = new SettingsList(
      items,
      10,
      getSettingsListTheme(theme),
      () => {},
      () => done(summaryForDependencies()),
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

  constructor(tui: TUI, theme: PiTheme, ui: ExtensionUIContext, onDone: () => void) {
    super();
    const modules = getAllModuleSettings();

    const categoryItems: SettingItem[] = CATEGORY_ORDER.map((id) => ({
      id,
      label: CATEGORIES[id].label,
      description: CATEGORIES[id].description,
      currentValue: summaryFor(modules, CATEGORIES[id].modules),
      submenu: (_currentValue, done) => new CategorySubmenu(id, theme, done),
    }));

    // Dependencies is a separate top-level category — it doesn't fit
    // ModuleSettings' on/off toggle model. Insert it alphabetically between
    // Commands and Hooks.
    categoryItems.splice(1, 0, {
      id: "dependencies",
      label: "Dependencies",
      description: "Override binary paths (rtk, wakatime-cli, LSP/MCP servers)",
      currentValue: summaryForDependencies(),
      submenu: (_currentValue, done) => new DependenciesSubmenu(theme, ui, done),
    });

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

/** Count how many binaries have an explicit override. */
function summaryForDependencies(): string {
  // Builtins we know about: rtk, wakatime-cli, LSP servers, MCP servers.
  const known = listDependencyViewNames([
    "rtk",
    "wakatime-cli",
    ...listLspBinaryNames(),
    ...listMcpBinaryNames(),
  ]);
  const overridden = known.filter((n) => getDependencyPath(n) !== null).length;
  const silenced = known.filter((n) => isDontBother(n)).length;
  const parts: string[] = [];
  if (overridden) parts.push(`${overridden} overridden`);
  if (silenced) parts.push(`${silenced} silenced`);
  return parts.length ? parts.join(", ") : "default";
}
