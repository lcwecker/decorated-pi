/**
 * tps — measured tokens-per-second in the footer status bar.
 *
 * One measurement per assistant message, all of it provider-reported:
 *   message_start  → t0 = request start (TTFT reference), reset the window
 *   message_update → first / last streamed event of this message
 *   message_end    → `usage.output` over (tLast - tFirst) becomes a sample
 *
 * Decode window = first → last streamed event of ONE assistant message. Tool
 * execution happens between messages (results arrive as toolResult messages),
 * so it never lands inside the window — no tool exclusion needed. Thinking and
 * tool-argument streaming are model output: they belong in the numerator
 * (usage.output includes them) and in the denominator alike.
 *
 * No live estimate. A provider reports token counts only when a stream ends —
 * openai-completions sends `usage` in the final chunk, anthropic-messages in
 * `message_delta` — so a number rendered mid-stream could only come from a
 * chars→tokens guess. Against real traffic a guess is off by more than half:
 * measured 1.6–2.0 chars/token for tool-call JSON, 2.7–3.0 for thinking,
 * 4.2–4.7 for prose, all against one hard-coded divisor. The reading then
 * disagreed with the frozen value by up to 3x and jumped at the exact moment a
 * tool call ended the message, which reads as a broken meter. So the footer
 * shows measured numbers only and moves once per message — the shape inference
 * servers use (ollama: `eval_count / eval_duration`).
 *
 * The reading is token-weighted over the last few messages rather than one
 * message's value: per-message rates are wildly bursty (p10 21, p50 124, p90
 * 169 tok/s on one model in one session), while the footer should say how fast
 * this model decodes right now. Weighting by tokens keeps a 20-token reply from
 * counting as much as a 1000-token one; the window rolls so a degraded provider
 * or a model switch shows up within a few messages.
 *
 * No numbers without data (the rule this module borrows from OpenCode):
 * aborted and errored messages, replies with a zero-width or sub-100ms window,
 * and messages whose `usage.output` is missing/zero contribute no sample at all,
 * so a partial or unrepresentative window can never drag the average. The
 * reading survives agent_end; model_select drops the samples, since two
 * models' rates do not belong in one average.
 *
 * Persistence is keep-last: the screen only ever shows a measured average. A
 * new message_start, an abort, and a reply without a measurable window all keep
 * it instead of blanking; only session boundaries (session_start /
 * session_shutdown) and a model switch clear it, so after the first completed
 * reply there is always something on screen.
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

/** Samples the displayed average rolls over. Five keeps the reading steady
 *  while a provider slowdown or a model switch still lands within a few
 *  messages. */
export const SAMPLE_WINDOW = 5;

/** Shortest decode window that becomes a sample. A tool call answered in
 *  ~250ms carries a real but unrepresentative 200+ tok/s — letting it into the
 *  average would leave the footer lying for the next five messages. */
const MIN_WINDOW_MS = 100;

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
  /** Latest streamed event; decode window end (read at message_end). */
  tLast?: number;
  /** message_end already measured this message. */
  finalized: boolean;
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
    finalized: false,
  };
}

// ─── Pure functions (unit-tested) ──────────────────────────────────────────

/** One measured message: authoritative tokens over its decode window. */
export interface TpsSample {
  tokens: number;
  /** tLast - tFirst. */
  windowMs: number;
  /** tFirst - t0; absent when the request start is unknown. */
  ttftMs?: number;
}

/** Decode throughput: tokens / (first → last token).
 *  Returns undefined when the inputs carry no rate (no tokens, or a
 *  zero-width window — a non-streaming reply). */
export function calcDecodeTps(tokens: number, tFirst: number, tLast: number): number | undefined {
  const durationMs = tLast - tFirst;
  if (!Number.isFinite(tokens) || tokens <= 0 || !(durationMs > 0)) return undefined;
  return tokens / (durationMs / 1000);
}

/** Token-weighted mean decode rate over the samples: Σtokens / Σwindow, not
 *  the mean of the per-message rates — a 20-token reply must not weigh as much
 *  as a 1000-token one. Undefined when the samples carry no usable time. */
