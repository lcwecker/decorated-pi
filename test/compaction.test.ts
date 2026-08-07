import { describe, expect, it, vi } from "vitest";
import { compactionModule } from "../hooks/compaction.js";

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
