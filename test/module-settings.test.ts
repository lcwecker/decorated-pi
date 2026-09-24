/**
 * /dp-settings module list — the Tools submenu and the `ask` submenu.
 *
 * Driven through the real `SettingsList` widget with its real keybindings,
 * because the behaviour under test lives in that widget's contract: a submenu's
 * closing summary is reported to the parent through the same `onChange`
 * callback that plain rows use to cycle values, so a parent that writes module
 * state from it turns the module off on every visit.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, setKeybindings } from "@earendil-works/pi-tui";
import { ModuleSettingsComponent } from "../ui/module-settings.js";
import { isModuleEnabled, setModuleEnabled, setAskWho, setTypesafeApiKey, getAskWho, setDependencyPath } from "../settings.js";

// ─── Harness ─────────────────────────────────────────────────────────────────

const ENTER = "\r";
const ESCAPE = "\x1b";
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

async function openAskSubmenu(): Promise<any> {
  const component = new ModuleSettingsComponent({} as any, theme, makeUi(), () => {});
  // Top-level order is Commands, Dependencies, Hooks, Tools.
  walk(component, [DOWN, DOWN, DOWN, ENTER]);
  // Tools → first module is `ask`.
  walk(component, [ENTER]);
  return component;
}

/** The developer's shell may export a real key; the suite must not see it. */
let envKey: string | undefined;

beforeEach(() => {
  initTheme(undefined, false);
  setKeybindings(keybindings());
  setModuleEnabled("ask", true);
  setAskWho("me");
  setTypesafeApiKey(null);
  setDependencyPath("wakatime-cli", null);
  envKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
});

afterEach(() => {
  setKeybindings(keybindings());
  if (envKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = envKey;
});

// ═════════════════════════════════════════════════════════════════════════════
// Tools submenu
// ═════════════════════════════════════════════════════════════════════════════

describe("Tools submenu — ask row", () => {
  it("opens a submenu instead of toggling the module off", async () => {
    const component = await openAskSubmenu();
    expect(component.render(80).join("\n")).toContain("Who answers");
    expect(isModuleEnabled("ask")).toBe(true);
  });

  it("survives leaving the submenu", async () => {
    // Regression: the closing summary (\"on · me · no key\") used to be written
    // through the parent's on/off handler, which turned ask off.
    const component = await openAskSubmenu();
    walk(component, [ESCAPE]);
    expect(isModuleEnabled("ask")).toBe(true);
  });

  it("shows the answering mode on the Tools row", async () => {
    const component = new ModuleSettingsComponent({} as any, theme, makeUi(), () => {});
    const tools = walk(component, [DOWN, DOWN, DOWN, ENTER]);
    expect(tools).toContain("on · me");

    setAskWho("jev");
    setTypesafeApiKey("as_sk_1234567890abcdef");
    const refreshed = new ModuleSettingsComponent({} as any, theme, makeUi(), () => {});
    expect(walk(refreshed, [DOWN, DOWN, DOWN, ENTER])).toContain("on · jev");
  });

  it("still toggles plain modules from the same list", async () => {
    const component = new ModuleSettingsComponent({} as any, theme, makeUi(), () => {});
    walk(component, [DOWN, DOWN, DOWN, ENTER]);
    // Tools rows: ask, lsp, mcp, patchOverrideEdit, webFetch, websearch.
    walk(component, [DOWN, ENTER]);
    expect(isModuleEnabled("lsp")).toBe(false);
    expect(isModuleEnabled("ask")).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Ask submenu
// ═════════════════════════════════════════════════════════════════════════════

describe("Ask submenu", () => {
  it("switches who answers", async () => {
    const component = await openAskSubmenu();
    walk(component, [DOWN, ENTER]); // Who answers: me → jev
    expect(getAskWho()).toBe("jev");

    walk(component, [ENTER]); // jev → me
    expect(getAskWho()).toBe("me");
  });

  it("toggles the module from inside the submenu", async () => {
    const component = await openAskSubmenu();
    walk(component, [ENTER]); // Enabled: on → off
    expect(isModuleEnabled("ask")).toBe(false);
  });

  it("masks the key and never prints it", async () => {
    setTypesafeApiKey("as_sk_1234567890abcdef");
    const component = await openAskSubmenu();
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("as_sk_");
    expect(rendered).not.toContain("1234567890abcdef");
  });

  it("says when the key comes from the environment", async () => {
    process.env.TYPESAFE_API_KEY = "as_sk_from_env_000000";
    const component = await openAskSubmenu();
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("from TYPESAFE_API_KEY");
    expect(rendered).not.toContain("from_env_000000");
  });
});
