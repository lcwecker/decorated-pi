/**
 * ask with Jev answering — the translation, the thresholds, and the tool path.
 *
 * `fetch` is stubbed: the suite never reaches TypeSafe. The `me` path is
 * covered here too, because "me mode makes no network call" is a promise the
 * switch has to keep.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ASK_USER_OPTION,
  formatJevResult,
  isConsequential,
  prepareQuestions,
  resolveQuestions,
  type AskQuestionLike,
  type PreparedQuestions,
} from "../tools/ask/jev.js";
import { TypesafeError, evaluateSystemOne } from "../utils/typesafe.js";
import { registerAskTool } from "../tools/ask/index.js";
import { setAskWho, setTypesafeApiKey } from "../settings.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const single: AskQuestionLike = { id: "q1", type: "single", question: "Which environment?", options: ["staging", "prod"] };
const multi: AskQuestionLike = { id: "q2", type: "multi", question: "Which checks?", options: ["lint", "tests", "types"] };
const text: AskQuestionLike = { id: "q3", type: "text", question: "What should the module be called?" };

function answersResponse(answers: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ model: "jev-1", answers, usage: { input_tokens: 1, output_tokens: 1 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface Recorded {
  url: string;
  authorization?: string;
  body?: any;
}

function stubFetch(handler: (call: Recorded) => Response | Promise<Response>): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    const call: Recorded = { url: String(url), authorization: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

function captureTool(): any {
  let tool: any;
  registerAskTool({ registerTool: (t: any) => { tool = t; } } as any);
  return tool;
}

function meCtx(answers: Array<{ id: string; value: string }> = [{ id: "q1", value: "staging" }]) {
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

/** The developer's shell may export a real key; the suite must not use it. */
let envKey: string | undefined;

