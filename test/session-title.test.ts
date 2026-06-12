/**
 * Tests for session title extraction.
 */

import { describe, it, expect, vi } from "vitest";
import {
  extractFirstMessage,
  MAX_SESSION_TITLE_LENGTH,
  sessionTitleModule,
} from "../hooks/session-title.js";

describe("extractFirstMessage", () => {
  it("returns single-line user text as-is", () => {
    const title = extractFirstMessage([
      { type: "message", message: { role: "user", content: "hello world" } },
    ]);
    expect(title).toBe("hello world");
  });

  it("truncates at first newline to keep footer single-line", () => {
    const title = extractFirstMessage([
      { type: "message", message: { role: "user", content: "first line\nsecond line" } },
    ]);
    expect(title).toBe("first line");
    expect(title).not.toContain("\n");
  });

  it("caps long single-line titles with ellipsis", () => {
    const longText = "a".repeat(MAX_SESSION_TITLE_LENGTH + 50);
    const title = extractFirstMessage([
      { type: "message", message: { role: "user", content: longText } },
    ]);
    expect(title).toBeDefined();
    expect(title!.length).toBe(MAX_SESSION_TITLE_LENGTH);
    expect(title!.endsWith("…")).toBe(true);
  });

  it("strips leading/trailing whitespace and keeps first line", () => {
    const title = extractFirstMessage([
      { type: "message", message: { role: "user", content: "  hello\nworld  " } },
    ]);
    expect(title).toBe("hello");
  });

  it("extracts from content[] array with text parts", () => {
    const title = extractFirstMessage([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "from array\nmore" }] } },
    ]);
    expect(title).toBe("from array");
  });

  it("skips non-user messages", () => {
    const title = extractFirstMessage([
      { type: "message", message: { role: "assistant", content: "ignore me" } },
      { type: "message", message: { role: "user", content: "use me\nignored" } },
    ]);
    expect(title).toBe("use me");
  });

  it("skips messages with only whitespace", () => {
    const title = extractFirstMessage([
      { type: "message", message: { role: "user", content: "   \n  \n  " } },
      { type: "message", message: { role: "user", content: "actual title" } },
    ]);
    expect(title).toBe("actual title");
  });

  it("returns undefined when no user message exists", () => {
    const title = extractFirstMessage([
      { type: "message", message: { role: "assistant", content: "no user msg" } },
    ]);
    expect(title).toBeUndefined();
  });

  it("returns undefined for empty entries", () => {
    expect(extractFirstMessage([])).toBeUndefined();
  });
});

describe("sessionTitleModule input hook", () => {
  function makeCtx({ name = "" }: { name?: string } = {}) {
    return {
      sessionManager: {
        getSessionName: vi.fn(() => name),
      },
    };
  }

  function makePi() {
    return { setSessionName: vi.fn() };
  }

  it("sets title from first interactive user input", () => {
    const ctx = makeCtx();
    const pi = makePi();
    const event = { text: "hello world", source: "interactive" };
    sessionTitleModule.hooks.input![0](event as any, ctx as any, pi as any);
    expect(pi.setSessionName).toHaveBeenCalledWith("hello world");
  });

  it("uses only the first line and truncates", () => {
    const ctx = makeCtx();
    const pi = makePi();
    const event = { text: "first line\nsecond line", source: "interactive" };
    sessionTitleModule.hooks.input![0](event as any, ctx as any, pi as any);
    expect(pi.setSessionName).toHaveBeenCalledWith("first line");
  });

  it("does nothing when session already has a name", () => {
    const ctx = makeCtx({ name: "existing" });
    const pi = makePi();
    const event = { text: "new title", source: "interactive" };
    sessionTitleModule.hooks.input![0](event as any, ctx as any, pi as any);
    expect(pi.setSessionName).not.toHaveBeenCalled();
  });

  it("skips extension-injected messages", () => {
    const ctx = makeCtx();
    const pi = makePi();
    const event = { text: "extension msg", source: "extension" };
    sessionTitleModule.hooks.input![0](event as any, ctx as any, pi as any);
    expect(pi.setSessionName).not.toHaveBeenCalled();
  });

  it("skips stream steering/follow-up messages", () => {
    const ctx = makeCtx();
    const pi = makePi();
    sessionTitleModule.hooks.input![0]({ text: "steer", source: "interactive", streamingBehavior: "steer" } as any, ctx as any, pi as any);
    sessionTitleModule.hooks.input![0]({ text: "follow", source: "interactive", streamingBehavior: "followUp" } as any, ctx as any, pi as any);
    expect(pi.setSessionName).not.toHaveBeenCalled();
  });
});
