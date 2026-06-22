import { describe, it, expect } from "vitest";
import { __modelIntegrationTest } from "../hooks/compaction.js";

describe("model-integration compaction auto-resume", () => {
  it("auto-resumes on overflow (mirrors pi's willRetry=true path)", () => {
    const result = __modelIntegrationTest.shouldAutoResumeCompaction(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "context length exceeded maximum context window",
          },
        ],
        usage: { tokens: null, contextWindow: 10_000 },
      },
      { enabled: true },
      undefined,
    );

    expect(result).toBe(true);
  });

  it("does NOT auto-resume on threshold compaction (mirrors pi's willRetry=false path)", () => {
    // Pi runs auto-compact when tokens > contextWindow - reserveTokens but
    // does NOT auto-resume for it — user continues manually. Match that.
    const result = __modelIntegrationTest.shouldAutoResumeCompaction(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "stop",
            usage: { input: 9000, cacheRead: 0, output: 100 },
          },
        ],
        usage: { tokens: 9_600, contextWindow: 10_000 },
      },
      { enabled: true },
      undefined,
    );

    expect(result).toBe(false);
  });

  it("does not auto-resume without a post-agent-end candidate", () => {
    const result = __modelIntegrationTest.shouldAutoResumeCompaction(
      null,
      { enabled: true },
      undefined,
    );

    expect(result).toBe(false);
  });

  it("does not auto-resume when custom instructions are present (manual /compact)", () => {
    const result = __modelIntegrationTest.shouldAutoResumeCompaction(
      null,
      { enabled: true },
      "focus on blockers",
    );

    expect(result).toBe(false);
  });

  it("does not auto-resume when compaction is disabled in settings", () => {
    const result = __modelIntegrationTest.shouldAutoResumeCompaction(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "context length exceeded maximum context window",
          },
        ],
        usage: { tokens: null, contextWindow: 10_000 },
      },
      { enabled: false },
      undefined,
    );

    expect(result).toBe(false);
  });
});
