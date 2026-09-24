/**
 * Module Settings UI — used by /dp-settings command.
 *
 * Modules are grouped into three categories. The main view shows one
 * row per category; Enter opens a submenu listing the modules in that
 * category so the user can toggle each one.
 */

import type { Theme as PiTheme, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, type TUI, type SettingsListTheme, type SettingItem, type Component } from "@earendil-works/pi-tui";
import { getAllModuleSettings, setModuleEnabled, isModuleEnabled, type ModuleSettings, getDependencyPath, setDependencyPath, isDontBother, setDontBother, getDependencyView, listDependencyViewNames, getAskWho, setAskWho, getTypesafeApiKey, setTypesafeApiKey } from "../settings.js";
import { listLspBinaryNames } from "../tools/lsp/servers.js";
import { listMcpBinaryNames } from "../tools/mcp/config.js";

type ModuleName =
  | "patchOverrideEdit"
  | "lsp"
  | "mcp"
  | "websearch"
  | "webFetch"
  | "wakatime"
  | "tps"
  | "ask"
  | "retry"
  | "usage";

const MODULE_LABELS: Record<ModuleName, string> = {
  patchOverrideEdit: "patchOverrideEdit",
  lsp: "LSP",
  mcp: "MCP",
  websearch: "Web search",
  webFetch: "Web fetch",
  wakatime: "WakaTime",
  tps: "TPS",
  ask: "Ask",
  retry: "Retry",
  usage: "Usage",
};