export function averageTps(samples: readonly TpsSample[]): number | undefined {
  let tokens = 0;
  let windowMs = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample.tokens) || sample.tokens <= 0) continue;
    if (!(sample.windowMs > 0)) continue;
    tokens += sample.tokens;
    windowMs += sample.windowMs;
  }
  if (tokens <= 0 || !(windowMs > 0)) return undefined;
  return (tokens / windowMs) * 1000;
}

/** Mean TTFT over the samples that recorded one. */
export function averageTtft(samples: readonly TpsSample[]): number | undefined {
  let total = 0;
  let count = 0;
  for (const sample of samples) {
    if (sample.ttftMs === undefined || !Number.isFinite(sample.ttftMs) || sample.ttftMs < 0) continue;
    total += sample.ttftMs;
    count++;
  }
  return count > 0 ? total / count : undefined;
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

/** Footer text for the rolling average: `128.4 tok/s · TTFT 1.2s`. */
export function formatReading(samples: readonly TpsSample[]): string | undefined {
  const tps = averageTps(samples);
  if (tps === undefined) return undefined;
  const ttft = averageTtft(samples);
  if (ttft === undefined) return formatTps(tps);
  return `${formatTps(tps)} · TTFT ${formatTtft(ttft)}`;
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
  /** Rolling measurements behind the displayed average, oldest first. */
  let samples: TpsSample[] = [];
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
          samples = [];
          footerMerged = false;
          runtime.requestRender = undefined;
          runtime.updateSession = undefined;
          runtime.display = undefined;
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
        (event: MessageStartEvent) => {
          if (event.message.role !== "assistant") return;
          // New decode window, and nothing to display yet: the screen keeps the
          // last measured average (or stays blank before the first sample) and
          // the next measurement replaces it at message_end.
          Object.assign(state, freshState(), { active: true, t0: Date.now() });
        },
      ],

      // Keep the installed footer honest across mid-session switches: pi
      // calls setSession() only on its own built-in footer, so refresh the
      // proxy our TpsFooter reads through instead.
      model_select: [
        (event: ModelSelectEvent, ctx: ExtensionContext) => {
          // A rate belongs to one model: drop the samples of the previous one,
          // blank the reading until this model has answered once, and abandon
          // any response still streaming. That response was requested from the
          // model that is no longer selected, so its message_end must not
          // become a sample of the new one — freshState() leaves tFirst
          // undefined, which the window check in message_end rejects.
          samples = [];
          Object.assign(state, freshState());
          applyDisplay(ctx, undefined);
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
        (event: MessageUpdateEvent) => {
          if (!state.active || state.finalized || event.message.role !== "assistant") return;
          // Only the decode window is recorded here: the token count arrives
          // with `usage` at message_end, so there is nothing to display yet.
          const now = Date.now();
          state.tFirst ??= now;
          state.tLast = now;
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
          // Aborted / errored runs, a missing decode window, a window too short
          // to be representative, and a zero-width (non-streaming) reply carry
          // no usable rate: none of them becomes a sample, so an unmeasured or
          // partial window can never drag the average.
          if (stopReason !== "stop" && stopReason !== "length" && stopReason !== "toolUse") return;
          if (state.tFirst === undefined || state.tLast === undefined) return;
          const windowMs = state.tLast - state.tFirst;
          if (windowMs < MIN_WINDOW_MS) return;
          if (calcDecodeTps(usage.output, state.tFirst, state.tLast) === undefined) return;
          const sample: TpsSample = { tokens: usage.output, windowMs };
          const ttft = state.t0 === undefined ? undefined : state.tFirst - state.t0;
          if (ttft !== undefined && ttft >= 0) sample.ttftMs = ttft;
          samples.push(sample);
          if (samples.length > SAMPLE_WINDOW) samples.shift();
          const reading = formatReading(samples);
          if (reading === undefined) return;
          applyDisplay(ctx, reading);
        },
      ],

      agent_end: [
        (_event: AgentEndEvent) => {
          // A run normally ends after message_end measured (or kept) the
          // reading. Only clean up a run that died mid-stream without a
          // message_end, so its window cannot leak into the next message.
          if (state.active && !state.finalized) {
            Object.assign(state, freshState());
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
          samples = [];
          Object.assign(state, freshState());
          applyDisplay(ctx, undefined);
        },
      ],
    },
  };
}
