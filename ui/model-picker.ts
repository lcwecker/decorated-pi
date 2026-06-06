/**
 * Model Picker — used by /dp-model command.
 * Tab between Image and Compact model selection.
 */

import { DynamicBorder, keyHint, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, getKeybindings, Input, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";
import { getImageModelKey, getCompactModelKey, setImageModelKey, setCompactModelKey, formatModelKey, parseModelKey } from "../settings.js";

const TAB_IMAGE = 0;
const TAB_COMPACT = 1;

export class ModelPickerComponent extends Container {
  private searchInput: Input;
  private tui: TUI;
  private theme: Theme;
  private registry: any;
  private onDone: () => void;
  private activeTab = TAB_IMAGE;
  private imageKey: string | null;
  private compactKey: string | null;
  private allItems: { label: string; desc: string; model: Model<any> | null; modelName?: string }[] = [];
  private filtered: typeof this.allItems = [];
  private selectedIndex = 0;
  private tabTitle = new Text("", 1, 0);
  private subtitleText: Text;
  private listContainer: Container;

  constructor(tui: TUI, theme: unknown, registry: any, onDone: () => void) {
    super();
    this.tui = tui;
    this.theme = theme as Theme;
    this.registry = registry;
    this.onDone = onDone;
    this.imageKey = getImageModelKey();
    this.compactKey = getCompactModelKey();

    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(this.tabTitle);
    this.subtitleText = new Text("", 1, 0);
    this.addChild(this.subtitleText);
    this.addChild(new Spacer(1));

    this.searchInput = new Input();
    this.searchInput.onSubmit = () => { const s = this.filtered[this.selectedIndex]; if (s) this.selectModel(s.model); };
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));

    this.addChild(new Text(
      rawKeyHint("↑↓", "navigate") + "  " + keyHint("tui.input.tab", "switch") + "  " +
      keyHint("tui.select.confirm", "select") + "  " + keyHint("tui.select.cancel", "cancel"), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());

    this.loadModels().then(() => { this.switchTab(TAB_IMAGE); this.tui.requestRender(); });
  }

  private async loadModels() {
    this.registry.refresh();
    const available = this.registry.getAvailable() as Model<any>[];
    this.allItems = [{ label: "clear", desc: "(unset)", model: null }];
    for (const m of available) {
      this.allItems.push({ label: m.id, desc: `[${m.provider}]`, model: m as Model<any>, modelName: m.name });
    }
  }

  private currentKey() { return this.activeTab === TAB_IMAGE ? this.imageKey : this.compactKey; }
  private currentKind() { return this.activeTab === TAB_IMAGE ? "image" : "compact"; }

  private switchTab(tab: number) {
    this.activeTab = tab;
    const key = this.currentKey();
    const [clearItem, ...rest] = this.allItems;
    const items = rest.map(it => {
      const isCurrent = it.model && formatModelKey(it.model) === key;
      return { ...it, desc: `${it.desc}${isCurrent ? " ✓" : ""}` };
    });
    items.sort((a, b) => {
      const aCur = a.model && formatModelKey(a.model) === key;
      const bCur = b.model && formatModelKey(b.model) === key;
      if (aCur && !bCur) return -1; if (!aCur && bCur) return 1; return 0;
    });
    this.filtered = [clearItem, ...items];
    this.selectedIndex = 0;
    if (key) { const ix = this.filtered.findIndex(m => m.model && formatModelKey(m.model) === key); if (ix >= 0) this.selectedIndex = ix; }
    this.searchInput.setValue("");
    this.updateHeader();
    this.updateList();
  }

  private updateHeader() {
    const t = this.theme;
    const im = this.activeTab === TAB_IMAGE ? t.fg("accent", "●") : "○";
    const cm = this.activeTab === TAB_COMPACT ? t.fg("accent", "●") : "○";
    const il = this.activeTab === TAB_IMAGE ? t.bold("Image") : t.fg("dim", "Image");
    const cl = this.activeTab === TAB_COMPACT ? t.bold("Compact") : t.fg("dim", "Compact");
    this.tabTitle.setText(`${im} ${il}  |  ${cm} ${cl}`);
    const key = this.currentKey();
    this.subtitleText.setText(key ? t.fg("warning", `Current ${this.currentKind()} model: ${key}`) : t.fg("warning", `No ${this.currentKind()} model set`));
  }

  handleInput(keyData: string) {
    const kb = getKeybindings();
    if (kb.matches(keyData, "tui.input.tab")) {
      const next = this.activeTab === TAB_IMAGE ? TAB_COMPACT : TAB_IMAGE;
      this.switchTab(next); this.tui.requestRender(); return;
    }
    if (kb.matches(keyData, "tui.select.up")) { this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1; this.updateList(); return; }
    if (kb.matches(keyData, "tui.select.down")) { this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1; this.updateList(); return; }
    if (kb.matches(keyData, "tui.select.confirm")) { const s = this.filtered[this.selectedIndex]; if (s) this.selectModel(s.model); return; }
    if (kb.matches(keyData, "tui.select.cancel")) { this.onDone(); return; }
    this.searchInput.handleInput(keyData); this.applyFilter();
  }

  private applyFilter() {
    const raw = this.searchInput.getValue();
    if (!raw) { this.switchTab(this.activeTab); return; }
    const [clearItem, ...rest] = this.filtered;
    this.filtered = [clearItem, ...fuzzyFilter(rest, raw, ({ label, desc }) => `${label} ${desc}`)];
    this.selectedIndex = 0; this.updateList();
  }

  private selectModel(model: Model<any> | null) {
    const kind = this.currentKind();
    if (model) {
      if (kind === "image") setImageModelKey(formatModelKey(model));
      else setCompactModelKey(formatModelKey(model));
    } else {
      if (kind === "image") setImageModelKey(null);
      else setCompactModelKey(null);
    }
    if (kind === "image") this.imageKey = model ? formatModelKey(model) : null;
    else this.compactKey = model ? formatModelKey(model) : null;
    this.switchTab(this.activeTab); this.tui.requestRender();
  }

  private updateList() {
    this.listContainer.clear();
    const t = this.theme;
    const mv = 10;
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(mv / 2), Math.max(0, this.filtered.length - mv)));
    const end = Math.min(start + mv, this.filtered.length);
    for (let i = start; i < end; i++) {
      const item = this.filtered[i]; if (!item) continue;
      const isClear = item.model === null;
      const isSel = i === this.selectedIndex;
      const line = isClear
        ? (isSel ? t.fg("accent", "→ ") + t.fg("error", "clear") + t.fg("muted", "  (unset)") : "  " + t.fg("muted", "clear  (unset)"))
        : (isSel ? t.fg("accent", "→ ") + t.fg("accent", item.label) + " " + t.fg("muted", item.desc) : "  " + item.label + " " + t.fg("muted", item.desc));
      this.listContainer.addChild(new Text(line, 0, 0));
    }
    if (start > 0 || end < this.filtered.length) this.listContainer.addChild(new Text(t.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 0, 0));
    const sel = this.filtered[this.selectedIndex];
    if (sel?.modelName) { this.listContainer.addChild(new Spacer(1)); this.listContainer.addChild(new Text(t.fg("muted", `  Name: ${sel.modelName}`), 0, 0)); }
  }
}
