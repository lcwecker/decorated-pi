/**
 * tps — live tokens-per-second in the footer status bar.
 *
 * One state machine per assistant message:
 *   message_start  → t0 = request start, reset state, revert to last completed
 *   message_update → first/last stream timestamps + estimated chars (live, `~`-prefixed)
 *   message_end    → authoritative `usage.output` over (tLast - tFirst), frozen
 *
 * Decode window = first → last streamed event of ONE assistant message. Tool
 * execution happens between messages (results arrive as toolResult messages),
 * so it never lands inside the window — no tool exclusion needed. Thinking and
 * tool-argument streaming are model output: they belong in the numerator
 * (usage.output includes them) and in the denominator alike.
 *
 * Calibration follows OpenCode's rule — no numbers without data: aborted or
 * errored messages, and messages whose `usage.output` is missing/zero, clear
 * the status instead of freezing a possibly misleading estimate. The frozen
 * value survives agent_end so the last number stays readable; the next
 * assistant message_start clears it.
 *
 * Persistence is keep-last-completed: the on-screen value only ever moves
 * forward to real measurements (live `~` estimate, frozen exact value, or
 * the non-streaming "—"). A new message_start reverts a live estimate to
 * the last completed value instead of blanking; aborts and empty messages
 * do the same. Only session boundaries (session_start / session_shutdown)
 * truly clear the display — so after the very first measurement there is
 * always something on screen, and a `~` estimate is never frozen in place.
 *
 * Display destination: Pi renders extension setStatus() entries on a footer
 * line of their own, but users want TPS on the stats line (↑↓R W CH $ % …).
 * The only hook for that is ctx.ui.setFooter(): in interactive TUI mode we
 * replace the footer with a subclass of Pi's own FooterComponent that merges
 * the TPS text into the stats line's padding after rendering. RPC/print
 * sessions have no such hook (setFooter is a silent no-op), so there — or
 * whenever footer setup fails — we fall back to setStatus (line 3).
 *
 * Narrow terminals: the reading is shortened (`54.2 tok/s · TTFT 3.0s` →
 * `54.2 tok/s`) to fit the stats line's padding, and hidden when even that
 * does not fit. Pi's rows never wrap — an overflowing part is truncated or
 * dropped — because a second row costs transcript height and text appended
 * outside Pi's dim wrapper renders in the terminal's default color.
 */

import { FooterComponent } from "@earendil-works/pi-coding-agent";
import type {
  AgentEndEvent,
  ExtensionContext,
  MessageEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  ModelSelectEvent,
  ThinkingLevelSelectEvent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Module } from "./skeleton.js";

/** Footer status-bar slot owned by this module. */
export const TPS_STATUS_KEY = "tps";

/** Rough chars→tokens ratio for the live estimate. `message_end` replaces it
 *  with the provider's authoritative `usage.output`. ASCII-heavy text averages
 *  ~4 chars/token, but CJK (and other non-ASCII) text is close to 1
 *  token/char — dividing everything by 4 under-reads Chinese streams ~4x. */
const CHARS_PER_TOKEN = 4;

/** Skip live renders until the stream has produced something to average. */
const MIN_LIVE_MS = 200;

/** Cap live re-renders — message_update fires per content-block event. */
const THROTTLE_MS = 400;

interface TpsState {
  /** An assistant message is in flight (started, not yet ended). */
  active: boolean;
  /** Request start (message_start); TTFT reference. */
  t0?: number;
  /** First streamed event of this message; decode window start. */
  tFirst?: number;
  /** Latest streamed event; decode window end (frozen at message_end). */
  tLast?: number;
  /** ASCII chars streamed since tFirst (text + thinking + tool arguments). */
  asciiChars: number;
  /** Non-ASCII (mostly CJK) chars streamed since tFirst. */
  otherChars: number;
  /** message_end froze the value — later updates must not overwrite it. */
  finalized: boolean;
  /** Date.now() of the last live render (throttle watermark). */
  lastRender: number;
}

function freshState(): TpsState {
  // NOTE: optional fields must be listed explicitly as undefined —
  // Object.assign() never deletes keys the source object lacks, so omitting
  // tFirst/tLast here would leak the previous message's decode window into
  // the next one (inflated denominator → systematically low TPS).
  return {
    active: false,
    t0: undefined,
    tFirst: undefined,
    tLast: undefined,
    asciiChars: 0,
    otherChars: 0,
    finalized: false,
    lastRender: 0,
  };
}

// ─── Pure functions (unit-tested) ──────────────────────────────────────────

/** Estimated output tokens for the streamed characters. Never below 1 —
 *  every delta proves the model produced at least one token. */
