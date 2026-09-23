/**
 * tps — live tokens-per-second in the footer status bar.
 *
 * Pins:
 *  - pure math: estimateTokens / calcDecodeTps / formatTps / formatTtft
 *  - the message lifecycle: window reset on assistant message_start, throttled
 *    `~` estimate during message_update, frozen exact value at message_end
 *  - keep-last-completed: a new message_start, an aborted run, or an empty
 *    message_end reverts to the last completed value instead of blanking;
 *    only session boundaries truly clear; a live `~` estimate is never frozen
 *  - "no misleading numbers": aborted / missing usage never freezes a partial
 *    window; a non-streaming reply shows an em dash instead of a rate
 *  - the frozen value survives agent_end; stale/headless ctx never throws
 *  - the footer merge: insertIntoStatsLine inlines TPS into the stats line
 *    (length-preserving), tui mode installs a FooterComponent subclass via
 *    setFooter, rpc mode falls back to the setStatus status line
 *  - the skeleton dispatches message_start / message_update (parallel) and
 *    message_end (compose, no replacement) to the module
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createTpsModule,
  estimateTokens,
  calcDecodeTps,
  formatTps,
  formatTtft,
  insertIntoStatsLine,
  splitChars,
  TPS_STATUS_KEY,
} from "../hooks/tps.js";
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
  it("estimateTokens converts chars at 4 chars/token, minimum 1", () => {
    expect(estimateTokens(0)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
    expect(estimateTokens(1_000)).toBe(250);
  });

  it("estimateTokens counts non-ASCII (CJK) chars near 1 token each", () => {
    // 4 Chinese chars ≈ 4 tokens, not 1 — the old chars/4 read ~4x low.
    expect(estimateTokens(0, 4)).toBe(4);
    expect(estimateTokens(4, 4)).toBe(5);
    expect(estimateTokens(0, 0)).toBe(1);
  });

  it("splitChars separates ASCII from non-ASCII", () => {
    expect(splitChars("abcd")).toEqual({ ascii: 4, other: 0 });
    expect(splitChars("你好")).toEqual({ ascii: 0, other: 2 });
    expect(splitChars("a你b好")).toEqual({ ascii: 2, other: 2 });
    expect(splitChars("")).toEqual({ ascii: 0, other: 0 });
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
  it("freezes the exact value at message_end after a throttled live estimate", () => {
    const h = moduleHandlers();

    now = 1_000;
    h.start(assistantStart(), ctx);
    expect(setStatus).not.toHaveBeenCalled(); // fresh: nothing completed yet

    now = 1_100;
    h.start({ type: "message_start", message: { role: "user" } }, ctx);
    expect(setStatus).not.toHaveBeenCalled(); // non-assistant messages are ignored

    now = 1_200;
    h.update(update(), ctx); // first streamed event → tFirst; too early to render
    expect(setStatus).not.toHaveBeenCalled();

    now = 1_500;
    h.update(update("abcd"), ctx); // 1 est token over 300ms
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "~3.3 tok/s");

    now = 1_600;
    h.update(update("efgh"), ctx); // within the 400ms throttle window
    expect(setStatus).toHaveBeenCalledTimes(1);

    now = 1_900;
    h.update(update("ijkl"), ctx); // 3 est tokens over 700ms
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "~4.3 tok/s");

    now = 2_200;
    h.end(assistantEnd({ usage: { output: 50 } }), ctx); // 50 tokens / 700ms
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "71.4 tok/s · TTFT 0.2s");

    // Frozen: later updates and agent_end must not overwrite it.
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

  it("reverts to the last completed value instead of blanking", () => {
    const h = moduleHandlers();
    // First run freezes an exact value (50 tokens over 300ms).
    h.start(assistantStart(), ctx);
    now = 1_200;
    h.update(update(), ctx);
    now = 1_500;
    h.update(update("abcd"), ctx);
    h.end(assistantEnd({ usage: { output: 50 } }), ctx);
    const frozen = "166.7 tok/s · TTFT 0.2s";
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, frozen);

    // Second run: message_start must not blank the screen (prefill gap) —
    // the frozen value stays until fresh data arrives.
    const calls = setStatus.mock.calls.length;
    h.start(assistantStart(), ctx);
    expect(setStatus).toHaveBeenCalledTimes(calls);

    now = 3_000;
    h.update(update(), ctx);
    now = 3_400;
    h.update(update("xy"), ctx); // live "~2.5 tok/s" replaces the frozen value
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "~2.5 tok/s");

    // ...and a new message_start reverts that live estimate back to frozen.
    h.start(assistantStart(), ctx);
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, frozen);
  });

  it("an aborted run reverts to the last completed value (never freezes `~`)", () => {
    const h = moduleHandlers();
    h.start(assistantStart(), ctx);
    now = 1_200;
    h.update(update(), ctx);
    now = 1_500;
    h.update(update("abcd"), ctx);
    h.end(assistantEnd({ usage: { output: 50 } }), ctx);
    const frozen = "166.7 tok/s · TTFT 0.2s";

    h.start(assistantStart(), ctx);
    now = 3_000;
    h.update(update(), ctx);
    now = 3_400;
    h.update(update("xy"), ctx);
    h.end(assistantEnd({ stopReason: "aborted" }), ctx);
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, frozen);
  });

  it("a message with no usage reverts to the last completed value", () => {
    const h = moduleHandlers();
    h.start(assistantStart(), ctx);
    now = 1_200;
    h.update(update(), ctx);
    now = 1_500;
    h.update(update("abcd"), ctx);
    h.end(assistantEnd({ usage: { output: 50 } }), ctx);
    const frozen = "166.7 tok/s · TTFT 0.2s";

    h.start(assistantStart(), ctx);
    now = 3_000;
    h.update(update(), ctx);
    now = 3_400;
    h.update(update("xy"), ctx);
    h.end(assistantEnd({ usage: { output: 0 } }), ctx);
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, frozen);
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
    h.start(assistantStart(), ctx);
    now = 10_000;
    h.update(update(), ctx);
    now = 10_400;
    h.update(update("xy"), ctx); // 1 est token over 400ms of THIS message
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "~2.5 tok/s");
  });

  it("stays blank when nothing ever completed", () => {
    const h = moduleHandlers();
    h.start(assistantStart(), ctx);
    h.end(assistantEnd(), ctx);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("shows an em dash for a non-streaming reply (zero-width window)", () => {
    const h = moduleHandlers();
    h.start(assistantStart(), ctx);
    now = 1_200;
    h.update(update("done in one shot"), ctx);
    h.end(assistantEnd({ stopReason: "stop" }), ctx);
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "—");
  });

  it("live estimate counts Chinese near 1 token per char", () => {
    const h = moduleHandlers();
    h.start(assistantStart(), ctx);
    now = 1_200;
    h.update(update(), ctx);
    now = 1_500;
    h.update(update("你好世界"), ctx); // 4 CJK chars ≈ 4 tokens over 300ms
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "~13.3 tok/s");
  });

  it("ignores message_update without a stream event instead of throwing", () => {
    const h = moduleHandlers();
    h.start(assistantStart(), ctx);
    now = 1_500;
    // Pi always sends assistantMessageEvent today; pin the guard so a future
    // shape change (or refactor dropping the guard) fails loudly, not silently.
    const malformed = { type: "message_update", message: { role: "assistant" }, assistantMessageEvent: undefined };
    expect(() => h.update(malformed, ctx)).not.toThrow();
    expect(setStatus).not.toHaveBeenCalled(); // fresh module: start no longer clears, nothing rendered yet
  });

  it("agent_end only clears a run that died mid-stream", () => {
    const h = moduleHandlers();
    h.start(assistantStart(), ctx);
    now = 1_200;
    h.update(update(), ctx);
    now = 1_500;
    h.update(update("abcd"), ctx);
    h.agentEnd({ type: "agent_end", messages: [] }, ctx);
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, undefined);
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
      h.update(update("abcd"), staleCtx); // live render → throwing setStatus
      h.end(assistantEnd({ stopReason: "aborted" }), staleCtx); // revert → throwing setStatus
    }).not.toThrow();
    // Headless mode: hasUI false → no footer, no call.
    const headless: any = { hasUI: false, ui: { setStatus } };
    h.start(assistantStart(), headless);
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
    // Real pi invokes the factory synchronously inside setFooter(...)
    // (interactive-mode.js: setExtensionFooter) — mirror that here.
    const setFooter = vi.fn((factory: any) => {
      footerInstance = factory ? factory({ requestRender }, {}, footerData) : undefined;
    });
    const ctx: any = {
      hasUI: true,
      mode: "tui",
      model,
      sessionManager: { getEntries: () => [], getCwd: () => "/tmp", getSessionName: () => undefined },
      getContextUsage: () => ({ contextWindow: 1_000, percent: 57.3 }),
      ui: { setStatus, setFooter },
    };
    return { ctx, setFooter, requestRender, getFooter: () => footerInstance };
  }

  it("tui mode: installs a merged footer; updates re-render instead of setStatus", () => {
    const h = moduleHandlers();
    const { ctx, setFooter, requestRender, getFooter } = makeTuiCtx();
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
    // Merged path: no setStatus for the live value, but a re-render is requested.
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(requestRender).toHaveBeenCalled();

    const lines = comp.render(100);
    expect(lines).toHaveLength(2); // no status line — TPS lives on line 2
    expect(lines[1]).toContain("~3.3 tok/s");
    expect(visibleWidth(lines[1])).toBe(100);

    // Cramped width: no room in the padding → falls back to a pushed line.
    const narrow = comp.render(20);
    expect(narrow).toHaveLength(3);
    expect(narrow[2]).toContain("~3.3 tok/s");

    // Stale ctx (getContextUsage throws) → holds the last good frame.
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
    expect(setStatus).toHaveBeenLastCalledWith(TPS_STATUS_KEY, "~3.3 tok/s");
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
