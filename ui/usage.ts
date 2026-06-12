/**
 * UsageReportComponent — tree-style usage report with expand/collapse.
 *
 * Renders:
 *   1. Overall table (4 slices: Today / Week / Month / All Time)
 *   2. Per-Model tree (collapsed by default, ↑↓ Enter to expand)
 *
 * Follows ui/mcp-status.ts visual conventions.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import type {
  Aggregate,
  ColumnId,
  ModelSlice,
  UsageReport,
} from "../commands/usage.js";
import {
  formatCell,
  formatCost,
  pickColumns,
  pickModelDisplay,
} from "../commands/usage.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const SLICE_LABELS: Array<{ key: keyof UsageReport & string; label: string }> = [
  { key: "currentSession", label: "Session" },
  { key: "today", label: "Today" },
  { key: "thisWeek", label: "This Week" },
  { key: "thisMonth", label: "This Month" },
  { key: "allTime", label: "All Time" },
];

const COL_HEADERS: Record<ColumnId, string> = {
  input: "Input",
  output: "Output",
  cacheRead: "CacheR",
  cacheWrite: "CacheW",
  hitRate: "CacheHit",
  cost: "Cost",
};

// ─── Class ─────────────────────────────────────────────────────────────────

export class UsageReportComponent extends Container {
  private theme: Theme;
  private report: UsageReport;
  private expanded = new Set<string>();
  private selectedIndex = 0;
  private onRebuild: () => Promise<UsageReport | null>;
  private refreshing = false;
  private done: () => void;
  private requestRender: () => void;
  private scrollOffset = 0;
  private readonly MAX_VISIBLE = 6;

  // child components (maintained across renders)
  private borderTop: DynamicBorder;
  private borderBottom: DynamicBorder;
  private linesComponent: Text;
  private hintComponent: Text;

  constructor(
    theme: Theme,
    report: UsageReport,
    requestRender: () => void,
    done: () => void,
    onRebuild?: () => Promise<UsageReport | null>,
  ) {
    super();

    this.theme = theme;
    this.report = report;
    this.done = done;
    this.requestRender = requestRender;
    this.onRebuild = onRebuild ?? (async () => null);

    this.borderTop = new DynamicBorder((s: string) => theme.fg("border", s));
    this.addChild(this.borderTop);
    this.addChild(new Spacer(1));

    this.linesComponent = new Text("", 1, 0);
    this.addChild(this.linesComponent);
    this.addChild(new Spacer(1));

    this.borderBottom = new DynamicBorder((s: string) => theme.fg("border", s));
    this.addChild(this.borderBottom);

    this.hintComponent = new Text("", 1, 0);
    this.addChild(this.hintComponent);

    this.renderView();
  }

  // ─── Input handling ───────────────────────────────────────────────────

  handleInput(data: string): void {
    const kb = getKeybindings();

    if (kb.matches(data, "tui.select.cancel") || data === "q") {
      this.done();
      return;
    }

    if (data === "r") {
      void (async () => {
        if (this.refreshing) return;
        this.refreshing = true;
        // Show rebuilding message
        this.linesComponent.setText(this.theme.fg("muted", "  Rebuilding stats..."));
        this.requestRender?.();
        try {
          const newReport = await this.onRebuild();
          if (newReport) {
            this.report = newReport;
            this.selectedIndex = 0;
            this.expanded.clear();
            this.scrollOffset = 0;
          }
        } finally {
          this.refreshing = false;
          this.renderView();
        }
      })();
      return;
    }

    const modelCount = this.report.byModel.length;
    if (modelCount === 0) return;

    if (kb.matches(data, "tui.select.up")) {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        if (this.selectedIndex < this.scrollOffset) {
          this.scrollOffset = this.selectedIndex;
        }
        this.renderView();
      }
      return;
    }

    if (kb.matches(data, "tui.select.down")) {
      if (this.selectedIndex < modelCount - 1) {
        this.selectedIndex++;
        if (this.selectedIndex >= this.scrollOffset + this.MAX_VISIBLE) {
          this.scrollOffset = this.selectedIndex - this.MAX_VISIBLE + 1;
        }
        this.renderView();
      }
      return;
    }

    if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "right" as any)) {
      const m = this.report.byModel[this.selectedIndex];
      if (m) {
        if (this.expanded.has(m.model)) {
          this.expanded.delete(m.model);
        } else {
          this.expanded.add(m.model);
        }
        this.renderView();
      }
      return;
    }

    if (kb.matches(data, "left" as any)) {
      const m = this.report.byModel[this.selectedIndex];
      if (m && this.expanded.has(m.model)) {
        this.expanded.delete(m.model);
        this.renderView();
      }
      return;
    }
  }

  // ─── Rendering ────────────────────────────────────────────────────────

  private renderView(): void {
    const lines: string[] = [];
    const t = this.theme;
    const modelCount = this.report.byModel.length;
    const totalMessages =
      this.report.allTime.turns;

    // Compute max label width (for alignment)
    const maxLabelLen = Math.max(
      ...SLICE_LABELS.map((s) => s.label.length),
      ...this.report.byModel.map((m) => m.model.length),
    );
    const labelW = Math.min(maxLabelLen, 30);

    // Title
    const title = t.fg("accent", t.bold("Usage Statistics"));
    lines.push(title);

    // Subtitle
    const subtitleParts: string[] = [];
    if (modelCount > 0) subtitleParts.push(`${modelCount} model${modelCount !== 1 ? "s" : ""}`);
    if (totalMessages > 0) subtitleParts.push(`${totalMessages} turn${totalMessages !== 1 ? "s" : ""}`);
    const subtitle = t.fg("muted", `  ${subtitleParts.join(" · ")}`);
    lines.push(subtitle);

    // Overall section
    lines.push("");
    lines.push(t.fg("accent", "  Overall"));

    // Pick columns based on container width (estimate 80 for now; will be clamped)
    const cols = this.computeColumns();
    const colWidths = this.computeColWidths(cols, labelW);

    // Header row
    const headerParts: string[] = [" ".repeat(labelW)];
    for (const c of cols) {
      headerParts.push(COL_HEADERS[c].padStart(colWidths[c] ?? 0));
    }
    lines.push("  " + headerParts.join("  "));

    // Divider
    const divLen = labelW + cols.reduce((s, c) => s + (colWidths[c] ?? 0) + 2, 0);
    lines.push("  " + "─".repeat(Math.max(divLen, 1)));

    // Slice rows
    for (const { key, label } of SLICE_LABELS) {
      const agg = this.report[key as keyof UsageReport] as Aggregate;
      const row = this.formatDataRow(label, labelW, agg, cols, colWidths);
      lines.push("  " + row);
    }

    // Per-Model section
    if (modelCount > 0) {
      lines.push("");
      lines.push(t.fg("accent", "  Per-Model"));
      lines.push("  " + "─".repeat(Math.max(divLen, 1)));

      // Viewport: only render MAX_VISIBLE models around selectedIndex
      const total = this.report.byModel.length;
      const end = Math.min(this.scrollOffset + this.MAX_VISIBLE, total);

      if (this.scrollOffset > 0) {
        lines.push(t.fg("muted", `  ... ${this.scrollOffset} more above`));
      }

      for (let i = this.scrollOffset; i < end; i++) {
        const m = this.report.byModel[i]!;
        const isSelected = i === this.selectedIndex;
        const isExpanded = this.expanded.has(m.model);

        const cursorRaw = isSelected ? "→ " : "  ";
        const markerChar = isExpanded ? "▾" : "▸";
        const modelDisplay = pickModelDisplay(m.model, labelW);
        const cost = formatCost(m.allTime.cost);

        // Compute padding from raw (uncolored) lengths
        const leftRaw = `${cursorRaw}${markerChar} ${modelDisplay}`;
        const padLen = divLen - leftRaw.length - cost.length + 2;
        const pad = padLen > 0 ? " ".repeat(padLen) : " ";

        // Apply theme colors
        const cursorStyled = isSelected ? t.fg("accent", cursorRaw) : cursorRaw;
        const modelStyled = isSelected
          ? t.fg("accent", `${markerChar} ${modelDisplay}`)
          : t.fg("muted", `${markerChar} ${modelDisplay}`);

        lines.push(`  ${cursorStyled}${modelStyled}${pad}${cost}`);

        // Expanded child table
        if (isExpanded) {
          // Child header
          const indent = "    ";
          const childHeaderParts: string[] = [" ".repeat(labelW)];
          for (const c of cols) {
            childHeaderParts.push(COL_HEADERS[c].padStart(colWidths[c] ?? 0));
          }
          lines.push(indent + childHeaderParts.join("  "));

          // Child divider
          lines.push(indent + "─".repeat(Math.max(divLen, 1)));

          // Child rows for this model
          for (const { key, label } of SLICE_LABELS) {
            const agg = m[key as keyof ModelSlice] as Aggregate;
            const row = this.formatDataRow(label, labelW, agg, cols, colWidths);
            lines.push(indent + row);
          }
        }
      }

      if (end < total) {
        lines.push(t.fg("muted", `  ... ${total - end} more below`));
      }
    } else {
      lines.push("");
      lines.push(t.fg("muted", "  No per-model data yet."));
    }

    // Empty state
    if (this.report.allTime.turns === 0) {
      this.linesComponent.setText(
        [title, "", t.fg("muted", "  No usage data recorded yet."), "", t.fg("dim", "  Start a session to begin tracking.")].join("\n"),
      );
    } else {
      lines.push("");
      lines.push(t.fg("dim", "  Input = all input tokens (user input + context)  ·  Output = model output tokens"));
      lines.push(t.fg("dim", "  CacheR = cached hits  ·  CacheW = created cache  ·  CacheHit = CacheR / Input"));

      this.linesComponent.setText(lines.join("\n"));
    }

    // Hint
    const hintParts: string[] = [];
    if (modelCount > 0) {
      hintParts.push("↑↓ select");
      const sel = this.report.byModel[this.selectedIndex];
      hintParts.push(sel && this.expanded.has(sel.model) ? "Enter collapse" : "Enter expand");
    }
    hintParts.push("q close");
    hintParts.push("r rebuild");
    this.hintComponent.setText(t.fg("dim", "  " + hintParts.join(" · ")));

    this.requestRender();
  }

  // ─── Column helpers ───────────────────────────────────────────────────

  private computeColumns(): ColumnId[] {
    // Estimate container width — we don't get width until render is called
    // Use a generous default (80) which covers most terminals
    return pickColumns(80);
  }

  private computeColWidths(
    cols: ColumnId[],
    labelW: number,
  ): Record<ColumnId, number> {
    const widths: Record<ColumnId, number> = {
      input: 6,
      output: 6,
      cacheRead: 6,
      cacheWrite: 6,
      hitRate: 5,
      cost: 7,
    };

    // Expand widths based on data
    const expandFromSlice = (agg: Aggregate) => {
      for (const c of cols) {
        const val = formatCell(c, agg);
        if (val.length > (widths[c] ?? 0)) widths[c] = val.length;
      }
    };

    for (const { key } of SLICE_LABELS) {
      expandFromSlice(this.report[key as keyof UsageReport] as Aggregate);
    }
    for (const m of this.report.byModel) {
      for (const { key } of SLICE_LABELS) {
        expandFromSlice(m[key as keyof ModelSlice] as Aggregate);
      }
    }

    // Also consider header width
    for (const c of cols) {
      const hdr = COL_HEADERS[c];
      if (hdr && hdr.length > (widths[c] ?? 0)) widths[c] = hdr.length;
    }

    return widths;
  }

  private formatDataRow(
    label: string,
    labelW: number,
    agg: Aggregate,
    cols: ColumnId[],
    colWidths: Record<ColumnId, number>,
  ): string {
    let line = label.padEnd(labelW);
    for (const c of cols) {
      line += "  " + formatCell(c, agg).padStart(colWidths[c] ?? 0);
    }
    return line;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  invalidate(): void {
    // no-op: component is stateless beyond report/model state
  }

  dispose(): void {
    // no-op
  }
}
