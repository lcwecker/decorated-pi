import { describe, it, expect } from "vitest";
import { __modelIntegrationTest } from "../hooks/compaction.js";

describe("model-integration compaction auto-resume", () => {
  it("marks threshold-based post-agent-end compaction as auto", () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 9000, cacheRead: 0, output: 100 },
      },
    ];

    const result = __modelIntegrationTest.shouldExpectAutoCompaction(
      messages,
      { tokens: 9_600, contextWindow: 10_000 },
      { enabled: true, reserveTokens: 500 },
    );

    expect(result).toBe(true);
  });

  it("marks overflow-based post-agent-end compaction as auto", () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "context length exceeded maximum context window",
      },
    ];

    const result = __modelIntegrationTest.shouldExpectAutoCompaction(
      messages,
      { tokens: null, contextWindow: 10_000 },
      { enabled: true, reserveTokens: 500 },
    );

    expect(result).toBe(true);
  });

  it("auto-resumes for pre-prompt automatic compaction", () => {
    const result = __modelIntegrationTest.shouldAutoResumeCompaction(
      true,
      null,
      { enabled: true, reserveTokens: 500 },
      undefined,
    );

    expect(result).toBe(true);
  });

  it("does not auto-resume without lifecycle markers", () => {
    const result = __modelIntegrationTest.shouldAutoResumeCompaction(
      false,
      null,
      { enabled: true, reserveTokens: 500 },
      undefined,
    );

    expect(result).toBe(false);
  });

  it("does not auto-resume when custom instructions are present", () => {
    const result = __modelIntegrationTest.shouldAutoResumeCompaction(
      true,
      null,
      { enabled: true, reserveTokens: 500 },
      "focus on blockers",
    );

    expect(result).toBe(false);
  });

  it("does not auto-resume for stale post-agent-end manual compaction", () => {
    const result = __modelIntegrationTest.shouldAutoResumeCompaction(
      false,
      {
        messages: [
          {
            role: "assistant",
            stopReason: "stop",
            usage: { input: 1000, cacheRead: 0, output: 100 },
          },
        ],
        usage: { tokens: 1_500, contextWindow: 10_000 },
      },
      { enabled: true, reserveTokens: 500 },
      undefined,
    );

    expect(result).toBe(false);
  });

  it("auto-resumes for post-agent-end automatic compaction candidates", () => {
    const result = __modelIntegrationTest.shouldAutoResumeCompaction(
      false,
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
      { enabled: true, reserveTokens: 500 },
      undefined,
    );

    expect(result).toBe(true);
  });
});
