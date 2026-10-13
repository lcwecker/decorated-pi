/**
 * ask tool — the wizard path.
 *
 * The tool answers through the terminal UI only, so this covers the contract
 * that matters: the wizard opens, answers come back shaped, a dismissed wizard
 * is reported, a session without a UI is refused, and a choice question with no
 * options never reaches the wizard.
 */

import { describe, it, expect, vi } from "vitest";
import { formatAnswers, registerAskTool } from "../tools/ask/index.js";

const single = { id: "q1", type: "single" as const, question: "Which environment?", options: ["staging", "prod"] };
const multi = { id: "q2", type: "multi" as const, question: "Which checks?", options: ["lint", "tests", "types"] };
const text = { id: "q3", type: "text" as const, question: "What should the module be called?" };

function captureTool(): any {
  let tool: any;
  registerAskTool({ registerTool: (t: any) => { tool = t; } } as any);
  return tool;
}

// No default: an explicit `undefined` has to reach the tool, and a default
// parameter would swallow it.
function meCtx(answers: any) {
  return {
    hasUI: true,
    mode: "tui",
    cwd: "/tmp/project",
    ui: { custom: vi.fn(async () => answers) },
  } as any;
}

function headlessCtx() {
  return { hasUI: false, mode: "print", cwd: "/tmp/project", ui: { custom: vi.fn() } } as any;
}

describe("ask tool — wizard path", () => {
  it("opens the wizard and returns the answers without touching the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const ctx = meCtx([{ id: "q1", value: "staging" }]);
      const result = await captureTool().execute("1", { questions: [single] }, undefined, undefined, ctx);

      expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.content[0].text).toBe("Which environment?: staging");
      expect(result.details).toEqual({ answers: [{ id: "q1", value: "staging" }] });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("joins a multi-choice answer into one line", async () => {
    const ctx = meCtx([{ id: "q2", value: ["lint", "tests"] }]);
    const result = await captureTool().execute("1", { questions: [multi] }, undefined, undefined, ctx);

    expect(result.content[0].text).toBe("Which checks?: lint, tests");
  });

  it("reports a dismissed wizard instead of inventing an answer", async () => {
    const ctx = meCtx(undefined);
    const result = await captureTool().execute("1", { questions: [single] }, undefined, undefined, ctx);

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("cancelled");
    expect(result.details).toEqual({ cancelled: true });
  });

  it("refuses to run without a UI", async () => {
    const ctx = headlessCtx();
    const result = await captureTool().execute("1", { questions: [single] }, undefined, undefined, ctx);

    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("interactive UI");
  });

  it("rejects a choice question with no options before opening the wizard", async () => {
    const ctx = meCtx([]);
    const noOptions = { id: "q1", type: "single", question: "Which one?" };
    const result = await captureTool().execute("1", { questions: [noOptions] }, undefined, undefined, ctx);

    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires at least one option");
  });
});

describe("formatAnswers", () => {
  it("keeps the question order and skips anything unanswered", () => {
    const out = formatAnswers([single, text, multi], [
      { id: "q1", value: "prod" },
      { id: "q3", value: "nvr-stream" },
    ]);

    expect(out).toBe("Which environment?: prod\nWhat should the module be called?: nvr-stream");
  });
});
