/**
 * Skeleton — the only place that calls pi.on(...) for hooks.
 *
 * These tests pin the contract:
 *  - module registration order = execution order
 *  - compose events (before_agent_start, tool_call, tool_result) chain
 *  - dependency check fires only on session_start reasons "startup" / "reload"
 *  - dependency notification is deferred with setTimeout(0) so it survives
 *    pi's UI rebuild on /reload
 *  - session_shutdown clears any pending notify timer
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSkeleton, type Module, type HookEvent } from "../hooks/skeleton.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

interface FakePi {
  on: (event: string, handler: (...args: any[]) => any) => void;
  handlers: Map<string, Array<(...args: any[]) => any>>;
}

function makePi(): FakePi {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  return {
    handlers,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
}

interface FakeCtx {
  hasUI: boolean;
  ui: { notify: ReturnType<typeof vi.fn> };
  cwd?: string;
}

function makeCtx(overrides: Partial<FakeCtx> = {}): FakeCtx {
  return {
    hasUI: true,
    ui: { notify: vi.fn() },
    ...overrides,
  };
}

function flushTimers() {
  return new Promise<void>((resolve) => setTimeout(resolve, 10));
}

// ─── Module hook dispatch ─────────────────────────────────────────────────

describe("skeleton — module hook dispatch", () => {
  let pi: FakePi;
  beforeEach(() => {
    pi = makePi();
  });

  it("runs parallel handlers in registration order", async () => {
    const order: string[] = [];
    const sk = createSkeleton();
    sk.register({
      name: "first",
      hooks: {
        session_start: [() => { order.push("first"); }],
      },
    });
    sk.register({
      name: "second",
      hooks: {
        session_start: [() => { order.push("second"); }],
      },
    });
    sk.install(pi as any);

    const handler = pi.handlers.get("session_start")![0];
    await handler({ reason: "startup" }, makeCtx() as any);
    expect(order).toEqual(["first", "second"]);
  });

  it("chains compose events and returns mutated event", async () => {
    const sk = createSkeleton();
    sk.register({
      name: "a",
      hooks: {
        tool_call: [(_e: any, ctx: any) => ({ command: "x" })],
      },
    });
    sk.register({
      name: "b",
      hooks: {
        tool_call: [(e: any) => ({ ...e, args: { foo: 1 } })],
      },
    });
    sk.install(pi as any);

    const handler = pi.handlers.get("tool_call")![0];
    const result = await handler({ command: "x" }, makeCtx() as any);
    expect(result).toEqual({ command: "x", args: { foo: 1 } });
  });

  it("returns undefined when compose handlers don't change the event", async () => {
    const sk = createSkeleton();
    sk.register({
      name: "noop",
      hooks: {
        tool_call: [() => undefined],
      },
    });
    sk.install(pi as any);

    const handler = pi.handlers.get("tool_call")![0];
    const result = await handler({ command: "x" }, makeCtx() as any);
    expect(result).toBeUndefined();
  });

  it("invokes parallel handlers with (event, ctx, pi)", async () => {
    const seen: any[] = [];
    const sk = createSkeleton();
    sk.register({
      name: "test",
      hooks: {
        session_start: [(_e, ctx, p) => { seen.push({ ctx, pi: p }); }],
      },
    });
    sk.install(pi as any);

    const ctx = makeCtx();
    await pi.handlers.get("session_start")![0]({ reason: "startup" }, ctx as any);
    expect(seen[0].ctx).toBe(ctx);
    expect(seen[0].pi).toBe(pi);
  });

  it("skips empty event groups (from modules)", () => {
    const sk = createSkeleton();
    sk.register({
      name: "empty",
      hooks: {
        // session_start is always registered by the skeleton itself for
        // the dependency check; the empty array here should NOT add a
        // second handler.
        agent_end: [() => {}],
      },
    });
    sk.install(pi as any);
    // Only one session_start handler (the skeleton's dependency check), no module handler.
    expect(pi.handlers.get("session_start")!.length).toBe(1);
    // agent_end has exactly one handler from the module.
    expect(pi.handlers.get("agent_end")!.length).toBe(1);
  });
});

// ─── Dependency check — timing & deferral ────────────────────────────────

describe("skeleton — dependency check", () => {
  let pi: FakePi;
  beforeEach(() => {
    vi.useFakeTimers();
    pi = makePi();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires on session_start with reason='startup'", async () => {
    const sk = createSkeleton();
    sk.declareDependency({ label: "rtk", check: () => false });
    sk.install(pi as any);

    const ctx = makeCtx();
    await pi.handlers.get("session_start")![0]({ reason: "startup" }, ctx as any);
    expect(ctx.ui.notify).not.toHaveBeenCalled(); // not yet — setTimeout is pending
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "[decorated-pi] missing dependencies: rtk",
      "info",
    );
  });

  it("fires on session_start with reason='reload'", async () => {
    const sk = createSkeleton();
    sk.declareDependency({ label: "wakatime-cli", check: () => false });
    sk.install(pi as any);

    const ctx = makeCtx();
    await pi.handlers.get("session_start")![0]({ reason: "reload" }, ctx as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "[decorated-pi] missing dependencies: wakatime-cli",
      "info",
    );
  });

  it("skips session_start with reason='new' / 'resume' / 'fork'", async () => {
    const sk = createSkeleton();
    sk.declareDependency({ label: "rtk", check: () => false });
    sk.install(pi as any);

    for (const reason of ["new", "resume", "fork"] as const) {
      const ctx = makeCtx();
      await pi.handlers.get("session_start")![0]({ reason }, ctx as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    }
  });

  it("defers notification with setTimeout(0) so it survives UI rebuild", async () => {
    const sk = createSkeleton();
    sk.declareDependency({ label: "rtk", check: () => false });
    sk.install(pi as any);

    const ctx = makeCtx();
    await pi.handlers.get("session_start")![0]({ reason: "reload" }, ctx as any);
    // Synchronously after session_start returns, nothing should have been notified yet
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    // After the 0-delay timer fires, the notification is sent
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  });

  it("does nothing when all dependencies are satisfied", async () => {
    const sk = createSkeleton();
    sk.declareDependency({ label: "rtk", check: () => true });
    sk.declareDependency({ label: "wakatime-cli", check: () => true });
    sk.install(pi as any);

    const ctx = makeCtx();
    await pi.handlers.get("session_start")![0]({ reason: "startup" }, ctx as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("joins multiple missing labels with commas", async () => {
    const sk = createSkeleton();
    sk.declareDependency({ label: "lsp:gopls", check: () => false });
    sk.declareDependency({ label: "lsp:jdtls", check: () => false });
    sk.declareDependency({ label: "mcp:exa", check: () => false });
    sk.declareDependency({ label: "typescript-language-server", check: () => true });
    sk.install(pi as any);

    const ctx = makeCtx();
    await pi.handlers.get("session_start")![0]({ reason: "startup" }, ctx as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "[decorated-pi] missing dependencies: lsp:gopls, lsp:jdtls, mcp:exa",
      "info",
    );
  });

  it("treats a throwing check() as missing (no crash)", async () => {
    const sk = createSkeleton();
    sk.declareDependency({ label: "boom", check: () => { throw new Error("nope"); } });
    sk.install(pi as any);

    const ctx = makeCtx();
    await pi.handlers.get("session_start")![0]({ reason: "startup" }, ctx as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "[decorated-pi] missing dependencies: boom",
      "info",
    );
  });

  it("swallows notify() throws (stale ctx after reload race)", async () => {
    const sk = createSkeleton();
    sk.declareDependency({ label: "rtk", check: () => false });
    sk.install(pi as any);

    const ctx = makeCtx({ ui: { notify: vi.fn(() => { throw new Error("ctx stale"); }) } });
    await pi.handlers.get("session_start")![0]({ reason: "reload" }, ctx as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.ui.notify).toHaveBeenCalled();
    // No uncaught exception escapes
  });

  it("skips notification when ctx.hasUI is false", async () => {
    const sk = createSkeleton();
    sk.declareDependency({ label: "rtk", check: () => false });
    sk.install(pi as any);

    const ctx = makeCtx({ hasUI: false });
    await pi.handlers.get("session_start")![0]({ reason: "startup" }, ctx as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("clears a pending notify timer on session_shutdown", async () => {
    const sk = createSkeleton();
    sk.declareDependency({ label: "rtk", check: () => false });
    sk.install(pi as any);

    const ctx = makeCtx();
    await pi.handlers.get("session_start")![0]({ reason: "reload" }, ctx as any);
    // Timer is pending. Fire session_shutdown before the timer runs.
    await pi.handlers.get("session_shutdown")![0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("session_shutdown without a pending timer is a no-op", async () => {
    const sk = createSkeleton();
    sk.install(pi as any);
    // No prior session_start → no timer. Should not throw.
    await expect(pi.handlers.get("session_shutdown")![0]()).resolves.toBeUndefined();
  });
});

// ─── Dependency check — re-check semantics ─────────────────────────────────

describe("skeleton — dependency check re-runs per session_start", () => {
  let pi: FakePi;
  beforeEach(() => {
    vi.useFakeTimers();
    pi = makePi();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-evaluates check() on each session_start (install → install → install)", async () => {
    // Simulate /reload: new skeleton instance, fresh dep state.
    const sk1 = createSkeleton();
    let depOk = false;
    sk1.declareDependency({ label: "rtk", check: () => depOk });
    sk1.install(pi as any);

    const ctx1 = makeCtx();
    await pi.handlers.get("session_start")![0]({ reason: "reload" }, ctx1 as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx1.ui.notify).toHaveBeenCalled();

    // Second "reload" — user installed rtk, now dep is satisfied.
    pi = makePi();
    const sk2 = createSkeleton();
    depOk = true;
    sk2.declareDependency({ label: "rtk", check: () => depOk });
    sk2.install(pi as any);

    const ctx2 = makeCtx();
    await pi.handlers.get("session_start")![0]({ reason: "reload" }, ctx2 as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx2.ui.notify).not.toHaveBeenCalled();
  });
});

// ─── inspect() ───────────────────────────────────────────────────────────

describe("skeleton — inspect()", () => {
  it("returns modules, events, and dependencies", () => {
    const sk = createSkeleton();
    sk.register({
      name: "alpha",
      hooks: { session_start: [() => {}] },
    });
    sk.register({
      name: "beta",
      hooks: { agent_end: [() => {}], session_start: [() => {}] },
    });
    sk.declareDependency({ label: "rtk", hint: "install rtk" });

    const info = sk.inspect();
    expect(info.modules).toEqual(["alpha", "beta"]);
    expect(info.events.session_start).toEqual([
      { module: "alpha", order: 0 },
      { module: "beta", order: 1 },
    ]);
    expect(info.events.agent_end).toEqual([{ module: "beta", order: 0 }]);
    expect(info.dependencies).toEqual([{ label: "rtk", hint: "install rtk" }]);
  });

  it("returns empty inspection for a fresh skeleton", () => {
    const sk = createSkeleton();
    expect(sk.inspect()).toEqual({ modules: [], events: {}, dependencies: [] });
  });
});

// ─── systemPromptOptions sorting (cache stability) ────────────────────────

describe("skeleton — before_agent_start system-prompt sort", () => {
  it("sorts toolSnippets and selectedTools alphabetically", async () => {
    const pi = makePi();
    const sk = createSkeleton();
    sk.install(pi as any);

    const event = {
      systemPromptOptions: {
        toolSnippets: { zeta: "z", alpha: "a", mu: "m" },
        selectedTools: ["zeta", "alpha", "mu"],
        promptGuidelines: ["b", "a", "c"],
      },
    };
    await pi.handlers.get("before_agent_start")![0](event, makeCtx() as any);

    expect(Object.keys(event.systemPromptOptions.toolSnippets)).toEqual([
      "alpha", "mu", "zeta",
    ]);
    expect(event.systemPromptOptions.selectedTools).toEqual(["alpha", "mu", "zeta"]);
    expect(event.systemPromptOptions.promptGuidelines).toEqual(["a", "b", "c"]);
  });

  it("sorts skills by name", async () => {
    const pi = makePi();
    const sk = createSkeleton();
    sk.install(pi as any);

    const event = {
      systemPromptOptions: {
        skills: [
          { name: "zeta", description: "z", filePath: "/z" },
          { name: "alpha", description: "a", filePath: "/a" },
        ],
      },
    };
    await pi.handlers.get("before_agent_start")![0](event, makeCtx() as any);
    expect(event.systemPromptOptions.skills.map((s: any) => s.name)).toEqual([
      "alpha", "zeta",
    ]);
  });

  it("is a no-op when systemPromptOptions is absent", async () => {
    const pi = makePi();
    const sk = createSkeleton();
    sk.install(pi as any);

    const event = {};
    const result = await pi.handlers.get("before_agent_start")![0](event, makeCtx() as any);
    expect(result).toBeUndefined();
    expect(event).toEqual({});
  });
});
