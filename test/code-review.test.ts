/** Code-review background command tests. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CODE_REVIEW_RESULT_MESSAGE,
  CODE_REVIEW_STATE_ENTRY,
  CODE_REVIEW_VIEW_MESSAGE,
  CodeReviewRuntime,
  buildReviewerArgs,
  buildReviewTask,
  detectScm,
  displayItems,
  emptyUsage,
  getFinalOutput,
  getReviewFailure,
  getScmStatusArgs,
  registerCodeReviewRenderer,
  renderReviewDetails,
  runReviewSubprocess,
  type ReviewRunDetails,
  __codeReviewTest,
} from "../tools/code-review/index.js";
import { registerCodeReviewCommand } from "../commands/code-review.js";
import { createCodeReviewModule, sanitizeCodeReviewContext } from "../hooks/code-review.js";

function model(provider = "review", id = "reviewer"): any {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
  };
}

function details(overrides: Partial<ReviewRunDetails> = {}): ReviewRunDetails {
  return {
    status: "running",
    scm: "git",
    model: "review/reviewer",
    changedFiles: 2,
    messages: [],
    usage: emptyUsage(),
    ...overrides,
  };
}

function assistant(text: string, stopReason = "stop"): any {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "review",
    model: "reviewer",
    stopReason,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheWrite: 0,
      totalTokens: 18,
      cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
    },
    timestamp: Date.now(),
  };
}

function makeActive(runId = "run-1", overrides: Record<string, unknown> = {}) {
  return {
    runId,
    controller: new AbortController(),
    details: details(),
    requestRender: vi.fn(),
    suppressDelivery: false,
    ...overrides,
  } as any;
}

describe("SCM helpers", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "code-review-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("detects git from a parent directory", () => {
    fs.mkdirSync(path.join(tmp, ".git"));
    const nested = path.join(tmp, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    expect(detectScm(nested)).toBe("git");
  });

  it("detects svn and returns null outside SCM", () => {
    expect(detectScm(tmp)).toBeNull();
    fs.mkdirSync(path.join(tmp, ".svn"));
    expect(detectScm(tmp)).toBe("svn");
  });

  it("uses status commands that include untracked Git files", () => {
    expect(getScmStatusArgs("git")).toEqual(["status", "--short", "--untracked-files=all"]);
    expect(getScmStatusArgs("svn")).toEqual(["status"]);
  });

  it("builds the review task from status and optional instructions", () => {
    const status = " M src/main.ts\n?? test/new.test.ts\n";
    const task = buildReviewTask("git", status, "Focus on test coverage");
    expect(task).toContain(status);
    expect(task).toContain("Focus on test coverage");
    expect(task).toContain("Use the available tools to inspect the changes");
  });

  it("resolves a local Pi CLI when the current entry script is unavailable", () => {
    const binDir = path.join(tmp, "node_modules", ".bin");
    const piPath = path.join(binDir, "pi");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(piPath, "#!/bin/sh\n");
    fs.chmodSync(piPath, 0o755);
    const originalScript = process.argv[1];
    process.argv[1] = path.join(tmp, "missing-entry.js");
    try {
      expect((__codeReviewTest as any).getPiInvocation(["--mode", "json"], tmp)).toEqual({
        command: piPath,
        args: ["--mode", "json"],
      });
    } finally {
      process.argv[1] = originalScript;
    }
  });

  it("passes the task through stdin and gives the reviewer all tools", () => {
    const args = buildReviewerArgs("review/reviewer");
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("--extension");
    expect(args).toContain("--append-system-prompt");
  });
});

describe("CodeReviewRuntime", () => {
  it("tracks live updates and completed state", () => {
    const runtime = new CodeReviewRuntime();
    const active = makeActive();
    expect(runtime.begin(active)).toBe(true);
    expect(runtime.begin(makeActive("run-2"))).toBe(false);

    const partial = details({ messages: [assistant("checking")] });
    expect(runtime.update("run-1", partial)).toBe(true);
    expect(runtime.get("run-1")).toBe(partial);
    expect(active.requestRender).toHaveBeenCalledTimes(2);

    const done = details({ status: "done", messages: [assistant("complete")] });
    expect(runtime.complete("run-1", done)).toBe(true);
    expect(runtime.active).toBeNull();
    expect(runtime.get("run-1")).toBe(done);
  });

  it("aborts the active task and unsubscribes input", () => {
    const runtime = new CodeReviewRuntime();
    const active = makeActive();
    const unsubscribe = vi.fn();
    runtime.begin(active);
    runtime.attachInput("run-1", unsubscribe);

    expect(runtime.abort()).toBe(true);
    expect(active.controller.signal.aborted).toBe(true);
    runtime.complete("run-1", details({ status: "aborted" }));
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("suppresses delivery when the session shuts down", () => {
    const runtime = new CodeReviewRuntime();
    const active = makeActive();
    runtime.begin(active);
    const ended = runtime.shutdown();
    expect(ended).toMatchObject({ runId: "run-1", details: { status: "aborted" } });
    expect(active.controller.signal.aborted).toBe(true);
    expect(runtime.complete("run-1", details({ status: "aborted" }))).toBe(false);
  });

  it("restores persisted run details", () => {
    const runtime = new CodeReviewRuntime();
    const restored = details({ status: "done", messages: [assistant("saved")] });
    runtime.restore("saved-run", restored);
    expect(runtime.get("saved-run")).toBe(restored);
  });
});

describe("headless subprocess", () => {
  let tmp: string;
  let originalScript: string | undefined;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "code-review-child-"));
    originalScript = process.argv[1];
  });
  afterEach(() => {
    process.argv[1] = originalScript!;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("finishes after agent_end even when the child keeps a background handle open", async () => {
    const script = path.join(tmp, "review-child.mjs");
    fs.writeFileSync(script, [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'complete review' }], stopReason: 'stop' } }));",
      "  console.log(JSON.stringify({ type: 'agent_end' }));",
      "  setInterval(() => {}, 1000);",
      "});",
    ].join("\n"));
    process.argv[1] = script;

    const result = await runReviewSubprocess([], "task", tmp, undefined, () => {}, "review/reviewer");
    expect(result.exitCode).toBe(0);
    expect(getFinalOutput(result.messages)).toBe("complete review");
    expect(getReviewFailure(result)).toBeUndefined();
  });

  it("renders streamed thinking and tool activity when completed messages have empty content", async () => {
    const script = path.join(tmp, "review-child-streamed.mjs");
    fs.writeFileSync(script, [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  const base = { role: 'assistant', provider: 'review', model: 'reviewer', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };",
      "  console.log(JSON.stringify({ type: 'message_update', message: { ...base, content: [{ type: 'thinking', thinking: 'checking files' }] }, assistantMessageEvent: { type: 'thinking_end' } }));",
      "  console.log(JSON.stringify({ type: 'message_end', message: { ...base, content: [], stopReason: 'toolUse' } }));",
      "  console.log(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: { path: 'src/main.ts' } }));",
      "  console.log(JSON.stringify({ type: 'message_update', message: { ...base, content: [{ type: 'text', text: 'final report' }] }, assistantMessageEvent: { type: 'text_end' } }));",
      "  console.log(JSON.stringify({ type: 'message_end', message: { ...base, content: [], stopReason: 'stop' } }));",
      "  console.log(JSON.stringify({ type: 'agent_end' }));",
      "});",
    ].join("\n"));
    process.argv[1] = script;
    const updates: any[] = [];

    const result = await runReviewSubprocess(
      [], "task", tmp, undefined, (update) => updates.push(update), "review/reviewer",
    );

    expect(getFinalOutput(result.messages)).toBe("final report");
    expect(displayItems(result.messages)).toEqual([
      { type: "thinking", text: "checking files" },
      { type: "tool", name: "read", args: { path: "src/main.ts" } },
      { type: "text", text: "final report" },
    ]);
    expect(updates.some((update) => displayItems(update.messages).some(
      (item) => item.type === "thinking" && item.text === "checking files",
    ))).toBe(true);
    expect(updates.some((update) => displayItems(update.messages).some(
      (item) => item.type === "tool" && item.name === "read",
    ))).toBe(true);
  });

  it("waits through auto-retry and keeps only assistant transcript messages", async () => {
    const script = path.join(tmp, "review-child-retry.mjs");
    fs.writeFileSync(script, [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'temporary failure' }], stopReason: 'error', errorMessage: 'rate limit' } }));",
      "  console.log(JSON.stringify({ type: 'agent_end' }));",
      "  console.log(JSON.stringify({ type: 'auto_retry_start' }));",
      "  setTimeout(() => {",
      "    console.log(JSON.stringify({ type: 'agent_start' }));",
      "    console.log(JSON.stringify({ type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'secret raw output' }] } }));",
      "    console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final review' }], stopReason: 'stop' } }));",
      "    console.log(JSON.stringify({ type: 'agent_end' }));",
      "  }, 300);",
      "  setInterval(() => {}, 1000);",
      "});",
    ].join("\n"));
    process.argv[1] = script;

    const result = await runReviewSubprocess([], "task", tmp, undefined, () => {}, "review/reviewer");
    expect(result.exitCode).toBe(0);
    expect(getFinalOutput(result.messages)).toBe("final review");
    expect(result.messages).toHaveLength(2);
    expect(result.messages.every((message) => message.role === "assistant")).toBe(true);
    expect(JSON.stringify(result.messages)).not.toContain("secret raw output");
    expect(getReviewFailure(result)).toBeUndefined();
  });

  it("accepts Pi's handled SIGTERM exit code after protocol settlement", async () => {
    const script = path.join(tmp, "review-child-sigterm.mjs");
    fs.writeFileSync(script, [
      "process.on('SIGTERM', () => process.exit(143));",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'complete review' }], stopReason: 'stop' } }));",
      "  console.log(JSON.stringify({ type: 'agent_end' }));",
      "  setInterval(() => {}, 1000);",
      "});",
    ].join("\n"));
    process.argv[1] = script;

    const result = await runReviewSubprocess([], "task", tmp, undefined, () => {}, "review/reviewer");
    expect(result.exitCode).toBe(0);
    expect(getReviewFailure(result)).toBeUndefined();
  });

  it("preserves a real nonzero exit before agent_end", async () => {
    const script = path.join(tmp, "review-child-error.mjs");
    fs.writeFileSync(script, [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'partial review' }], stopReason: 'stop' } }));",
      "  process.exitCode = 2;",
      "});",
    ].join("\n"));
    process.argv[1] = script;

    const result = await runReviewSubprocess([], "task", tmp, undefined, () => {}, "review/reviewer");
    expect(result.exitCode).toBe(2);
    expect(getFinalOutput(result.messages)).toBe("partial review");
    expect(getReviewFailure(result)).toBe("Reviewer exited with 2.");
  });

  it("reports explicit reviewer errors even with partial text", () => {
    const base = {
      ...details({ messages: [assistant("partial review")] }),
      exitCode: 0,
    } as any;
    expect(getReviewFailure({ ...base, stopReason: "error" })).toBe("Reviewer stopped with reason: error.");
    expect(getReviewFailure({ ...base, errorMessage: "Authentication failed" })).toBe("Authentication failed");
  });
});

describe("history rendering", () => {
  const theme: any = {
    fg: (_color: string, text: string) => text,
    bg: (color: string, text: string) => `[${color}]${text}`,
    bold: (text: string) => text,
  };

  it("renders a folded tool-like status and expanded review details", () => {
    const value = details({
      status: "done",
      messages: [{
        ...assistant("Final report"),
        content: [
          { type: "thinking", thinking: "checking lifecycle" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "index.ts" } },
          { type: "text", text: "Final report" },
        ],
      } as any],
      usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 0, cost: 0.02, turns: 1 },
    });

    expect(renderReviewDetails(value, false, theme).render(120).join("\n"))
      .toContain("✓ reviewed [git status, 2 files]");
    const expanded = renderReviewDetails(value, true, theme).render(120).join("\n");
    expect(expanded).toContain("Thinking: checking lifecycle");
    expect(expanded).toContain("→ read");
    expect(expanded).toContain("Final report");
    expect(expanded).toContain("1 turn");
  });

  it("extracts reviewer thinking, text, and tool calls", () => {
    expect(displayItems([{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "checking" },
        { type: "text", text: "finding" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
      ],
    } as any])).toEqual([
      { type: "thinking", text: "checking" },
      { type: "text", text: "finding" },
      { type: "tool", name: "read", args: { path: "a.ts" } },
    ]);
  });

  it("updates the native tool-style background with live status", () => {
    const runtime = new CodeReviewRuntime();
    runtime.restore("run-1", details({ status: "running" }));
    const pi: any = { registerMessageRenderer: vi.fn() };
    registerCodeReviewRenderer(pi, runtime);
    const renderer = pi.registerMessageRenderer.mock.calls[0][1];
    const component = renderer({ details: { runId: "run-1" } }, { expanded: false }, theme);

    expect(component.render(120).join("\n")).toContain("[toolPendingBg]");
    runtime.restore("run-1", details({ status: "done" }));
    expect(component.render(120).join("\n")).toContain("[toolSuccessBg]");
    runtime.restore("run-1", details({ status: "error", error: "failed" }));
    expect(component.render(120).join("\n")).toContain("[toolErrorBg]");
  });

  it("registers a custom message renderer and no LLM tool/provider", () => {
    const runtime = new CodeReviewRuntime();
    runtime.restore("run-1", details({ status: "done", messages: [assistant("report")] }));
    const pi: any = {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      registerProvider: vi.fn(),
    };
    registerCodeReviewRenderer(pi, runtime);
    expect(pi.registerMessageRenderer).toHaveBeenCalledWith(
      CODE_REVIEW_VIEW_MESSAGE,
      expect.any(Function),
    );
    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(pi.registerProvider).not.toHaveBeenCalled();

    const renderer = pi.registerMessageRenderer.mock.calls[0][1];
    const component = renderer({ details: { runId: "run-1" } }, { expanded: true }, theme);
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("[toolSuccessBg]");
    expect(rendered).toContain("code-review review/reviewer");
    expect(rendered).toContain("report");
  });
});

describe("context and lifecycle hooks", () => {
  it("hides the visible card but keeps the hidden result message", () => {
    const original = { role: "user", content: "original", timestamp: 1 } as any;
    const result = {
      role: "custom",
      customType: CODE_REVIEW_RESULT_MESSAGE,
      content: "<code-review-result>report</code-review-result>",
      display: false,
    } as any;
    const sanitized = sanitizeCodeReviewContext([
      original,
      { role: "custom", customType: CODE_REVIEW_VIEW_MESSAGE, content: "Code review", display: true } as any,
      result,
    ]);
    expect(sanitized).toEqual([original, result]);
  });

  it("restores saved states and aborts on shutdown", () => {
    const runtime = new CodeReviewRuntime();
    const module = createCodeReviewModule(runtime);
    const saved = details({ status: "done", messages: [assistant("saved")] });
    module.hooks.session_start![0](
      {} as any,
      { sessionManager: { getEntries: () => [{ type: "custom", customType: CODE_REVIEW_STATE_ENTRY, data: { runId: "saved", details: saved } }] } } as any,
      {} as any,
    );
    expect(runtime.get("saved")).toBe(saved);
    const active = makeActive("active");
    runtime.begin(active);
    const pi = { appendEntry: vi.fn() } as any;
    module.hooks.session_shutdown![0]({} as any, {} as any, pi);
    expect(active.controller.signal.aborted).toBe(true);
    expect(pi.appendEntry).toHaveBeenCalledWith(
      CODE_REVIEW_STATE_ENTRY,
      expect.objectContaining({ runId: "active", details: expect.objectContaining({ status: "aborted" }) }),
    );
  });
});

describe("/code-review command", () => {
  let tmp: string;
  let handler: (args: string, ctx: any) => Promise<void>;
  let pi: any;
  let runtime: CodeReviewRuntime;
  let terminalHandler: (data: string) => any;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "code-review-command-"));
    fs.mkdirSync(path.join(tmp, ".git"));
    runtime = new CodeReviewRuntime();
    pi = {
      registerCommand: vi.fn((_name, options) => { handler = options.handler; }),
      exec: vi.fn().mockResolvedValue({ stdout: " M src/main.ts\n", stderr: "", code: 0, killed: false }),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerProvider: vi.fn(),
    };
    registerCodeReviewCommand(pi, runtime);
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function context(overrides: any = {}) {
    return {
      cwd: tmp,
      model: model("parent", "main"),
      isIdle: () => true,
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        onTerminalInput: vi.fn((callback) => {
          terminalHandler = callback;
          return vi.fn();
        }),
      },
      modelRegistry: {
        find: (provider: string, id: string) => model(provider, id),
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "key", headers: {} }),
      },
      ...overrides,
    };
  }

  function installChild(scriptLines: string[]) {
    const script = path.join(tmp, "review-command-child.mjs");
    fs.writeFileSync(script, scriptLines.join("\n"));
    const original = process.argv[1];
    process.argv[1] = script;
    return () => { process.argv[1] = original; };
  }

  it("runs in the background, writes a history card, and triggers a hidden normal turn", async () => {
    const restore = installChild([
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'review report' }], stopReason: 'stop' } }));",
      "  console.log(JSON.stringify({ type: 'agent_end' }));",
      "});",
    ]);
    const ctx = context();
    try {
      await handler("Focus on authentication logic", ctx);
      expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        customType: CODE_REVIEW_VIEW_MESSAGE,
        display: true,
      }));
      expect(pi.registerTool).not.toHaveBeenCalled();
      expect(pi.registerProvider).not.toHaveBeenCalled();

      await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: CODE_REVIEW_RESULT_MESSAGE,
          display: false,
          content: expect.stringContaining("<code-review-result>\nreview report"),
        }),
        { deliverAs: "followUp" },
      ));
      expect(pi.sendUserMessage).toHaveBeenCalledWith("", { deliverAs: "followUp" });
      expect(pi.appendEntry).toHaveBeenCalledWith(
        CODE_REVIEW_STATE_ENTRY,
        expect.objectContaining({ details: expect.objectContaining({ status: "done" }) }),
      );
      expect(runtime.active).toBeNull();
      expect(ctx.ui.setStatus).toHaveBeenCalledWith("code-review", undefined);
      expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("code-review", "reviewing");
    } finally {
      restore();
    }
  });

  it("returns a clean result without starting a child process", async () => {
    pi.exec.mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false });
    await handler("", context());
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: CODE_REVIEW_RESULT_MESSAGE,
        content: expect.stringContaining("No changes to review"),
      }),
      { deliverAs: "followUp" },
    ));
    expect(pi.sendUserMessage).toHaveBeenCalledWith("", { deliverAs: "followUp" });
    expect(runtime.active).toBeNull();
  });

  it("treats missing output from a non-clean review as an error", async () => {
    const restore = installChild([
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'stop' } }));",
      "  console.log(JSON.stringify({ type: 'agent_end' }));",
      "});",
    ]);
    const ctx = context();
    try {
      await handler("", ctx);
      await vi.waitFor(() => expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Reviewer completed without returning a report.",
        "error",
      ));
      expect(pi.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ customType: CODE_REVIEW_RESULT_MESSAGE }),
        expect.anything(),
      );
      expect(pi.appendEntry).toHaveBeenCalledWith(
        CODE_REVIEW_STATE_ENTRY,
        expect.objectContaining({ details: expect.objectContaining({ status: "error" }) }),
      );
    } finally {
      restore();
    }
  });

  it("uses Escape to cancel only the active background review", async () => {
    const restore = installChild([
      "process.stdin.resume();",
      "process.stdin.on('end', () => setInterval(() => {}, 1000));",
    ]);
    try {
      await handler("", context());
      expect(runtime.active).not.toBeNull();
      expect(terminalHandler("\u001b")).toEqual({ consume: true });
      await vi.waitFor(() => expect(runtime.active).toBeNull());
      expect(pi.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ customType: CODE_REVIEW_RESULT_MESSAGE }),
        expect.anything(),
      );
      expect(pi.appendEntry).toHaveBeenCalledWith(
        CODE_REVIEW_STATE_ENTRY,
        expect.objectContaining({ details: expect.objectContaining({ status: "aborted" }) }),
      );
    } finally {
      restore();
    }
  });

  it("rejects start while the parent or another review is busy", async () => {
    const busy = context({ isIdle: () => false });
    await handler("", busy);
    expect(busy.ui.notify).toHaveBeenCalledWith(expect.stringContaining("current agent turn"), "warning");

    runtime.begin(makeActive());
    const duplicate = context();
    await handler("", duplicate);
    expect(duplicate.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already running"), "warning");
  });
});

describe("getFinalOutput", () => {
  it("returns all text parts from the latest assistant message", () => {
    expect(getFinalOutput([
      assistant("first"),
      {
        ...assistant("unused"),
        content: [
          { type: "text", text: "part one" },
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "part two" },
        ],
      } as any,
    ])).toBe("part one\npart two");
  });
});
