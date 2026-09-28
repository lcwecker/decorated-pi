import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  compactionModule,
  resetAwaitingResume,
  MAX_CONSECUTIVE_RESUMES,
  RESUME_CUSTOM_TYPE,
} from "../hooks/compaction.js";

vi.mock("../settings.js", () => ({
  getCompactModelKey: vi.fn(() => "review/compact-model"),
  parseModelKey: (key: string) => {
    const [provider, modelId] = key.split("/");
    return provider && modelId ? { provider, modelId } : null;
  },
}));

function makePreparation(overrides: Record<string, any> = {}) {
  return {
    firstKeptEntryId: "entry-1",
    messagesToSummarize: [{ role: "assistant" as const, content: [{ type: "text", text: "old work" }], timestamp: 1 }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 1200,
    previousSummary: "Earlier context.",
    fileOps: {
      read: new Set(["src/a.ts", "src/b.ts"]),
      written: new Set(["src/b.ts"]),
      edited: new Set([]),
    },
    settings: { reserveTokens: 20000 },
    ...overrides,
  };
}

function makeEvent(prepOverrides: Record<string, any> = {}, overrides: Record<string, any> = {}) {
  return {
    preparation: makePreparation(prepOverrides),
    customInstructions: "focus on security",
    signal: undefined,
    ...overrides,
  };
}

function makeCtx(modelOverrides: Record<string, unknown> = {}, completeImpl?: any) {
  return {
    hasUI: false,
    modelRegistry: {
      find: () => ({ id: "compact-model", maxTokens: 8192, ...modelOverrides }),
      complete: completeImpl ?? (async (_model: any, _context: any, _options: any) => ({
        content: [{ type: "text", text: "the summary" }],
        usage: { input: 10, output: 5 },
      })),
    },
  };
}

describe("compaction session_before_compact", () => {
  it("summarizes through the model runtime and returns a CompactionResult", async () => {
    const handler = compactionModule.hooks.session_before_compact![0] as any;
    let captured: any;
    const ctx = makeCtx({}, async (model: any, context: any, options: any) => {
      captured = { model, context, options };
      return { content: [{ type: "text", text: "the summary" }], usage: { input: 10, output: 5 } };
    });
    const event = makeEvent();

    const result = await handler(event, ctx);

    expect(captured.model.id).toBe("compact-model");
    expect(captured.context.messages[0].role).toBe("user");
    expect(captured.context.messages[0].content[0].text).toContain("Earlier context.");
    expect(captured.context.messages[0].content[0].text).toContain("focus on security");
    expect(captured.context.messages[0].content[0].text).toContain("old work");
    // Bounded by both the reserve-token budget and the model's output limit.
    expect(captured.options.maxTokens).toBe(8192);
    expect(captured.options.cacheRetention).toBe("none");
    expect(typeof captured.options.sessionId).toBe("string");
    expect(captured.options.sessionId).not.toHaveLength(0);
    expect(result).toEqual({
      compaction: {
        summary: "the summary\n\n<read-files>\nsrc/a.ts\n</read-files>\n\n<modified-files>\nsrc/b.ts\n</modified-files>",
        firstKeptEntryId: "entry-1",
        tokensBefore: 1200,
        usage: { input: 10, output: 5 },
        details: { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] },
      },
    });
  });

  it("bounds maxTokens by the reserve-token budget when the model has no limit", async () => {
    const handler = compactionModule.hooks.session_before_compact![0] as any;
    let captured: any;
    const ctx = makeCtx({ maxTokens: 0 }, async (_model: any, _context: any, options: any) => {
      captured = options;
      return { content: [{ type: "text", text: "s" }] };
    });
    await handler(makeEvent(), ctx);
    expect(captured.maxTokens).toBe(16000); // 0.8 * reserveTokens(20000)
  });

  it("skips the file-operation section when no files were touched", async () => {
    const handler = compactionModule.hooks.session_before_compact![0] as any;
    let captured: any;
    const ctx = makeCtx({}, async (_model: any, context: any, options: any) => {
      captured = { context, options };
      return { content: [{ type: "text", text: "the summary" }] };
    });
    const event = makeEvent({ fileOps: { read: new Set(), written: new Set(), edited: new Set() } });
    const result = await handler(event, ctx);
    expect(result.compaction.summary).toBe("the summary");
    expect(result.compaction.details).toEqual({ readFiles: [], modifiedFiles: [] });
  });

  it("falls through to default compaction when complete throws", async () => {
    const handler = compactionModule.hooks.session_before_compact![0] as any;
    const ctx = makeCtx({}, async () => { throw new Error("boom"); });
    const result = await handler(makeEvent(), ctx);
    expect(result).toBeUndefined();
  });

  it("returns undefined for an empty summary", async () => {
    const handler = compactionModule.hooks.session_before_compact![0] as any;
    const ctx = makeCtx({}, async () => ({ content: [] }));
    expect(await handler(makeEvent(), ctx)).toBeUndefined();
  });

  it("falls through when no compact model is configured", async () => {
    const { getCompactModelKey } = await import("../settings.js");
    vi.mocked(getCompactModelKey).mockReturnValueOnce("");
    const handler = compactionModule.hooks.session_before_compact![0] as any;
    const ctx = {
      hasUI: false,
      modelRegistry: { find: () => undefined, complete: async () => { throw new Error("must not be called"); } },
    };
    expect(await handler(makeEvent(), ctx)).toBeUndefined();
  });
});

