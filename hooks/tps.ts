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
 * Display destination: two channels, one picked per session.
 *  - Interactive TUI: install a subclass of Pi's own FooterComponent
 *    (hooks/tps-footer.ts) that merges the TPS text into the stats line's
 *    padding, which is where users want it (↑↓R W CH $ % …).
 *  - Everywhere else — rpc/print/json, a setFooter that throws, or an RPC stub
 *    that never invokes the factory — setStatus on a line of its own.
 * The merge is the only Pi-internals-dependent half, and it is the one that can
 * be abandoned mid-session: when its render() keeps failing while the ctx is
 * still alive, the reading moves to the status line instead of freezing.
 *
 * Narrow terminals: the reading is shortened (`54.2 tok/s · TTFT 3.0s` →
 * `54.2 tok/s`) to fit the stats line's padding, and hidden when even that
 * does not fit. Pi's rows never wrap — an overflowing part is truncated or
 * dropped — because a second row costs transcript height and text appended
 * outside Pi's dim wrapper renders in the terminal's default color.
 */

import type {
  AgentEndEvent,
  ExtensionContext,
  MessageEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  ModelSelectEvent,
  ThinkingLevelSelectEvent,
} from "@earendil-works/pi-coding-agent";
import { installTpsFooter, type FooterDisplay } from "./tps-footer.js";
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

/** API id of pi's virtual catalog entries. pi exports it as `VIRTUAL_MODEL_API`
 *  from its own virtual-model module but does not re-export it from the package
 *  root (dist/core/virtual-models.js:3), and it is what `isVirtualModel()` —
 *  hence `session.routedModel` — keys on. */
const VIRTUAL_MODEL_API = "pi-virtual";

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
  const runtime: FooterDisplay = { onRenderFailure: () => degradeToStatus() };
  /** Context of the live session, kept so a failing merge can still move the
   *  reading to the status line. Undefined outside a session. */
  let activeCtx: ExtensionContext | undefined;
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

  /** Abandon the stats-line merge: restore Pi's built-in footer and republish
   *  the reading on the status line. tps-footer asks for this when render()
   *  keeps failing while the ctx is still alive — a reading that changed place
   *  beats a stale one frozen in the merged row for the rest of the session.
   *  When the ctx died with it (session switch / reload) there is nowhere to
   *  move to, so the footer holds its last good frame until the next
   *  session_start rebuilds both channels. */
  function degradeToStatus(): void {
    if (!footerMerged || !activeCtx) return;
    const ctx = activeCtx;
    footerMerged = false;
    try {
      ctx.ui.setFooter(undefined);
    } catch {
      // Stale ctx — the TUI drops the footer container with it.
      return;
    }
    setStatusSafe(ctx, runtime.display);
  }

  return {
    name: "tps",
    hooks: {
      session_start: [
        (_event: unknown, ctx: ExtensionContext) => {
          Object.assign(state, freshState());
          footerMerged = false;
          runtime.requestRender = undefined;
          runtime.updateSession = undefined;
          runtime.display = undefined;
          lastFinal = undefined;
          activeCtx = ctx;
          // Leftover tps status from a previous fallback session — keep the
          // status line clean so TPS never shows twice.
          setStatusSafe(ctx, undefined);
          // False outside TUI mode, and when setFooter is stubbed or throws:
          // the reading then goes to the status line instead.
          footerMerged = installTpsFooter(ctx, runtime);
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
          // Pi derives its own routedModel only for a virtual selection, and
          // from the latest response in the session — which may predate this
          // selection. Dropping the recorded route is the conservative read:
          // the arrow reappears with the next response.
          runtime.updateSession?.({ model: event.model, routedModel: undefined });
        },
      ],

      thinking_level_select: [
        (event: ThinkingLevelSelectEvent) => {
          runtime.updateSession?.({ thinkingLevel: event.level });
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
          // Keep the installed footer's `→ <physical model>` arrow in step
          // with what pi itself would report. Pi reads it from
          // `session.routedModel` (dist/core/agent-session.js:1017), which
          // appends nothing unless the selection is a virtual model, draws the
          // physical model of the latest *successful* response — errored and
          // aborted responses are skipped, so an earlier route survives a
          // failed run — and draws nothing again when that model has left the
          // catalog. Neither the session nor the route is reachable from ctx,
          // so the same rules are applied to the response that just arrived.
          const responded = event.message;
          if (
            ctx.model?.api === VIRTUAL_MODEL_API &&
            responded.stopReason !== "error" &&
            responded.stopReason !== "aborted"
          ) {
            const found = ctx.modelRegistry?.find(responded.provider, responded.model);
            // pi's own lookup refuses an entry that is itself virtual
            // (dist/core/model-runtime.js:749), so a response naming the
            // selection draws no arrow either.
            const physical = found && found.api !== VIRTUAL_MODEL_API ? found : undefined;
            runtime.updateSession?.({
              routedModel: physical && { model: physical, thinkingLevel: responded.thinkingLevel },
            });
          }
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
          runtime.updateSession = undefined;
          activeCtx = undefined;
          lastFinal = undefined;
          Object.assign(state, freshState());
          applyDisplay(ctx, undefined);
        },
      ],
    },
  };
}
