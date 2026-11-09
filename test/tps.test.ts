/**
 * tps — measured tokens-per-second in the footer status bar.
 *
 * Pins:
 *  - pure math: calcDecodeTps / averageTps / averageTtft / formatReading /
 *    formatTps / formatTtft
 *  - the message lifecycle: window reset on assistant message_start, first and
 *    last stream timestamps on message_update, one sample measured at
 *    message_end — nothing is estimated or rendered while streaming
 *  - the reading is token-weighted over the last SAMPLE_WINDOW messages, so a
 *    short reply cannot outweigh a long one and one bursty message cannot
 *    define the number
 *  - "no misleading numbers": aborted, errored, non-streaming, sub-100ms and
 *    usage-less replies contribute no sample at all
 *  - keep-last: a new message_start, an abort, or an unusable reply keeps the
 *    reading instead of blanking; only session boundaries and a model switch
 *    clear it
 *  - the reading survives agent_end; stale/headless ctx never throws
 *  - the footer merge (hooks/tps-footer.ts): insertIntoStatsLine inlines TPS
 *    into the stats line (length-preserving), tui mode installs a
 *    FooterComponent subclass via setFooter, rpc mode falls back to the
 *    setStatus status line, and repeated render failures abandon the merge for
 *    the status line instead of freezing a stale reading
 *  - the skeleton dispatches message_start / message_update (parallel) and
 *    message_end (compose, no replacement) to the module
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createTpsModule,
  calcDecodeTps,
  averageTps,
  averageTtft,
  formatReading,
  formatTps,
  formatTtft,
  SAMPLE_WINDOW,
  TPS_STATUS_KEY,
} from "../hooks/tps.js";
import {
  insertIntoStatsLine,
  insertBestFit,
  restoreEllipsisStyle,
  tpsDisplayVariants,
} from "../hooks/tps-footer.js";
import { createSkeleton } from "../hooks/skeleton.js";

// ─── Harness ──────────────────────────────────────────────────────────────

type Handler = (event: any, ctx: any, pi?: any) => any;

function moduleHandlers() {
  const mod = createTpsModule();
  return {
    start: mod.hooks.message_start![0] as Handler,
    update: mod.hooks.message_update![0] as Handler,
    end: mod.hooks.message_end![0] as Handler,
    agentEnd: mod.hooks.agent_end![0] as Handler,
    shutdown: mod.hooks.session_shutdown![0] as Handler,
    sessionStart: mod.hooks.session_start![0] as Handler,
    modelSelect: mod.hooks.model_select![0] as Handler,
    thinkingSelect: mod.hooks.thinking_level_select![0] as Handler,
  };
}

let now = 0;
let setStatus: ReturnType<typeof vi.fn>;
let ctx: any;

const piStub: any = {};

function assistantStart() {
  return { type: "message_start", message: { role: "assistant" } };
}

function update(delta?: string) {
  return {
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent:
      delta === undefined
        ? { type: "text_start", contentIndex: 0 }
        : { type: "text_delta", contentIndex: 0, delta },
  };
}

function assistantEnd(overrides: Record<string, unknown> = {}) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      usage: { output: 50 },
      ...overrides,
    },
  };
}

beforeEach(() => {
  now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  setStatus = vi.fn();
  ctx = { hasUI: true, ui: { setStatus } };
  // FooterComponent.render colors via the theme singleton — the real TUI calls
  // initTheme() at startup; tests must do the same before rendering a footer.
  initTheme(undefined, false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Pure functions ───────────────────────────────────────────────────────

describe("tps — pure functions", () => {
  it("averageTps weights by tokens and window, not by message", () => {
    // One long message and one short one: the short one must not weigh half.
    expect(averageTps([{ tokens: 1_000, windowMs: 10_000 }, { tokens: 10, windowMs: 100 }])).toBeCloseTo(
      (1_010 / 10_100) * 1_000,
      6,
    );
    expect(averageTps([{ tokens: 100, windowMs: 1_000 }])).toBe(100);
  });

  it("averageTps returns undefined without usable samples", () => {
    expect(averageTps([])).toBeUndefined();
    expect(averageTps([{ tokens: 0, windowMs: 1_000 }])).toBeUndefined();
    expect(averageTps([{ tokens: 10, windowMs: 0 }])).toBeUndefined();
    expect(averageTps([{ tokens: 10, windowMs: -5 }])).toBeUndefined();
    expect(averageTps([{ tokens: NaN, windowMs: 1_000 }])).toBeUndefined();
  });

  it("averageTtft averages only the samples that recorded one", () => {
    expect(averageTtft([{ tokens: 1, windowMs: 1, ttftMs: 200 }, { tokens: 1, windowMs: 1 }])).toBe(200);
    expect(
      averageTtft([{ tokens: 1, windowMs: 1, ttftMs: 200 }, { tokens: 1, windowMs: 1, ttftMs: 400 }]),
    ).toBe(300);
    expect(averageTtft([{ tokens: 1, windowMs: 1 }])).toBeUndefined();
  });

  it("formatReading drops the TTFT suffix when no sample has one", () => {
    expect(formatReading([{ tokens: 50, windowMs: 500, ttftMs: 1_200 }])).toBe("100.0 tok/s · TTFT 1.2s");
    expect(formatReading([{ tokens: 50, windowMs: 500 }])).toBe("100.0 tok/s");
    expect(formatReading([])).toBeUndefined();
  });

  it("SAMPLE_WINDOW is the few-messages window the footer rolls over", () => {
    expect(SAMPLE_WINDOW).toBe(5);
  });

  it("calcDecodeTps computes tokens over the decode window", () => {
    expect(calcDecodeTps(100, 0, 1_000)).toBe(100);
    expect(calcDecodeTps(50, 1_200, 1_900)).toBeCloseTo(71.428, 2);
  });

  it("calcDecodeTps returns undefined for zero tokens or a zero-width window", () => {
    expect(calcDecodeTps(0, 0, 1_000)).toBeUndefined();
    expect(calcDecodeTps(-5, 0, 1_000)).toBeUndefined();
    expect(calcDecodeTps(10, 500, 500)).toBeUndefined();
    expect(calcDecodeTps(10, 500, 400)).toBeUndefined();
    expect(calcDecodeTps(NaN, 0, 1_000)).toBeUndefined();
  });

  it("formats tps and ttft for the status bar", () => {
    expect(formatTps(52.34)).toBe("52.3 tok/s");
    expect(formatTps(5)).toBe("5.0 tok/s");
    expect(formatTtft(1_200)).toBe("1.2s");
    expect(formatTtft(200)).toBe("0.2s");
    expect(formatTtft(65_000)).toBe("1m 5s");
  });

  it("formatTtft never renders 60 seconds", () => {
    // Rounding the seconds part alone used to yield "1m 60s".
    expect(formatTtft(60_000)).toBe("1m 0s");
    expect(formatTtft(119_500)).toBe("2m 0s");
    expect(formatTtft(125_000)).toBe("2m 5s");
  });
});

// ─── Message lifecycle ────────────────────────────────────────────────────

describe("tps — message lifecycle", () => {
  it("measures a message at message_end and shows nothing while it streams", () => {
    const h = moduleHandlers();

    now = 1_000;
    h.start(assistantStart(), ctx);
    expect(setStatus).not.toHaveBeenCalled(); // fresh: nothing measured yet

    now = 1_100;
    h.start({ type: "message_start", message: { role: "user" } }, ctx);
    expect(setStatus).not.toHaveBeenCalled(); // non-assistant messages are ignored

    now = 1_200;
    h.update(update(), ctx); // first streamed event → tFirst
    now = 1_500;
    h.update(update("abcd"), ctx);
    now = 1_900;
    h.update(update("ijkl"), ctx); // still streaming: no token count to show
    expect(setStatus).not.toHaveBeenCalled();

    now = 2_200;
    h.end(assistantEnd({ usage: { output: 50 } }), ctx); // 50 tokens / 700ms
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "71.4 tok/s · TTFT 0.2s");

    // Measured: later updates and agent_end must not overwrite it.
    const calls = setStatus.mock.calls.length;
    now = 2_300;
    h.update(update("more"), ctx);
    h.agentEnd({ type: "agent_end", messages: [] }, ctx);
    expect(setStatus).toHaveBeenCalledTimes(calls);
  });

  it("ignores message_end for non-assistant messages", () => {
    const h = moduleHandlers();
    h.end({ type: "message_end", message: { role: "user" } }, ctx);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("keeps the reading across a new message instead of blanking", () => {
    const h = moduleHandlers();
    // First run: 50 tokens over a 300ms window.
    h.start(assistantStart(), ctx);
    now = 1_200;
    h.update(update(), ctx);
    now = 1_500;
    h.update(update("abcd"), ctx);
    h.end(assistantEnd({ usage: { output: 50 } }), ctx);
    const measured = "166.7 tok/s · TTFT 0.2s";
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, measured);

    // Second run: message_start must not blank the screen (prefill gap), and
    // the new message's streamed events must not touch the reading either.
    const calls = setStatus.mock.calls.length;
    now = 3_400;
    h.start(assistantStart(), ctx);
    now = 3_600;
    h.update(update(), ctx);
    now = 4_000;
    h.update(update("xy"), ctx);
    expect(setStatus).toHaveBeenCalledTimes(calls);

    // The second sample moves the average: 100 tokens over 300+400ms, TTFT
    // averaged too.
    now = 4_100;
    h.end(assistantEnd({ usage: { output: 50 } }), ctx);
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "142.9 tok/s · TTFT 0.2s");
  });

  it("an aborted run contributes no sample", () => {
    const h = moduleHandlers();
    h.start(assistantStart(), ctx);
    now = 1_200;
    h.update(update(), ctx);
    now = 1_500;
    h.update(update("abcd"), ctx);
    h.end(assistantEnd({ usage: { output: 50 } }), ctx);
    const measured = "166.7 tok/s · TTFT 0.2s";

    h.start(assistantStart(), ctx);
    now = 3_000;
    h.update(update(), ctx);
    now = 3_400;
    h.update(update("xy"), ctx);
    const calls = setStatus.mock.calls.length;
    h.end(assistantEnd({ stopReason: "aborted" }), ctx);
    // A partial window would read as a rate — the average stays untouched.
    expect(setStatus).toHaveBeenCalledTimes(calls);
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, measured);
  });

  it("a message without usage contributes no sample", () => {
    const h = moduleHandlers();
    h.start(assistantStart(), ctx);
    now = 1_200;
    h.update(update(), ctx);
    now = 1_500;
    h.update(update("abcd"), ctx);
    h.end(assistantEnd({ usage: { output: 50 } }), ctx);
    const measured = "166.7 tok/s · TTFT 0.2s";

    h.start(assistantStart(), ctx);
    now = 3_000;
    h.update(update(), ctx);
    now = 3_400;
    h.update(update("xy"), ctx);
    const calls = setStatus.mock.calls.length;
    h.end(assistantEnd({ usage: { output: 0 } }), ctx);
    expect(setStatus).toHaveBeenCalledTimes(calls);
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, measured);
  });

  it("each message gets a fresh decode window (no cross-message leak)", () => {
    const h = moduleHandlers();
    h.start(assistantStart(), ctx);
    now = 1_200;
    h.update(update(), ctx);
    now = 1_500;
    h.update(update("abcd"), ctx);
    h.end(assistantEnd({ usage: { output: 50 } }), ctx);

    // A much later message must measure from its own first token. A leaked
    // tFirst from the previous message inflated the denominator ~23x here
    // (systematically low TPS in multi-round runs).
    now = 10_000;
    h.start(assistantStart(), ctx);
    now = 10_200;
    h.update(update(), ctx);
    now = 10_600;
    h.update(update("xy"), ctx);
    h.end(assistantEnd({ usage: { output: 50 } }), ctx);    // 100 tokens over 300+400ms, not over the 9s gap between the messages.
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "142.9 tok/s · TTFT 0.2s");
  });

  it("stays blank when nothing ever completed", () => {
    const h = moduleHandlers();
    h.start(assistantStart(), ctx);
    h.end(assistantEnd(), ctx);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("a non-streaming reply contributes no sample", () => {
    const h = moduleHandlers();
    h.start(assistantStart(), ctx);
    now = 1_200;
    h.update(update("done in one shot"), ctx); // tFirst === tLast
    h.end(assistantEnd({ stopReason: "stop" }), ctx);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("a decode window too short to represent a rate contributes no sample", () => {
    const h = moduleHandlers();
    h.start(assistantStart(), ctx);
    now = 1_200;
    h.update(update(), ctx);
    now = 1_250;
    h.update(update("xy"), ctx); // 50ms window: a burst, not a rate
    h.end(assistantEnd({ usage: { output: 12 } }), ctx); // would read 240 tok/s
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("averages the last five samples, weighted by tokens", () => {
    const h = moduleHandlers();
    const measure = (tokens: number, windowMs: number) => {
      now += 1_000;
      h.start(assistantStart(), ctx);
      now += 1_000;
      h.update(update(), ctx);
      now += windowMs;
      h.update(update("x"), ctx);
      h.end(assistantEnd({ usage: { output: tokens } }), ctx);
    };

    // One long message and then four tiny ones. A plain mean of the per-message
    // rates would read 28 tok/s here; weighting by tokens keeps the long
    // message's weight.
    measure(1_000, 10_000);
    for (let i = 0; i < 4; i++) measure(10, 1_000);
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "74.3 tok/s · TTFT 1.0s");

    // The sixth sample evicts the long message — only then may the reading be
    // defined by the small replies alone.
    measure(10, 1_000);
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "10.0 tok/s · TTFT 1.0s");
  });

  it("a model switch drops the samples of the previous model", () => {
    const h = moduleHandlers();
    h.start(assistantStart(), ctx);
    now = 1_200;
    h.update(update(), ctx);
    now = 1_500;
    h.update(update("abcd"), ctx);
    h.end(assistantEnd({ usage: { output: 50 } }), ctx);
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "166.7 tok/s · TTFT 0.2s");

    h.modelSelect(
      { type: "model_select", model: { id: "m2" }, previousModel: { id: "m" }, source: "set" },
      ctx,
    );
    // Two models' rates do not belong in one average: blank until the new
    // model answers once.
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, undefined);
  });

  it("a model switch mid-stream drops the in-flight response", () => {
    const h = moduleHandlers();
    h.start(assistantStart(), ctx);
    now = 1_200;
    h.update(update(), ctx);
    now = 1_500;
    h.update(update("abcd"), ctx);

    // /model pressed while this response is still streaming.
    h.modelSelect(
      { type: "model_select", model: { id: "m2" }, previousModel: { id: "m" }, source: "set" },
      ctx,
    );
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, undefined);

    // Its message_end was requested from the model that is no longer selected:
    // no sample, so the reading stays blank rather than reporting the old
    // model's rate under the new one.
    const calls = setStatus.mock.calls.length;
    now = 1_600;
    h.end(assistantEnd({ usage: { output: 50 } }), ctx);
    expect(setStatus).toHaveBeenCalledTimes(calls);

    // The new model's own response measures normally.
    now = 2_000;
    h.start(assistantStart(), ctx);
    now = 2_200;
    h.update(update(), ctx);
    now = 2_600;
    h.update(update("x"), ctx);
    h.end(assistantEnd({ usage: { output: 40 } }), ctx);
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "100.0 tok/s · TTFT 0.2s");
  });

  it("ignores message_update without a stream event instead of throwing", () => {
    const h = moduleHandlers();
    h.start(assistantStart(), ctx);
    now = 1_500;
    // Pi always sends assistantMessageEvent today; pin the guard so a future
    // shape change (or refactor dropping the guard) fails loudly, not silently.
    const malformed = { type: "message_update", message: { role: "assistant" }, assistantMessageEvent: undefined };
    expect(() => h.update(malformed, ctx)).not.toThrow();
    expect(setStatus).not.toHaveBeenCalled(); // fresh module: nothing rendered yet
  });

  it("agent_end cleans up a run that died mid-stream", () => {
    const h = moduleHandlers();
    h.start(assistantStart(), ctx);
    now = 1_200;
    h.update(update(), ctx);
    h.agentEnd({ type: "agent_end", messages: [] }, ctx);
    expect(setStatus).not.toHaveBeenCalled(); // no message_end, no measurement

    // The abandoned window must not leak: the next message measures from its
    // own first token.
    now = 1_800;
    h.start(assistantStart(), ctx);
    now = 2_000;
    h.update(update(), ctx);
    now = 2_400;
    h.update(update("x"), ctx);
    h.end(assistantEnd({ usage: { output: 40 } }), ctx); // 40 tokens / 400ms
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "100.0 tok/s · TTFT 0.2s");
  });

  it("session_shutdown clears state and the status", () => {
    const h = moduleHandlers();
    h.start(assistantStart(), ctx);
    now = 1_200;
    h.update(update(), ctx);
    h.shutdown({ type: "session_shutdown" }, ctx);
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, undefined);
  });

  it("never throws on a stale or headless ctx", () => {
    const h = moduleHandlers();
    // setStatus throws (stale ctx after /reload or session switch).
    const staleCtx: any = { hasUI: true, ui: { setStatus: () => { throw new Error("stale"); } } };
    expect(() => {
      h.start(assistantStart(), staleCtx);
      now = 1_200;
      h.update(update(), staleCtx);
      now = 1_500;
      h.update(update("abcd"), staleCtx);
      h.end(assistantEnd(), staleCtx); // measurement → throwing setStatus
      h.end(assistantEnd({ stopReason: "aborted" }), staleCtx); // skipped → no call
    }).not.toThrow();
    // Headless mode: hasUI false → no footer, no call.
    const headless: any = { hasUI: false, ui: { setStatus } };
    now = 2_000;
    h.start(assistantStart(), headless);
    now = 2_200;
    h.update(update(), headless);
    now = 2_600;
    h.update(update("x"), headless);
    h.end(assistantEnd({ usage: { output: 40 } }), headless);
    expect(setStatus).not.toHaveBeenCalled();
    // hasUI getter itself can throw on a stale ctx.
    const throwing: any = {
      get hasUI(): boolean { throw new Error("stale"); },
      ui: { setStatus },
    };
    expect(() => h.start(assistantStart(), throwing)).not.toThrow();
  });
});

// ─── Footer merge (stats-line) ─────────────────────────────────────────────

describe("tps — footer merge", () => {
  it("insertIntoStatsLine merges into the padding and preserves layout", () => {
    const line =
      "\x1b[2m57.3%/828k (auto)\x1b[0m\x1b[2m" +
      " ".repeat(40) +
      "(sub2reolink) gpt-6-astra • high\x1b[0m";
    const merged = insertIntoStatsLine(line, "~0.6 tok/s");
    expect(merged).toBeDefined();
    // Order: stats → gap text → right-aligned model; gap text has 2-space separators.
    expect(merged).toContain("  ~0.6 tok/s ");
    expect(merged!.indexOf("(auto)")).toBeGreaterThan(-1);
    expect(merged!.indexOf("~0.6 tok/s")).toBeGreaterThan(merged!.indexOf("(auto)"));
    expect(merged!.indexOf("(sub2reolink)")).toBeGreaterThan(merged!.indexOf("~0.6 tok/s"));
    // The text consumes padding: total length unchanged → model stays aligned.
    expect(merged!.length).toBe(line.length);
    expect(merged!.endsWith("(sub2reolink) gpt-6-astra • high\x1b[0m")).toBe(true);
    expect(visibleWidth(merged!)).toBe(visibleWidth(line));
  });

  it("insertIntoStatsLine refuses tight or absent gaps", () => {
    expect(insertIntoStatsLine("a b c", "~0.6 tok/s")).toBeUndefined();
    // Gap of 5 < len("~0.6 tok/s") + 4 → no room with separators on both sides.
    expect(insertIntoStatsLine(`a${" ".repeat(5)}b`, "~0.6 tok/s")).toBeUndefined();
  });

  it("tpsDisplayVariants always keeps the unit next to the number", () => {
    // The TTFT suffix goes first; the unit stays, because `54.2` dropped into
    // a row of token and cost figures would not be readable on its own.
    expect(tpsDisplayVariants("54.2 tok/s · TTFT 3.0s")).toEqual(["54.2 tok/s · TTFT 3.0s", "54.2 tok/s"]);
    // A reading without a TTFT suffix never repeats a variant.
    expect(tpsDisplayVariants("128.4 tok/s")).toEqual(["128.4 tok/s"]);
  });

  it("insertBestFit shortens the reading to the room available", () => {
    // The reported case: a 14-column gap fits the rate, not the full reading.
    const line = `26.5%/828k (auto)${" ".repeat(14)}(openai-codex) gpt-6-sol • high`;
    const merged = insertBestFit(line, "54.2 tok/s · TTFT 3.0s");
    expect(merged).toContain("54.2 tok/s");
    expect(merged).not.toContain("TTFT");
    expect(merged!.length).toBe(line.length);
    expect(visibleWidth(merged!)).toBe(visibleWidth(line));
  });

  it("insertBestFit hides the reading when even the rate has no room", () => {
    expect(insertBestFit("a b c", "54.2 tok/s · TTFT 3.0s")).toBeUndefined();
    // 12 columns: enough for the bare number a naive ladder would fall to,
    // still not enough for the rate plus its two-space separators.
    expect(insertBestFit(`a${" ".repeat(12)}b`, "54.2 tok/s · TTFT 3.0s")).toBeUndefined();
    // 14 columns fits it exactly (10 for the rate + 4 for the separators).
    expect(insertBestFit(`a${" ".repeat(14)}b`, "54.2 tok/s · TTFT 3.0s")).toContain("54.2 tok/s");
  });

  it("restoreEllipsisStyle re-asserts the line's dim around Pi's dots", () => {
    // Captured verbatim from Pi's FooterComponent at width 33: the plain
    // ellipsis lands after the reset truncateToWidth emitted, outside the dim
    // span that footer.js opened around statsLeft.
    const broken = "\x1b[38;5;241m↑780k ↓233k R72M 41.8%/1.0M (a\x1b[0m...\x1b[0m\x1b[39m\x1b[38;5;241m\x1b[39m";
    const fixed = restoreEllipsisStyle(broken);
    expect(fixed).toContain("\x1b[0m\x1b[38;5;241m...");
    expect(fixed).not.toContain("\x1b[0m...");
    expect(visibleWidth(fixed)).toBe(visibleWidth(broken));
  });

  it("restoreEllipsisStyle leaves themed or dot-less lines alone", () => {
    // Pi's path line already themes its ellipsis; nothing to repair.
    const themed = "\x1b[38;5;241m/home/u/reolink_t\x1b[0m\x1b[38;5;241m...\x1b[39m\x1b[0m";
    expect(restoreEllipsisStyle(themed)).toBe(themed);
    expect(restoreEllipsisStyle("plain text")).toBe("plain text");
    expect(restoreEllipsisStyle("\x1b[2mstats only\x1b[0m")).toBe("\x1b[2mstats only\x1b[0m");
  });

  it("insertIntoStatsLine preserves visible width for wide chars", () => {
    const line = `a${" ".repeat(20)}b`;
    const merged = insertIntoStatsLine(line, "—"); // em dash: 1 unit, 2 columns
    expect(merged).toBeDefined();
    expect(merged).toContain("—");
    expect(visibleWidth(merged!)).toBe(visibleWidth(line));
  });

  const footerData = {
    getGitBranch: () => undefined,
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () => new Map(),
  } as any;

  function makeTuiCtx(model: Record<string, unknown> = { id: "m", provider: "p", reasoning: false, contextWindow: 1_000 }) {
    const requestRender = vi.fn();
    let footerInstance: any;
    // 0.99's getSessionStats() caches on (session, sessionId, leafId,
    // entryCount, limitsModel) and only re-reads the ctx on a miss, so the
    // failure tests below move `entryCount` before breaking the ctx — that is
    // what a stale ctx looks like in practice, with the leaf already pointing
    // somewhere else.
    const session = { entryCount: 0 };
    // Real pi invokes the factory synchronously inside setFooter(...)
    // (interactive-mode.js: setExtensionFooter) — mirror that here.
    const setFooter = vi.fn((factory: any) => {
      footerInstance = factory ? factory({ requestRender }, {}, footerData) : undefined;
    });
    const ctx: any = {
      hasUI: true,
      mode: "tui",
      model,
      // 0.99's getSessionStats() keys its cache on these four, so the fake has
      // to answer all of them — getEntries() alone is the 0.86 shape.
      sessionManager: {
        getEntries: () => [],
        getEntryCount: () => session.entryCount,
        getSessionId: () => "session-1",
        getLeafId: () => "leaf-1",
        getCwd: () => "/tmp",
        getSessionName: () => undefined,
      },
      getContextUsage: () => ({ contextWindow: 1_000, percent: 57.3 }),
      ui: { setStatus, setFooter },
    };
    return { ctx, session, setFooter, requestRender, getFooter: () => footerInstance };
  }

  it("tui mode: installs a merged footer; updates re-render instead of setStatus", () => {
    const h = moduleHandlers();
    const { ctx, session, setFooter, requestRender, getFooter } = makeTuiCtx();
    h.sessionStart({ type: "session_start" }, ctx);
    expect(setFooter).toHaveBeenCalledTimes(1);
    // Leftover status cleared so TPS never shows on both lines.
    expect(setStatus).toHaveBeenCalledWith(TPS_STATUS_KEY, undefined);

    const comp = getFooter();

    h.start(assistantStart(), ctx);
    now = 1_300;
    h.update(update(), ctx);
    now = 1_600;
    h.update(update("abcd"), ctx);
    now = 1_700;
    h.end(assistantEnd({ usage: { output: 50 } }), ctx);
    // Merged path: no setStatus for the reading, but a re-render is requested.
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(requestRender).toHaveBeenCalled();

    const lines = comp.render(100);
    expect(lines).toHaveLength(2); // no status line — TPS lives on line 2
    expect(lines[1]).toContain("166.7 tok/s");
    expect(visibleWidth(lines[1])).toBe(100);

    // Cramped width: the gap fits no variant of the reading, so the footer
    // keeps Pi's two dim lines instead of growing a bright third one.
    const narrow = comp.render(20);
    expect(narrow).toHaveLength(2);
    expect(narrow[1]).not.toContain("tok/s");

    // Stale ctx (getContextUsage throws) → holds the last good frame. The
    // moved entry count is what makes the render re-read the ctx.
    session.entryCount++;
    ctx.getContextUsage = () => {
      throw new Error("stale");
    };
    expect(() => comp.render(100)).not.toThrow();

    h.shutdown({ type: "session_shutdown" }, ctx);
    expect(setFooter).toHaveBeenCalledWith(undefined); // built-in footer restored
  });

  it("rpc mode: falls back to the setStatus status line", () => {
    const h = moduleHandlers();
    const setFooter = vi.fn(); // RPC stub: accepts the factory, never invokes it
    const rpcCtx: any = { hasUI: true, mode: "rpc", ui: { setStatus, setFooter } };
    h.sessionStart({ type: "session_start" }, rpcCtx);
    expect(setFooter).not.toHaveBeenCalled(); // only tui mode installs a footer

    h.start(assistantStart(), rpcCtx);
    now = 1_300;
    h.update(update(), rpcCtx);
    now = 1_600;
    h.update(update("abcd"), rpcCtx);
    now = 1_700;
    h.end(assistantEnd({ usage: { output: 50 } }), rpcCtx);
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "166.7 tok/s · TTFT 0.3s");
  });

  it("two consecutive render failures abandon the merge for the status line", async () => {
    const h = moduleHandlers();
    const { ctx, session, setFooter, requestRender, getFooter } = makeTuiCtx();
    h.sessionStart({ type: "session_start" }, ctx);
    const comp = getFooter();

    h.start(assistantStart(), ctx);
    now = 1_300;
    h.update(update(), ctx);
    now = 1_600;
    h.update(update("abcd"), ctx);
    now = 1_700;
    h.end(assistantEnd({ usage: { output: 50 } }), ctx);
    expect(comp.render(100)[1]).toContain("166.7 tok/s");
    // Merged readings never touch the status channel; the one call so far is
    // session_start clearing a leftover status.
    expect(setStatus).toHaveBeenCalledTimes(1);

    // One failure is a stale ctx (session switch / reload) — the footer holds
    // its last good frame because session_start will rebuild it. The moved
    // entry count is what makes the render re-read the ctx at all (0.99 caches
    // the stats per cache key, and a throwing recompute never refills it).
    session.entryCount++;
    ctx.getContextUsage = () => {
      throw new Error("stale");
    };
    expect(() => comp.render(100)).not.toThrow();
    expect(setFooter).toHaveBeenCalledTimes(1); // still merged, nothing swapped

    // A second consecutive failure means the frame is not coming back on its
    // own, so the reading changes place instead of freezing in place.
    comp.render(100);
    await Promise.resolve(); // the swap is deferred past the failing render
    expect(setFooter).toHaveBeenLastCalledWith(undefined);
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "166.7 tok/s · TTFT 0.3s");

    // Subsequent measurements now go to the status screen line, and the
    // abandoned merge asks for no more re-renders.
    const renders = requestRender.mock.calls.length;
    now = 2_000;
    h.start(assistantStart(), ctx);
    now = 2_400;
    h.update(update(), ctx);
    now = 2_800;
    h.update(update("efgh"), ctx);
    h.end(assistantEnd({ usage: { output: 50 } }), ctx);
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "142.9 tok/s · TTFT 0.3s");
    expect(requestRender.mock.calls.length).toBe(renders);
  });

  it("only consecutive failures count — a good render resets the counter", () => {
    const h = moduleHandlers();
    const { ctx, session, setFooter, getFooter } = makeTuiCtx();
    h.sessionStart({ type: "session_start" }, ctx);
    const comp = getFooter();

    const healthy = ctx.getContextUsage;
    const breakCtx = () => {
      session.entryCount++; // moves the stats cache key past the last good frame
      ctx.getContextUsage = () => {
        throw new Error("stale");
      };
    };

    breakCtx();
    comp.render(100); // failure 1
    ctx.getContextUsage = healthy;
    comp.render(100); // success — the count starts over
    breakCtx();
    comp.render(100); // failure 1 again, still under the limit
    expect(setFooter).toHaveBeenCalledTimes(1); // never swapped
  });

  it("model_select refreshes the installed footer without reinstalling", () => {
    const h = moduleHandlers();
    const { ctx, setFooter, getFooter } = makeTuiCtx({ id: "old-model", provider: "p", reasoning: false, contextWindow: 1_000 });
    h.sessionStart({ type: "session_start" }, ctx);
    const comp = getFooter();
    expect(comp.render(100)[1]).toContain("old-model");

    h.modelSelect(
      {
        type: "model_select",
        model: { id: "new-model", provider: "p", reasoning: false, contextWindow: 1_000 },
        previousModel: { id: "old-model" },
        source: "set",
      },
      ctx,
    );
    const lines = comp.render(100);
    expect(lines[1]).toContain("new-model");
    expect(lines[1]).not.toContain("old-model");
    expect(setFooter).toHaveBeenCalledTimes(1); // proxy updated in place, no reinstall
  });

  it("message_end records the physical model behind a virtual selection", () => {
    const h = moduleHandlers();
    const virtualModel = {
      id: "virtual-model",
      provider: "p",
      api: "pi-virtual",
      reasoning: false,
      contextWindow: 1_000,
    };
    const physicalModel = {
      id: "physical-model",
      provider: "p",
      api: "anthropic-messages",
      reasoning: false,
      contextWindow: 1_000,
    };
    const { ctx, getFooter } = makeTuiCtx(virtualModel);
    // Pi resolves the route through its catalog and refuses an entry that is
    // itself virtual (dist/core/model-runtime.js:749) — the stub does both.
    ctx.modelRegistry = {
      find: (provider: string, id: string) =>
        [virtualModel, physicalModel].find((m) => m.provider === provider && m.id === id),
    };
    h.sessionStart({ type: "session_start" }, ctx);
    const comp = getFooter();
    expect(comp.render(100)[1]).not.toContain("→");

    // The response names a different model than the selected one: pi's footer
    // shows where the request was routed, with the level it answered at.
    h.start(assistantStart(), ctx);
    now = 1_300;
    h.update(update("abcd"), ctx);
    now = 1_600;
    h.end(
      assistantEnd({ provider: "p", model: "physical-model", thinkingLevel: "medium" }),
      ctx,
    );
    const routed = comp.render(100)[1];
    expect(routed).toContain("→ physical-model");
    expect(routed).toContain("medium");

    // An aborted response is not one pi's getter reads, so the route of the
    // last successful response stays on screen.
    h.start(assistantStart(), ctx);
    now = 1_700;
    h.update(update("abcd"), ctx);
    now = 1_800;
    h.end(assistantEnd({ provider: "p", model: "physical-model", stopReason: "aborted" }), ctx);
    expect(comp.render(100)[1]).toContain("→ physical-model");

    // A model switch drops the recorded route until the next response answers.
    h.modelSelect(
      {
        type: "model_select",
        model: virtualModel,
        previousModel: { id: "virtual-model" },
        source: "set",
      },
      ctx,
    );
    expect(comp.render(100)[1]).not.toContain("→");

    // A response that names the selection itself resolves to a virtual entry,
    // which pi refuses — the arrow stays away.
    h.start(assistantStart(), ctx);
    now = 2_300;
    h.update(update("efgh"), ctx);
    now = 2_600;
    h.end(assistantEnd({ provider: "p", model: "virtual-model" }), ctx);
    expect(comp.render(100)[1]).not.toContain("→");
  });

  it("records no route under a physical selection", () => {
    const h = moduleHandlers();
    const { ctx, getFooter } = makeTuiCtx({
      id: "m",
      provider: "p",
      api: "anthropic-messages",
      reasoning: false,
      contextWindow: 1_000,
    });
    ctx.modelRegistry = {
      find: () => ({
        id: "other-model",
        provider: "p",
        api: "anthropic-messages",
        reasoning: false,
        contextWindow: 1_000,
      }),
    };
    h.sessionStart({ type: "session_start" }, ctx);
    h.start(assistantStart(), ctx);
    now = 1_300;
    h.update(update("abcd"), ctx);
    now = 1_600;
    h.end(assistantEnd({ provider: "p", model: "other-model" }), ctx);
    // Pi's routedModel is undefined outside a virtual selection, so a response
    // naming another model is not a route.
    expect(getFooter().render(100)[1]).not.toContain("→");
  });

  it("thinking_level_select refreshes the installed footer", () => {
    const h = moduleHandlers();
    const { ctx, getFooter } = makeTuiCtx({ id: "m", provider: "p", reasoning: true, contextWindow: 1_000 });
    h.sessionStart({ type: "session_start" }, ctx);
    const comp = getFooter();
    expect(comp.render(100)[1]).toContain("thinking off");

    h.thinkingSelect({ type: "thinking_level_select", level: "high", previousLevel: "off" }, ctx);
    expect(comp.render(100)[1]).toContain("m • high");
  });
});

// ─── Skeleton wiring ──────────────────────────────────────────────────────

describe("tps — skeleton wiring", () => {
  function installWithTps() {
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
    const fakePi: any = {
      on(event: string, handler: (event: any, ctx: any) => any) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      getActiveTools: () => [],
      setActiveTools: () => {},
    };
    const sk = createSkeleton();
    sk.register(createTpsModule());
    sk.install(fakePi);
    return handlers;
  }

  it("installs one pi.on per message event the module uses", () => {
    const handlers = installWithTps();
    for (const event of ["message_start", "message_update", "message_end", "agent_end", "model_select", "thinking_level_select"]) {
      expect(handlers.get(event), `missing pi.on(${event})`).toHaveLength(1);
    }
    // Two lifecycle events have one more each: the skeleton's own
    // dependency check (session_start) and timer cleanup (session_shutdown).
    expect(handlers.get("session_start")).toHaveLength(2);
    expect(handlers.get("session_shutdown")).toHaveLength(2);
  });

  it("dispatches message_start in parallel mode (return value ignored)", async () => {
    const handlers = installWithTps();
    const result = await handlers.get("message_start")![0](assistantStart(), ctx);
    expect(result).toBeUndefined();
    // Fresh module with no completed value: revert is a no-op, nothing shown.
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("dispatches message_end in compose mode without replacing the message", async () => {
    const handlers = installWithTps();
    const event = assistantEnd();
    const result = await handlers.get("message_end")![0](event, ctx);
    // Our handler returns undefined → the compose chain must not rewrite it.
    expect(result).toBeUndefined();
  });
});