// ─── Auto-resume ──────────────────────────────────────────────────────────
//
// Pi continues on its own after overflow recovery and after a threshold
// compaction that lands mid-run. The settle boundary covers the remaining
// case: an auto-compaction that finished the run.

function makeResumeCtx(sessionId = "session-a") {
  return { sessionManager: { getSessionId: () => sessionId } };
}

const autoResume = {
  input: (ctx: any = makeResumeCtx()) => (compactionModule.hooks.input![0] as any)({}, ctx, {}),
  agentStart: (ctx: any = makeResumeCtx()) => (compactionModule.hooks.agent_start![0] as any)({}, ctx, {}),
  assistantMessageEnd: (ctx: any = makeResumeCtx()) =>
    (compactionModule.hooks.message_end![0] as any)({ message: { role: "assistant" } }, ctx, {}),
  compacted: (reason: string, willRetry = false, ctx: any = makeResumeCtx()) =>
    (compactionModule.hooks.session_compact![0] as any)({ reason, willRetry }, ctx, {}),
  settle: (overrides: Record<string, any> = {}, ctx: any = makeResumeCtx()) =>
    (compactionModule.hooks.agent_before_settle![0] as any)(
      { outcome: "completed", entries: [], continue: false, ...overrides },
      ctx,
      {},
    ),
};

describe("compaction auto-resume", () => {
  beforeEach(() => {
    resetAwaitingResume();
  });

  it("resumes once after an auto-compaction that ended the run", async () => {
    await autoResume.compacted("threshold");

    const result = await autoResume.settle();

    expect(result.continue).toBe(true);
    expect(result.entries).toEqual([
      {
        type: "custom_message",
        customType: RESUME_CUSTOM_TYPE,
        content: expect.stringContaining("auto-compacted"),
        display: false,
      },
    ]);
    // Consumed: the next settle boundary must stay quiet.
    expect(await autoResume.settle()).toBeUndefined();
  });

  it("never resumes after a manual /compact", async () => {
    await autoResume.compacted("manual");
    expect(await autoResume.settle()).toBeUndefined();
  });

  it("stays quiet when pi retries the aborted turn itself", async () => {
    // Overflow recovery with willRetry: pi calls agent.continue(), so a resume
    // of ours would add a second turn.
    await autoResume.compacted("overflow", true);
    expect(await autoResume.settle()).toBeUndefined();
  });

  it("stays quiet once pi's own overflow retry starts a run", async () => {
    await autoResume.compacted("overflow");
    await autoResume.agentStart();
    expect(await autoResume.settle()).toBeUndefined();
  });

  it("stays quiet when a mid-run compaction is followed by an assistant message", async () => {
    await autoResume.compacted("threshold");
    await autoResume.assistantMessageEnd();
    expect(await autoResume.settle()).toBeUndefined();
  });

  it("leaves errored and aborted runs to pi", async () => {
    await autoResume.compacted("threshold");
    expect(await autoResume.settle({ outcome: "error" })).toBeUndefined();

    await autoResume.compacted("threshold");
    expect(await autoResume.settle({ outcome: "aborted" })).toBeUndefined();

    // Both settles consumed the request, so a following completed run is not
    // resumed out of a stale pending flag.
    expect(await autoResume.settle()).toBeUndefined();
  });

  it("caps back-to-back resumes until the user submits input again", async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_RESUMES; i++) {
      await autoResume.compacted("threshold");
      expect((await autoResume.settle()).continue).toBe(true);
    }

    await autoResume.compacted("threshold");
    expect(await autoResume.settle()).toBeUndefined();

    // A user turn starts a fresh budget.
    await autoResume.input();
    await autoResume.compacted("threshold");
    expect((await autoResume.settle()).continue).toBe(true);
  });

  it("keeps resume state per session", async () => {
    const a = makeResumeCtx("session-a");
    const b = makeResumeCtx("session-b");

    await autoResume.compacted("threshold", false, a);
    // Session B finishing a run must not consume session A's resume.
    await autoResume.agentStart(b);
    await autoResume.settle({}, b);

    expect((await autoResume.settle({}, a)).continue).toBe(true);
  });

  it("appends its entry to entries proposed by other handlers", async () => {
    await autoResume.compacted("threshold");
    const proposed = [{ type: "custom", customType: "other", data: { a: 1 } }];

    const result = await autoResume.settle({ entries: proposed, continue: true });

    expect(result.entries[0]).toEqual(proposed[0]);
    expect(result.entries).toHaveLength(2);
    expect(result.continue).toBe(true);
  });

  it("proposes nothing when it has no resume to make", async () => {
    const proposed = [{ type: "custom", customType: "other", data: { a: 1 } }];
    expect(await autoResume.settle({ entries: proposed, continue: true })).toBeUndefined();
  });

  it("message_end leaves the message untouched for later handlers", async () => {
    const handler = compactionModule.hooks.message_end![0] as any;
    expect(await handler({ message: { role: "assistant" } }, makeResumeCtx(), {})).toBeUndefined();
  });
});