const MODULE_DESCS: Record<ModuleName, string> = {
  patchOverrideEdit: "Replace Pi native edit/write with patch tool (targeted string replacement)",
  lsp: "Language server diagnostics, hover, definition, references, symbols, rename",
  mcp: "MCP client with builtin servers (context7, codegraph)",
  websearch: "Keyless web search over AnySearch, Exa and Parallel, with automatic fallback",
  webFetch: "Read a URL as markdown/text/HTML — locally first, rendering backend on failure",
  wakatime: "Send coding activity heartbeats to WakaTime",
  tps: "Show live output tokens-per-second in the footer status bar",
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
    modules: ["retry", "usage"],
  },
  hooks: {
    label: "Hooks",
    description: "Agent-loop event handlers",
    modules: ["wakatime", "tps"],
  },
  tools: {
    label: "Tools",
    description: "LLM-callable tools",
    modules: ["ask", "lsp", "mcp", "patchOverrideEdit", "webFetch", "websearch"],
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
  websearch: "tools",
  webFetch: "tools",
  wakatime: "hooks",
  tps: "hooks",
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

/** Row text for a module that has its own submenu — the on/off state alone
 *  would hide what it is currently set to. Reads settings live: the row is
 *  redrawn from the summary the submenu hands back. */
function moduleSummary(id: ModuleName): string {
  const modules = getAllModuleSettings();
  const enabled = (modules[MODULE_TO_CATEGORY[id]] as Record<string, boolean>)[id] ? "on" : "off";
  if (id !== "ask") return enabled;
  const key = getTypesafeApiKey() ? "" : " · no key";
  return `${enabled} · ${getAskWho()}${key}`;
}

/** Never print the key itself: it is a secret and this row is a screenshot risk. */
function maskedKey(): string {
  const key = getTypesafeApiKey();
  if (!key) return "(not set)";
  if (process.env.TYPESAFE_API_KEY?.trim()) return "(from TYPESAFE_API_KEY)";
  return key.length <= 12 ? "••••••" : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** Options for the `ask` tool. It gets its own submenu because the answering
 *  mode and the API key are not on/off values, and switching the mode needs no
 *  /reload: `ask` reads the setting on every call. */
class AskSubmenu extends Container {
  private list: SettingsList;
  private ui: ExtensionUIContext;

  constructor(theme: PiTheme, ui: ExtensionUIContext, done: (summary?: string) => void) {
    super();
    this.ui = ui;

    const items: SettingItem[] = [
      {
        id: "enabled",
        label: "Enabled",
        description: "Register the ask tool",
        currentValue: isModuleEnabled("ask") ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "who",
        label: "Who answers",
        description: "me = the wizard in this terminal; jev = answered from the context passed to ask. Applies to the next call.",
        currentValue: getAskWho(),
        values: ["me", "jev"],
      },
      {
        id: "key",
        label: "TypeSafe API key",
        description: "Enter to set, empty to clear. Stored in decorated-pi.json in plain text; TYPESAFE_API_KEY overrides it.",
        currentValue: maskedKey(),
        values: ["edit"],
      },
    ];

    this.list = new SettingsList(
      items,
      10,
      getSettingsListTheme(theme),
      (id: string, newValue: string) => {
        if (id === "enabled") {
          setModuleEnabled("ask", newValue === "on");
          this.list.updateValue("enabled", newValue);
          return;
        }
        if (id === "who") {
          setAskWho(newValue === "jev" ? "jev" : "me");
          this.list.updateValue("who", newValue);
          this.list.updateValue("key", maskedKey());
          return;
        }
        void this.promptForKey();
      },
      () => done(moduleSummary("ask")),
    );
    this.addChild(this.list);
  }

  private async promptForKey(): Promise<void> {
    const input = await this.ui.input("TypeSafe API key (empty to clear)", "as_sk_…");
    if (input === undefined) return;
    setTypesafeApiKey(input);
    this.list.updateValue("key", maskedKey());
  }

  handleInput(data: string) {
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    return this.list.render(width);
  }
}

/** Modules whose settings do not fit an on/off row. */
const MODULE_SUBMENUS: Partial<
  Record<ModuleName, (theme: PiTheme, ui: ExtensionUIContext, done: (summary?: string) => void) => Component>
> = {
  ask: (theme, ui, done) => new AskSubmenu(theme, ui, done),
};

class CategorySubmenu extends Container {
  private list: SettingsList;

  constructor(categoryId: CategoryId, theme: PiTheme, ui: ExtensionUIContext, done: (summary?: string) => void) {
    super();
    const modules = getAllModuleSettings();
    const category = CATEGORIES[categoryId];

    // A module with its own options opens a submenu instead of toggling: the
    // row for `ask` carries the answering mode and its key, neither of which
    // fits an on/off value.
    const items: SettingItem[] = category.modules.map((id) => {
      const submenu = MODULE_SUBMENUS[id];
      if (submenu) {
        return {
          id,
          label: MODULE_LABELS[id],
          description: MODULE_DESCS[id],
          currentValue: moduleSummary(id),
          submenu: (_currentValue, submenuDone) => submenu(theme, ui, submenuDone),
        };
      }
      return {
        id,
        label: MODULE_LABELS[id],
        description: MODULE_DESCS[id],
        currentValue: (modules[MODULE_TO_CATEGORY[id]] as Record<string, boolean>)[id] ? "on" : "off",
        values: ["on", "off"],
      };
    });

    this.list = new SettingsList(
      items,
      10,
      getSettingsListTheme(theme),
      (id: string, newValue: string) => {
        // A submenu row reports its summary through this callback when the
        // submenu closes, and a summary is not an on/off value: writing the
        // module state from it switched the module off on every visit. State
        // for those rows belongs to the submenu that owns them.
        if (MODULE_SUBMENUS[id as ModuleName]) {
          this.list.updateValue(id, newValue);
          return;
        }
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
      submenu: (_currentValue, done) => new CategorySubmenu(id, theme, ui, done),
    }));

    // Dependencies is a separate top-level category — it doesn't fit
    // ModuleSettings' on/off toggle model. Insert it alphabetically between
    // Commands and Hooks.
    categoryItems.splice(1, 0, {
      id: "dependencies",
      label: "Dependencies",
      description: "Override binary paths (wakatime-cli, LSP/MCP servers)",
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
  // Builtins we know about: wakatime-cli, LSP servers, MCP servers.
  const known = listDependencyViewNames([
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