export function estimateTokens(asciiChars: number, otherChars = 0): number {
  return Math.max(1, Math.ceil(asciiChars / CHARS_PER_TOKEN + otherChars));
}

/** Split a delta into ASCII vs non-ASCII (mostly CJK) char counts. */
export function splitChars(delta: string): { ascii: number; other: number } {
  let ascii = 0;
  for (let i = 0; i < delta.length; i++) {
    if (delta.charCodeAt(i) < 128) ascii++;
  }
  return { ascii, other: delta.length - ascii };
}

/** Decode throughput: tokens / (first → last token).
 *  Returns undefined when the inputs carry no rate (no tokens, or a
 *  zero-width window — a non-streaming reply). */
export function calcDecodeTps(tokens: number, tFirst: number, tLast: number): number | undefined {
  const durationMs = tLast - tFirst;
  if (!Number.isFinite(tokens) || tokens <= 0 || !(durationMs > 0)) return undefined;
  return tokens / (durationMs / 1000);
}

export function formatTps(tps: number): string {
  return `${tps.toFixed(1)} tok/s`;
}

export function formatTtft(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  // Round total seconds first — rounding the seconds part alone can yield "1m 60s".
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

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

interface TpsRuntime {
  /** Last text to display — source of truth for both merge and fallback. */
  display?: string;
  /** Requests a TUI re-render after a display change (set by the factory). */
  requestRender?: () => void;
}

/** Duck-typed AgentSession for FooterComponent: everything render() touches
 *  is reachable from ctx. `modelRuntime` is not exposed to extensions — the
 *  render special-cases kimi-coding itself, so a false stub only loses the
 *  "(sub)" marker for OAuth-subscription providers.
 *
 *  The proxy is MUTABLE on purpose: the installed TpsFooter keeps reading
 *  through it, so `model_select` / `thinking_level_select` handlers update
 *  these fields in place instead of reinstalling the footer (FooterComponent
 *  has setSession(), but pi only ever calls it on its own built-in instance).
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

  constructor(
    session: SessionLike,
    footerData: FooterDataLike,
    private readonly runtime: TpsRuntime,
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
      this.lastGood = lines;
      return lines;
    } catch {
      // The captured ctx goes stale after a session switch / reload until the
      // next session_start re-establishes the footer — hold the last good frame.
      return this.lastGood;
    }
  }
}

// ─── Status writer ─────────────────────────────────────────────────────────

/** Guarded setStatus: the extension ctx throws on access after /reload or a
 *  session switch, and headless modes (print/json) have no footer at all. */
function setStatusSafe(ctx: ExtensionContext, text: string | undefined): void {
  try {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(TPS_STATUS_KEY, text);
  } catch {
    // Stale extension context — nothing to update anymore.
  }
}

// ─── Module ────────────────────────────────────────────────────────────────

export function createTpsModule(): Module {
  const state: TpsState = freshState();
  const runtime: TpsRuntime = {};
  /** Mutable session head the installed footer reads through — refreshed on
   *  model_select / thinking_level_select so a mid-session /model switch
   *  doesn't leave a stale model name on the stats line. */
  let sessionProxy: SessionProxy | undefined;
  /** Last completed measurement (frozen exact value or "—"). The display
   *  reverts to this whenever a run produces no new data, so the footer
   *  never goes blank mid-session. */
  let lastFinal: string | undefined;
  /** True while a custom footer (stats-line merge) is installed for this
   *  session; false → fall back to setStatus (line 3). */
  let footerMerged = false;

  /** Route a display change: merged → footer re-render; else → setStatus. */
  function applyDisplay(ctx: ExtensionContext, text: string | undefined): void {
    runtime.display = text;
    if (footerMerged) {
      try {
        runtime.requestRender?.();
      } catch {
        // TUI gone — the next session_start re-establishes the footer.
      }
      return;
    }
    setStatusSafe(ctx, text);
  }

  /** Revert the display to the last completed measurement (no-op when
   *  already showing it) — used wherever a run yields no new data. */
  function revertDisplay(ctx: ExtensionContext): void {
    if (runtime.display !== lastFinal) applyDisplay(ctx, lastFinal);
  }

  return {
    name: "tps",
    hooks: {
      session_start: [
        (_event: unknown, ctx: ExtensionContext) => {
          Object.assign(state, freshState());
          footerMerged = false;
          runtime.requestRender = undefined;
          runtime.display = undefined;
          lastFinal = undefined;
          // Leftover tps status from a previous fallback session — keep the
          // status line clean so TPS never shows twice.
          setStatusSafe(ctx, undefined);
          if (ctx.mode !== "tui") return;
          try {
            let invoked = false;
            sessionProxy = fakeSessionFor(ctx);
            const proxy = sessionProxy;
            ctx.ui.setFooter((tui, _theme, footerData) => {
              invoked = true;
              runtime.requestRender = () => tui.requestRender();
              return new TpsFooter(proxy as unknown as SessionLike, footerData, runtime);
            });
            // RPC stubs accept the factory without calling it — detect that.
            footerMerged = invoked;
          } catch {
            footerMerged = false;
          }
        },
      ],

      message_start: [
        (event: MessageStartEvent, ctx: ExtensionContext) => {
          if (event.message.role !== "assistant") return;
          // New decode window. The display reverts to the last completed
          // measurement (or stays blank before the very first one) instead
          // of blanking — fresh data replaces it within ~half a second.
          Object.assign(state, freshState(), { active: true, t0: Date.now() });
          revertDisplay(ctx);
        },
      ],

      // Keep the installed footer honest across mid-session switches: pi
      // calls setSession() only on its own built-in footer, so refresh the
      // proxy our TpsFooter reads through instead.
      model_select: [
        (event: ModelSelectEvent) => {
          if (sessionProxy) sessionProxy.state.model = event.model;
        },
      ],

      thinking_level_select: [
        (event: ThinkingLevelSelectEvent) => {
          if (sessionProxy) sessionProxy.state.thinkingLevel = event.level;
        },
      ],

      message_update: [
        (event: MessageUpdateEvent, ctx: ExtensionContext) => {
          if (!state.active || state.finalized || event.message.role !== "assistant") return;
          const now = Date.now();
          state.tFirst ??= now;
          state.tLast = now;
          const streamEvent = event.assistantMessageEvent;
          if (streamEvent && "delta" in streamEvent && typeof streamEvent.delta === "string") {
            const { ascii, other } = splitChars(streamEvent.delta);
            state.asciiChars += ascii;
            state.otherChars += other;
          }
          const elapsed = now - state.tFirst;
          if (elapsed < MIN_LIVE_MS || now - state.lastRender < THROTTLE_MS) return;
          const tps = calcDecodeTps(estimateTokens(state.asciiChars, state.otherChars), state.tFirst, now);
          if (tps === undefined) return;
          state.lastRender = now;
          applyDisplay(ctx, `~${formatTps(tps)}`);
        },
      ],

      message_end: [
        (event: MessageEndEvent, ctx: ExtensionContext) => {
          if (event.message.role !== "assistant") return;
          state.active = false;
          state.finalized = true;
          const { stopReason, usage } = event.message;
          // Aborted / errored runs would report a partial window as a rate:
          // revert to the last completed measurement instead. A live `~`
          // estimate is never frozen in place.
          if (stopReason !== "stop" && stopReason !== "length" && stopReason !== "toolUse") {
            revertDisplay(ctx);
            return;
          }
          if (state.tFirst === undefined) {
            revertDisplay(ctx);
            return;
          }
          if (state.tLast === state.tFirst) {
            // Non-streaming reply: one instant, no rate to show.
            lastFinal = "—";
            applyDisplay(ctx, lastFinal);
            return;
          }
          const tps = calcDecodeTps(usage.output, state.tFirst, state.tLast!);
          // No authoritative usage → keep the last completed value rather
          // than freezing an estimate.
          if (tps === undefined) {
            revertDisplay(ctx);
            return;
          }
          let text = formatTps(tps);
          if (state.t0 !== undefined) {
            const ttft = state.tFirst - state.t0;
            if (ttft >= 0) text += ` · TTFT ${formatTtft(ttft)}`;
          }
          lastFinal = text;
          applyDisplay(ctx, text);
        },
      ],

      agent_end: [
        (_event: AgentEndEvent, ctx: ExtensionContext) => {
          // A run normally ends after message_end froze (or reverted) the
          // display — keep that value readable. Only clean up when the run
          // died mid-stream without a message_end.
          if (state.active && !state.finalized) {
            Object.assign(state, freshState());
            revertDisplay(ctx);
          }
        },
      ],

      session_shutdown: [
        (_event: unknown, ctx: ExtensionContext) => {
          if (footerMerged) {
            try {
              // Restore Pi's built-in footer before our ctx goes stale.
              ctx.ui.setFooter(undefined);
            } catch {
              // Stale ctx — the TUI drops the container on shutdown anyway.
            }
          }
          footerMerged = false;
          runtime.requestRender = undefined;
          sessionProxy = undefined;
          lastFinal = undefined;
          Object.assign(state, freshState());
          applyDisplay(ctx, undefined);
        },
      ],
    },
  };
}