beforeEach(() => {
  vi.unstubAllGlobals();
  envKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  setAskWho("me");
  setTypesafeApiKey(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (envKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = envKey;
});

// ═════════════════════════════════════════════════════════════════════════════
// Translation
// ═════════════════════════════════════════════════════════════════════════════

describe("prepareQuestions", () => {
  it("asks a single question as a choice with an ask-user escape hatch", () => {
    const { asked, deferred } = prepareQuestions([single]);
    const question = asked.q1 as any;
    expect(question.type).toBe("choice");
    expect(question.instructions).toBe("Which environment?");
    expect(Object.keys(question.criteria)).toEqual(["staging", "prod", ASK_USER_OPTION]);
    expect(question.criteria[ASK_USER_OPTION]).toMatch(/does not determine/i);
    expect(deferred).toEqual([]);
  });

  it("never sends the question's own default", () => {
    // A default is the asking model's guess; feeding it back would let Jev
    // echo that guess as if it were evidence from the context.
    const { asked } = prepareQuestions([{ ...single, default: "staging" }]);
    expect(JSON.stringify(asked)).not.toContain("default");
  });

  it("asks a multi question as one noul per option plus an escalation noul", () => {
    const { asked } = prepareQuestions([multi]);
    expect(Object.keys(asked).sort()).toEqual(["q2#0", "q2#1", "q2#2", "q2#ask_user"]);
    expect((asked["q2#1"] as any).instructions).toContain("tests");
    expect((asked["q2#ask_user"] as any).instructions).toMatch(/fail to determine/i);
  });

  it("defers free text instead of asking it", () => {
    const { asked, deferred } = prepareQuestions([text]);
    expect(asked).toEqual({});
    expect(deferred).toEqual([{ id: "q3", question: text.question, reason: expect.stringContaining("free-text") }]);
  });

  it("defers questions with no options", () => {
    const { asked, deferred } = prepareQuestions([{ id: "q4", type: "single", question: "Pick one" }]);
    expect(asked).toEqual({});
    expect(deferred[0].reason).toContain("no options");
  });

  it("defers consequential questions whatever Jev would answer", () => {
    const { asked, deferred } = prepareQuestions([
      { id: "q5", type: "single", question: "Force push over origin/main?", options: ["yes", "no"] },
      { id: "q6", type: "single", question: "要删除这个模块吗？", options: ["删除", "保留"] },
    ]);
    expect(asked).toEqual({});
    expect(deferred).toHaveLength(2);
    expect(deferred[0].reason).toContain("consequential");
  });

  it("recognises consequential phrasing in both languages", () => {
    expect(isConsequential("force-push to main")).toBe(true);
    expect(isConsequential("deploy to prod")).toBe(true);
    expect(isConsequential("上传密钥")).toBe(true);
    expect(isConsequential("which test runner do you prefer?")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Thresholds
// ═════════════════════════════════════════════════════════════════════════════

function resolveSingle(answers: Record<string, unknown>) {
  return resolveQuestions(prepareQuestions([single]), answers as any);
}

describe("resolveQuestions — single choice", () => {
  it("accepts a confident winner and reports its probability", () => {
    const { resolved, needsUser } = resolveSingle({
      q1: { type: "choice", choice: "staging", probabilities: { staging: 0.9, prod: 0.05, [ASK_USER_OPTION]: 0.05 } },
    });
    expect(needsUser).toEqual([]);
    expect(resolved).toEqual([{ id: "q1", question: single.question, value: "staging", probability: 0.9 }]);
  });

  it("escalates when Jev picks the escape hatch", () => {
    const { resolved, needsUser } = resolveSingle({
      q1: { type: "choice", choice: ASK_USER_OPTION, probabilities: { staging: 0.3, prod: 0.2, [ASK_USER_OPTION]: 0.5 } },
    });
    expect(resolved).toEqual([]);
    expect(needsUser[0].reason).toMatch(/does not determine/);
  });

  it("escalates a low-probability winner", () => {
    const { resolved, needsUser } = resolveSingle({
      q1: { type: "choice", choice: "staging", probabilities: { staging: 0.7, prod: 0.25, [ASK_USER_OPTION]: 0.05 } },
    });
    expect(resolved).toEqual([]);
    expect(needsUser[0].reason).toContain("70%");
  });

  it("escalates when probability mass sits on the escape hatch", () => {
    const { needsUser } = resolveSingle({
      q1: { type: "choice", choice: "staging", probabilities: { staging: 0.85, prod: 0, [ASK_USER_OPTION]: 0.15 } },
    });
    expect(needsUser).toHaveLength(1);
  });

  it("escalates a question that came back unanswered", () => {
    const { needsUser } = resolveSingle({});
    expect(needsUser[0].reason).toContain("no answer");
  });

  it("records the caller's reason when the request never went out", () => {
    const { needsUser } = resolveQuestions(
      prepareQuestions([single]),
      {},
      { noAnswerReason: "no TypeSafe API key configured" },
    );
    expect(needsUser[0].reason).toBe("no TypeSafe API key configured");
  });
});

describe("resolveQuestions — multi choice", () => {
  it("keeps every option above the threshold and reports the weakest", () => {
    const { resolved } = resolveQuestions(prepareQuestions([multi]), {
      "q2#0": { type: "noul", noul: 0.9 },
      "q2#1": { type: "noul", noul: 0.85 },
      "q2#2": { type: "noul", noul: 0.2 },
      "q2#ask_user": { type: "noul", noul: 0.1 },
    } as any);
    expect(resolved).toEqual([{ id: "q2", question: multi.question, value: "lint, tests", probability: 0.85 }]);
  });

  it("leaves out an option that sits just under the bar", () => {
    const { resolved, needsUser } = resolveQuestions(prepareQuestions([multi]), {
      "q2#0": { type: "noul", noul: 0.9 },
      "q2#1": { type: "noul", noul: 0.79 },
      "q2#ask_user": { type: "noul", noul: 0.1 },
    } as any);
    expect(needsUser).toEqual([]);
    expect(resolved).toEqual([{ id: "q2", question: multi.question, value: "lint", probability: 0.9 }]);
  });

  it("escalates when nothing clears the threshold", () => {
    const { needsUser } = resolveQuestions(prepareQuestions([multi]), {
      "q2#0": { type: "noul", noul: 0.4 },
      "q2#1": { type: "noul", noul: 0.3 },
      "q2#2": { type: "noul", noul: 0.1 },
      "q2#ask_user": { type: "noul", noul: 0.1 },
    } as any);
    expect(needsUser[0].reason).toContain("no option");
  });

  it("escalates when the escalation noul fires, even with options selected", () => {
    const { resolved, needsUser } = resolveQuestions(prepareQuestions([multi]), {
      "q2#0": { type: "noul", noul: 0.9 },
      "q2#ask_user": { type: "noul", noul: 0.5 },
    } as any);
    expect(resolved).toEqual([]);
    expect(needsUser[0].reason).toMatch(/does not determine/);
  });
});

describe("result shaping", () => {
  it("reads question: answer, the same shape the wizard path produces", () => {
    const prepared = prepareQuestions([single, text]);
    const resolved = resolveQuestions(prepared, {
      q1: { type: "choice", choice: "staging", probabilities: { staging: 0.9, [ASK_USER_OPTION]: 0.02 } },
    } as any);
    const out = formatJevResult(resolved.resolved, resolved.needsUser);

    expect(out.split("\n")[0]).toBe(`${single.question}: staging`);
    // The probability stays out of the text; it belongs to details.
    expect(out).not.toContain("90%");
    expect(out).toContain("needs the user (put these in your reply):");
    expect(out).toContain(`- ${text.question}`);
  });

  it("lists only the unanswered questions when nothing was answered", () => {
    const out = formatJevResult([], prepareQuestions([text]).deferred);
    expect(out.split("\n")[0]).toBe("needs the user (put these in your reply):");
    expect(out.split("\n")[1]).toBe(`- ${text.question}`);
  });

  it("keeps the caller's question order in both blocks", () => {
    // The fourth question is a free-text one that is deferred before Jev is
    // asked, and the third is only escalated while resolving. The result must
    // still read in the order the caller asked.
    const order: AskQuestionLike[] = [
      single,
      { id: "q4", type: "single", question: "Which region?", options: ["eu", "us"] },
      text,
    ];
    const resolved = resolveQuestions(prepareQuestions(order), {
      q1: { type: "choice", choice: "staging", probabilities: { staging: 0.9, [ASK_USER_OPTION]: 0 } },
      q4: { type: "choice", choice: ASK_USER_OPTION, probabilities: { [ASK_USER_OPTION]: 0.9 } },
    } as any);
    expect(resolved.needsUser.map((entry) => entry.id)).toEqual(["q4", "q3"]);
  });

  it("says why nothing was answered", () => {
    const out = formatJevResult([], prepareQuestions([text]).deferred, "HTTP 529: overloaded");
    expect(out.split("\n")[0]).toBe("Jev unavailable: HTTP 529: overloaded");
  });

  it("restores the caller's order even when the plan is collected out of order", () => {
    const prepared: PreparedQuestions = {
      order: ["a", "b"],
      asked: {
        a: { type: "choice", instructions: "A?", criteria: { x: null } },
        b: { type: "choice", instructions: "B?", criteria: { y: null } },
      },
      deferred: [],
      plan: [
        { kind: "choice", questionId: "b", question: "B?" },
        { kind: "choice", questionId: "a", question: "A?" },
      ],
    };
    const { resolved } = resolveQuestions(prepared, {
      a: { type: "choice", choice: "x", probabilities: { x: 0.9 } },
      b: { type: "choice", choice: "y", probabilities: { y: 0.9 } },
    } as any);
    expect(resolved.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Transport
// ═════════════════════════════════════════════════════════════════════════════

describe("evaluateSystemOne", () => {
  it("posts the state, model and questions with a bearer key", async () => {
    const calls = stubFetch(() => answersResponse({ q1: { type: "choice", choice: "staging", probabilities: {} } }));
    const answers = await evaluateSystemOne({ cwd: "/tmp", context: "facts" }, { q1: prepareQuestions([single]).asked.q1 }, { apiKey: "secret-key" });

    expect(calls[0].url).toContain("/v1/systemone");
    expect(calls[0].authorization).toBe("Bearer secret-key");
    expect(calls[0].body.model).toBe("jev-latest");
    expect(calls[0].body.state).toEqual({ cwd: "/tmp", context: "facts" });
    expect(Object.keys(calls[0].body.questions)).toEqual(["q1"]);
    expect(answers.q1.choice).toBe("staging");
  });

  it("surfaces the status and body on a rejection", async () => {
    stubFetch(() => new Response('{"error":"bad key"}', { status: 401 }));
    await expect(evaluateSystemOne({}, {}, { apiKey: "x" })).rejects.toBeInstanceOf(TypesafeError);
    await expect(evaluateSystemOne({}, {}, { apiKey: "x" })).rejects.toMatchObject({ status: 401 });
  });

  it("rejects an unparsable or answerless body", async () => {
    stubFetch(() => new Response("<html>nope</html>", { status: 200 }));
    await expect(evaluateSystemOne({}, {}, { apiKey: "x" })).rejects.toThrow(/unparsable/);
    stubFetch(() => new Response('{"model":"jev"}', { status: 200 }));
    await expect(evaluateSystemOne({}, {}, { apiKey: "x" })).rejects.toThrow(/no answers/);
  });

  it("reports a timeout rather than hanging", async () => {
    stubFetch(() => new Promise((_resolve, reject) => {
      setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })), 5);
    }));
    await expect(evaluateSystemOne({}, {}, { apiKey: "x", timeoutMs: 10 })).rejects.toThrow(/timed out/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Tool paths
// ═════════════════════════════════════════════════════════════════════════════

describe("ask tool — me mode", () => {
  it("opens the wizard and never calls the network", async () => {
    const calls = stubFetch(() => answersResponse({}));
    const ctx = meCtx();
    const result = await captureTool().execute("1", { questions: [single] }, undefined, undefined, ctx);

    expect(calls).toHaveLength(0);
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("Which environment?: staging");
    expect(result.details).toEqual({ answers: [{ id: "q1", value: "staging" }] });
  });

  it("still refuses to run without a UI", async () => {
    const calls = stubFetch(() => answersResponse({}));
    const result = await captureTool().execute("1", { questions: [single] }, undefined, undefined, headlessCtx());
    expect(calls).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("interactive UI");
  });
});

describe("ask tool — jev mode", () => {
  beforeEach(() => {
    setAskWho("jev");
    setTypesafeApiKey("test-key");
  });

  it("answers from the context without a terminal", async () => {
    const calls = stubFetch(() =>
      answersResponse({ q1: { type: "choice", choice: "staging", probabilities: { staging: 0.92, prod: 0.03, [ASK_USER_OPTION]: 0.05 } } }),
    );
    const ctx = headlessCtx();
    const result = await captureTool().execute(
      "1",
      { questions: [single], context: "The task targets staging." },
      undefined,
      undefined,
      ctx,
    );

    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.state).toEqual({ cwd: "/tmp/project", context: "The task targets staging." });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe(`${single.question}: staging`);
    expect(result.details).toMatchObject({ answeredBy: "jev", answers: [{ id: "q1", value: "staging", probability: 0.92 }] });
  });

  it("hands the question back when Jev asks the user", async () => {
    stubFetch(() => answersResponse({ q1: { type: "choice", choice: ASK_USER_OPTION, probabilities: { staging: 0.4, [ASK_USER_OPTION]: 0.6 } } }));
    const result = await captureTool().execute("1", { questions: [single], context: "" }, undefined, undefined, headlessCtx());

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("needs the user (put these in your reply):");
    expect(result.content[0].text).toContain(single.question);
    expect(result.details.needsUser[0]).toMatchObject({ id: "q1" });
  });

  it("routes a free-text question to the user without asking Jev", async () => {
    const calls = stubFetch(() => answersResponse({}));
    const result = await captureTool().execute("1", { questions: [text], context: "anything" }, undefined, undefined, headlessCtx());

    expect(calls).toHaveLength(0);
    expect(result.content[0].text).toContain("needs the user (put these in your reply):");
    expect(result.content[0].text).toContain(`- ${text.question}`);
  });

  it("routes everything to the user when the service fails", async () => {
    stubFetch(() => new Response('{"error":"overloaded"}', { status: 529 }));
    const result = await captureTool().execute("1", { questions: [single, text], context: "x" }, undefined, undefined, headlessCtx());

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("Jev unavailable: HTTP 529");
    expect(result.content[0].text).toContain(`- ${single.question}`);
    expect(result.content[0].text).toContain(`- ${text.question}`);
    expect(result.details.jevError).toContain("529");
    expect(result.details.needsUser).toHaveLength(2);
  });

  it("reports a missing key instead of quietly switching to the wizard", async () => {
    const calls = stubFetch(() => answersResponse({}));
    setTypesafeApiKey(null);
    const result = await captureTool().execute("1", { questions: [single] }, undefined, undefined, headlessCtx());

    expect(calls).toHaveLength(0);
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("Jev unavailable: no TypeSafe API key");
    expect(result.content[0].text).toContain(`- ${single.question}`);
    expect(result.details.jevError).toContain("no TypeSafe API key");
    expect(result.details.needsUser[0]).toMatchObject({
      id: "q1",
      reason: expect.stringContaining("no TypeSafe API key"),
    });
  });
});
