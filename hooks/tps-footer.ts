/**
 * tps-footer — the risky half of the TPS display: a subclass of Pi's own
 * FooterComponent that merges the reading into the stats line.
 *
 * The tps module owns the state machine and picks between the two display
 * channels; this file owns the one that reaches into Pi, plus the layout math
 * that keeps the row from wrapping (pure, so it is testable without a TUI).
 *
 * Everything here is Pi-internals knowledge: FooterComponent's constructor,
 * the fields its render() reads (session.state.model, session.getContextUsage(),
 * session.sessionManager), and the layout of the stats line (lines[1], padded
 * by a >=2-space run). Pi renders extension setStatus() entries on a footer
 * line of their own, so the merge is the only way onto the stats line. When Pi
 * moves any of that, `test/tps.test.ts` fails loudly — and the tps module keeps
 * the setStatus channel to fall back to.
 */

import { FooterComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

/** Consecutive render failures tolerated before the merge is abandoned.
 *  One failure means a stale ctx: after a session switch or /reload the
 *  captured ctx throws until the next session_start rebuilds the footer, and
 *  holding the last good frame is the only option. A second means the frame is
 *  not coming back on its own, so the module is asked to move the reading to
 *  the status line — a number that changed place beats a stale one. */
const MAX_RENDER_FAILURES = 2;

// ─── Pure layout helpers (unit-tested) ─────────────────────────────────────

/** Insert `text` into the multi-space padding between the left stats and the
 *  right-aligned model on the footer's stats line. The text consumes padding
 *  so the visible width is preserved and the model stays right-aligned.
 *  Returns undefined when the gap is too tight — the caller then falls back
 *  to a status line. ANSI escapes never contain spaces, so the first ≥2-space
 *  run is the padding. Fit is measured in visible columns, not UTF-16 units
 *  (e.g. "—" is one unit but two columns wide). */
export function insertIntoStatsLine(line: string, text: string): string | undefined {
  const match = line.match(/ {2,}/);
  if (!match || match.index === undefined) return undefined;
  const run = match[0];
  const textWidth = visibleWidth(text);
  // Two spaces of separation on each side of the text.
  if (run.length < textWidth + 4) return undefined;
  const merged = `  ${text}${" ".repeat(run.length - textWidth - 2)}`;
  return line.slice(0, match.index) + merged + line.slice(match.index + run.length);
}

/** The same reading at the widths worth showing.
 *
 *  Pi's footer rows never wrap: an overflowing part is truncated with an
 *  ellipsis (`41.3%/1...`) or dropped to nothing, because a second row costs
 *  transcript height and text appended outside Pi's dim wrapper renders in the
 *  terminal's default color. So the reading is shortened to fit, and hidden
 *  when even the rate alone does not fit — a bare `54.2` among the token and
 *  cost figures would not be recognizable on its own. */
export function tpsDisplayVariants(text: string): string[] {
  const variants: string[] = [];
  const push = (candidate: string) => {
    if (candidate && !variants.includes(candidate)) variants.push(candidate);
  };
  // Full reading → drop the TTFT suffix; the rate is what the feature is for.
  const rate = text.split(" · TTFT ")[0];
  push(text);
  push(rate);
  return variants;
}

/** Shortest variant of `display` that fits the stats line's padding, or
 *  undefined when none does — the caller then shows nothing, matching how Pi
 *  hides an overflowing part instead of wrapping it. */
export function insertBestFit(statsLine: string, display: string): string | undefined {
  for (const variant of tpsDisplayVariants(display)) {
    const merged = insertIntoStatsLine(statsLine, variant);
    if (merged) return merged;
  }
  return undefined;
}

/** Re-assert the line's own style around Pi's truncation ellipsis.
 *
 *  Pi builds the stats line with a plain `"..."` and dims the result only
 *  afterwards (footer.js: `truncateToWidth(statsLeft, width, "...")` then
 *  `theme.fg("dim", statsLeft)`), while its path line passes an already-themed
 *  ellipsis. `truncateToWidth` emits a reset before the dots and re-opens
 *  whatever style was active — for a plain input there is none, so the reset
 *  also cuts off the outer dim and the dots render in the terminal's default
 *  color, bright next to the surrounding stats. The line's own leading SGR is
 *  restored in front of them. Safe to delete once pi passes a themed
 *  ellipsis here too. */
export function restoreEllipsisStyle(line: string): string {
  const opening = /^\x1b\[[0-9;]*m/.exec(line);
  if (!opening) return line;
  return line.replace("\x1b[0m...", `\x1b[0m${opening[0]}...`);
}

// ─── Footer merge (interactive TUI) ─────────────────────────────────────────

type SessionLike = ConstructorParameters<typeof FooterComponent>[0];
type FooterDataLike = ConstructorParameters<typeof FooterComponent>[1];

/** Live display state shared with the tps module. Mutable on purpose: the
 *  installed footer keeps reading `display` for the whole session, and the
 *  module keeps writing it. */
export interface FooterDisplay {
  /** Last text to display — what the merged row shows. */
  display?: string;
  /** Requests a TUI re-render after a display change (set by the installer). */
  requestRender?: () => void;
  /** Refresh the session head the installed footer reads through. Pi calls
   *  setSession() only on its own built-in footer, so a mid-session /model
   *  switch has to be written into the proxy instead of reinstalling. */
  updateSession?: (patch: { model?: unknown; thinkingLevel?: unknown }) => void;
  /** The merged row can no longer be trusted — move the reading elsewhere. */
  onRenderFailure: () => void;
}

/** Duck-typed AgentSession for FooterComponent: everything render() touches
 *  is reachable from ctx. `modelRuntime` is not exposed to extensions — the
 *  render special-cases kimi-coding itself, so a false stub only loses the
 *  "(sub)" marker for OAuth-subscription providers.
 *
 *  The proxy is MUTABLE on purpose (see FooterDisplay.updateSession above).
 *
 *  Known gap: auto-compact has no extension event, so the "(auto)" marker
 *  stays at its default (shown). It only lies if the user toggled
 *  auto-compact off mid-session. */
interface SessionProxy {
  state: { model: unknown; thinkingLevel: unknown };
  sessionManager: unknown;
  getContextUsage: () => unknown;
  modelRuntime: { isUsingSubscription: () => false };
}

function fakeSessionFor(ctx: ExtensionContext): SessionProxy {
  return {
    state: { model: ctx.model, thinkingLevel: ctx.thinkingLevel },
    sessionManager: ctx.sessionManager,
    getContextUsage: () => ctx.getContextUsage(),
    modelRuntime: { isUsingSubscription: () => false },
  };
}

/** Pi's own footer with the TPS text merged into the stats line. */
class TpsFooter extends FooterComponent {
  private lastGood: string[] = [];
  /** Consecutive failed renders — reset by any successful one. */
  private failures = 0;
  /** Guards against queueing a second degradation before it has run. */
  private degradeQueued = false;

  constructor(
    session: SessionLike,
    footerData: FooterDataLike,
    private readonly runtime: FooterDisplay,
  ) {
    super(session, footerData);
  }

  render(width: number): string[] {
    try {
      const lines = super.render(width);
      if (lines.length >= 2) lines[1] = restoreEllipsisStyle(lines[1]);
      const tps = this.runtime.display;
      if (tps && lines.length >= 2) {
        // Shorten to fit the padding; hidden when it cannot. Pi draws the
        // rows this module writes into, so every visible line keeps its dim
        // styling and the footer never grows a row.
        const merged = insertBestFit(lines[1], tps);
        if (merged) lines[1] = merged;
      }
      this.failures = 0;
      this.lastGood = lines;
      return lines;
    } catch {
      this.failures++;
      if (this.failures >= MAX_RENDER_FAILURES && !this.degradeQueued) {
        this.degradeQueued = true;
        // Swapping the footer mutates the component the TUI is rendering
        // right now, so hand it to the next tick. The frame returned here is
        // the last good one either way.
        queueMicrotask(() => this.runtime.onRenderFailure());
      }
      // Either a stale ctx that session_start will replace, or a merge that is
      // about to be abandoned — hold the last good frame until then.
      return this.lastGood;
    }
  }
}

/** Install the merged footer for a TUI session.
 *
 *  Returns false when the merge is not live and the module must use the
 *  setStatus channel instead: non-tui modes (rpc/print/json), a setFooter that
 *  throws, or an RPC-style stub that accepts the factory without invoking it. */
export function installTpsFooter(ctx: ExtensionContext, runtime: FooterDisplay): boolean {
  if (ctx.mode !== "tui") return false;
  try {
    let invoked = false;
    const proxy = fakeSessionFor(ctx);
    runtime.updateSession = (patch) => {
      if (patch.model !== undefined) proxy.state.model = patch.model;
      if (patch.thinkingLevel !== undefined) proxy.state.thinkingLevel = patch.thinkingLevel;
    };
    ctx.ui.setFooter((tui, _theme, footerData) => {
      invoked = true;
      runtime.requestRender = () => tui.requestRender();
      return new TpsFooter(proxy as unknown as SessionLike, footerData, runtime);
    });
    // RPC stubs accept the factory without calling it — detect that.
    return invoked;
  } catch {
    return false;
  }
}
