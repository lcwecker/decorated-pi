/**
 * /dp-settings module list — the Tools submenu.
 *
 * Driven through the real `SettingsList` widget with its real keybindings,
 * because the behaviour under test lives in that widget's contract: Enter on a
 * row cycles its value and reports it through the parent's `onChange`, which is
 * what writes the module state.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, setKeybindings } from "@earendil-works/pi-tui";
import { ModuleSettingsComponent } from "../ui/module-settings.js";
import { isModuleEnabled, setModuleEnabled, setDependencyPath } from "../settings.js";

// ─── Harness ─────────────────────────────────────────────────────────────────

const ENTER = "\r";
const DOWN = "\x1b[B";

/** Only the theme surface the settings UI touches. */
const theme = {
  fg: (_key: string, text: string) => text,
  bold: (text: string) => text,
} as any;

/** SettingsList reads keybindings from a module-level singleton. */
const keybindings = () => new KeybindingsManager(TUI_KEYBINDINGS);

function makeUi() {
  return { input: async () => undefined, notify: () => {} } as any;
}

function walk(component: any, keys: string[]) {
  for (const key of keys) component.handleInput(key);
  return component.render(80).join("\n");
}

beforeEach(() => {
  initTheme(undefined, false);
  setKeybindings(keybindings());
  setModuleEnabled("ask", true);
  setDependencyPath("wakatime-cli", null);
});

afterEach(() => {
  setKeybindings(keybindings());
});

// ═════════════════════════════════════════════════════════════════════════════
// Tools submenu
// ═════════════════════════════════════════════════════════════════════════════

describe("Tools submenu — module rows", () => {
  it("toggles the ask module like any other row", () => {
    const component = new ModuleSettingsComponent({} as any, theme, makeUi(), () => {});
    walk(component, [DOWN, DOWN, DOWN, ENTER]); // Tools
    expect(isModuleEnabled("ask")).toBe(true);

    walk(component, [ENTER]); // ask: on → off
    expect(isModuleEnabled("ask")).toBe(false);

    walk(component, [ENTER]); // ask: off → on
    expect(isModuleEnabled("ask")).toBe(true);
  });

  it("still toggles plain modules from the same list", () => {
    const component = new ModuleSettingsComponent({} as any, theme, makeUi(), () => {});
    walk(component, [DOWN, DOWN, DOWN, ENTER]);
    // Tools rows: ask, lsp, mcp, patchOverrideEdit, webFetch, websearch.
    walk(component, [DOWN, ENTER]);
    expect(isModuleEnabled("lsp")).toBe(false);
    expect(isModuleEnabled("ask")).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Dependencies submenu
// ═════════════════════════════════════════════════════════════════════════════

describe("Dependencies submenu", () => {
  it("lists every builtin the pack looks up, poppler included", () => {
    const component = new ModuleSettingsComponent({} as any, theme, makeUi(), () => {});
    walk(component, [DOWN, ENTER]); // Commands → Dependencies

    // The list shows ten rows at a time, so walk the whole thing.
    let seen = "";
    for (let step = 0; step < 30; step++) seen += walk(component, [DOWN]);

    expect(seen).toContain("wakatime-cli");
    expect(seen).toContain("codegraph");
    expect(seen).toContain("pdfinfo");
    expect(seen).toContain("pdftoppm");
  });
});
