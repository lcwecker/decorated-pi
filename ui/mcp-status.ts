/**
 * MCP Status UI — used by /mcp command.
 *
 * Pure presentation: receives callbacks for read/toggle/refresh, knows
 * nothing about the hook layer or config persistence. The caller (in
 * commands/mcp-status.ts) wires up the concrete hook-layer functions.
 */

import type { Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type TUI, type Component, getKeybindings } from "@earendil-works/pi-tui";

// ─── Public types ──────────────────────────────────────────────────────────

/** Status reported by the read() callback. UI doesn't care where it comes from. */
export type McpServerState = "connecting" | "connected" | "failed" | "disabled" | "waiting reload";

export interface McpServerView {
  name: string;
  url: string;
  source: string;
  state: McpServerState;
  toolCount: number;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  description?: string;
  error?: string;
}

/** Result of a refresh attempt. */
export interface McpRefreshResult {
  ok: boolean;
  error?: string;
}

/**
 * Callbacks the UI calls back into. The host (commands/<x>-status.ts)
 * injects concrete implementations that bridge to the hook layer.
 */
export interface McpStatusCallbacks {
  /** Snapshot the current server list. Called on every render tick. */
  read: () => McpServerView[];
  /**
   * Toggle a server's enabled state. Returns true if the config was
   * updated; UI then re-renders. Side effects (connection teardown)
   * are the caller's responsibility.
   */
  toggle: (name: string, enabled: boolean) => Promise<boolean> | boolean;
  /** Force-reconnect a single server. */
  refresh: (name: string) => Promise<McpRefreshResult>;
}

// ─── Internal: border ──────────────────────────────────────────────────────

class DynamicBorder implements Component {
  private colorFn: (str: string) => string;
  constructor(theme: PiTheme) { this.colorFn = (str: string) => theme.fg("border", str); }
  invalidate() {}
  render(width: number): string[] { return [this.colorFn("─".repeat(Math.max(1, width)))]; }
}

// ─── Component ─────────────────────────────────────────────────────────────

export class McpStatusComponent extends Container {
  private linesComponent: Text;
  private hintComponent: Text;
  private notifyComponent: Text;
  private tui: TUI;
  private theme: PiTheme;
  private done: () => void;
  private callbacks: McpStatusCallbacks;
  private selected = 0;
  private servers: McpServerView[] = [];
  private notifyText = "";
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing = new Set<string>();
  private autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(tui: TUI, theme: PiTheme, callbacks: McpStatusCallbacks, onDone: () => void) {
    super();
    this.tui = tui; this.theme = theme; this.done = onDone; this.callbacks = callbacks;
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
    this.autoRefreshTimer = setInterval(() => {
      this.updateServers(); this.renderView();
      const allSettled = this.servers.every((s) => s.state !== "connecting");
      if (allSettled && this.autoRefreshTimer) { clearInterval(this.autoRefreshTimer); this.autoRefreshTimer = null; }
    }, 500);
  }

  private updateServers() {
    this.servers = this.callbacks.read();
    if (this.selected >= this.servers.length) this.selected = Math.max(0, this.servers.length - 1);
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
      if (s.state === "connected") { statusIcon = "🟢"; statusColor = (str: string) => this.theme.fg("accent", str); }
      else if (s.state === "connecting") { statusIcon = "🟡"; statusColor = (str: string) => this.theme.fg("warning", str); }
      else if (s.state === "waiting reload") { statusIcon = "⏳"; statusColor = (str: string) => this.theme.fg("accent", str); }
      else if (s.state === "disabled") { statusIcon = "⚪"; statusColor = (str: string) => this.theme.fg("dim", str); }
      else { statusIcon = "🔴"; statusColor = (str: string) => this.theme.fg("error", str); }
      const name = isDisabled ? this.theme.fg("dim", s.name) : isSelected ? this.theme.fg("accent", s.name) : s.name;
      const namePadding = " ".repeat(Math.max(0, namePad - s.name.length));
      const desc = s.description ? ` — ${s.description.slice(0, 50)}` : "";
      lines.push(`${cursor}${name}${namePadding}  ${statusIcon} ${statusColor(s.state)}${desc}`);
      if (isSelected) {
        lines.push(`    ${this.theme.fg("dim", s.url)}`);
        if (s.error) lines.push(`    ${this.theme.fg("error", `Error: ${s.error}`)}`);
        if (s.tools.length > 0) {
          lines.push(`    ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}:`);
          for (const tool of s.tools.slice(0, 6)) {
            const flat = (tool.description ?? "").replace(/\s+/g, " ").trim();
            const td = flat ? (flat.length > 55 ? ` — ${flat.slice(0, 55)}…` : ` — ${flat}`) : "";
            lines.push(`      ${tool.name}${td}`);
          }
          if (s.tools.length > 6) lines.push(`      ... and ${s.tools.length - 6} more`);
        }
        lines.push("");
      }
    }
    this.linesComponent.setText(lines.join("\n"));
    const s = this.servers[this.selected];
    const toggleHint = s?.state === "disabled" || s?.state === "waiting reload" ? "space enable" : "space disable";
    const hintParts = ["↑↓ navigate", toggleHint, "r refresh", "q close"];
    this.hintComponent.setText(this.theme.fg("dim", hintParts.join(" | ")));
    this.notifyComponent.setText(this.notifyText ? this.theme.fg("warning", this.notifyText) : "");
    this.tui.requestRender();
  }

  private showNotify(text: string) {
    this.notifyText = text; this.renderView();
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => { this.notifyText = ""; this.renderView(); }, 3000);
  }

  handleInput(data: string) {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.up")) { this.selected = Math.max(0, this.selected - 1); this.renderView(); return; }
    if (kb.matches(data, "tui.select.down")) { this.selected = Math.min(this.servers.length - 1, this.selected + 1); this.renderView(); return; }
    if (data === "q" || data === "\r" || data === "\n" || kb.matches(data, "tui.select.cancel")) {
      if (this.autoRefreshTimer) { clearInterval(this.autoRefreshTimer); this.autoRefreshTimer = null; }
      if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = null; }
      this.done();
      return;
    }
    if (this.servers.length === 0) return;
    const s = this.servers[this.selected];
    if (data === " ") {
      const newEnabled = s.state === "disabled";
      void (async () => {
        const ok = await this.callbacks.toggle(s.name, newEnabled);
        this.showNotify(ok ? `${newEnabled ? "Enabled" : "Disabled"} "${s.name}". Use /reload to apply.` : `Failed to toggle "${s.name}".`);
        this.updateServers(); this.renderView();
      })();
      return;
    }
    if (data === "r") {
      if (this.refreshing.has(s.name)) return;
      this.refreshing.add(s.name);
      const targetName = s.name; const targetIndex = this.selected;
      this.showNotify(`Refreshing "${targetName}"...`);
      void (async () => {
        const result = await this.callbacks.refresh(targetName);
        this.refreshing.delete(targetName);
        if (this.selected === targetIndex) {
          this.updateServers(); this.renderView();
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
