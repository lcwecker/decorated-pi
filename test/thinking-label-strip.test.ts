import { describe, it, expect } from "vitest";
import { stripThinkingLabels, thinkingLabelStripModule } from "../hooks/thinking-label-strip.js";

describe("stripThinkingLabels", () => {
  it("returns input unchanged when no tag present", () => {
    const s = "just some reasoning, no tags here";
    expect(stripThinkingLabels(s)).toBe(s);
  });

  it("strips leading <thinking> and trailing </thinking>, keeps inner text", () => {
    expect(stripThinkingLabels("<thinking>hello world</thinking>")).toBe("hello world");
  });

  it("strips a lone leading <thinking> (no close)", () => {
    expect(stripThinkingLabels("<thinking>step 1\nstep 2")).toBe("step 1\nstep 2");
  });

  it("strips a lone trailing </thinking> (no open)", () => {
    expect(stripThinkingLabels("step 1\nstep 2</thinking>")).toBe("step 1\nstep 2");
  });

  it("preserves inner whitespace and newlines", () => {
    expect(
      stripThinkingLabels("<thinking>\n  step 1\n  step 2\n</thinking>"),
    ).toBe("\n  step 1\n  step 2\n");
  });

  it("tolerates whitespace before leading open / after trailing close", () => {
    expect(stripThinkingLabels("  <thinking>kept</thinking>  ")).toBe("kept");
  });

  it("leaves tags buried in the middle untouched (part of reasoning text)", () => {
    const s = "I will use <thinking> as a marker then </thinking> to close";
    expect(stripThinkingLabels(s)).toBe(s);
  });

  it("only trims head/tail once — middle pairs stay", () => {
    // a middle pair is part of the text; only a head open / tail close are stripped
    expect(
      stripThinkingLabels("<thinking>a</thinking> mid <thinking>b</thinking>"),
    ).toBe("a</thinking> mid <thinking>b");
  });

  it("is case-sensitive (does not strip <Thinking>)", () => {
    const s = "<Thinking>not matched</Thinking>";
    expect(stripThinkingLabels(s)).toBe(s);
  });
});

describe("thinkingLabelStripModule hook", () => {
  const handler = thinkingLabelStripModule.hooks.message_end![0] as (e: any) => any;

  it("returns undefined for non-assistant message", () => {
    expect(handler({ message: { role: "user", content: [] } })).toBeUndefined();
  });

  it("returns undefined when content has no thinking block", () => {
    expect(
      handler({ message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
    ).toBeUndefined();
  });

  it("returns undefined when thinking block has no <thinking> tag", () => {
    expect(
      handler({
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "plain reasoning" }],
        },
      }),
    ).toBeUndefined();
  });

  it("strips the tag and returns a replacement message", () => {
    const result = handler({
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "<thinking>reasoning here</thinking>" },
          { type: "text", text: "answer" },
        ],
      },
    });
    expect(result).toBeDefined();
    expect(result!.message.content[0]).toEqual({ type: "thinking", thinking: "reasoning here" });
    // other blocks untouched
    expect(result!.message.content[1]).toEqual({ type: "text", text: "answer" });
  });

  it("handles multiple thinking blocks in one message", () => {
    const result = handler({
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "<thinking>A</thinking>" },
          { type: "text", text: "mid" },
          { type: "thinking", thinking: "no tags" },
          { type: "thinking", thinking: "<thinking>B</thinking>" },
        ],
      },
    });
    expect(result!.message.content[0].thinking).toBe("A");
    expect(result!.message.content[1]).toEqual({ type: "text", text: "mid" });
    expect(result!.message.content[2].thinking).toBe("no tags");
    expect(result!.message.content[3].thinking).toBe("B");
  });

  it("does not mutate the original message content array", () => {
    const original = [{ type: "thinking", thinking: "<thinking>x</thinking>" }];
    handler({ message: { role: "assistant", content: original } });
    expect(original[0].thinking).toBe("<thinking>x</thinking>");
  });

  it("returns undefined when content is not an array", () => {
    expect(handler({ message: { role: "assistant", content: "string?" } })).toBeUndefined();
  });

  it("returns undefined when message is missing", () => {
    expect(handler({})).toBeUndefined();
  });
});
