/**
 * ask — ask the user one or more questions and return their answers.
 *
 * Two answering paths, chosen per call from settings:
 *
 *   me   — the TUI wizard. Free text, single choice, and multiple choice, all
 *          navigated together with Tab / Shift+Tab.
 *   jev  — a TypeSafe System One model answers the closed questions from the
 *          `context` the model supplied, and hands back anything the context
 *          does not determine. The model then puts those questions to the user
 *          in its reply, so this path needs no terminal.
 *
 * `tools/ask/jev.ts` owns the translation and the thresholds; this file only
 * picks the path and shapes the result.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AskComponent, type AskAnswer, type AskQuestion } from "../../ui/ask.js";
import { getTypesafeApiKey, isJevAnswering } from "../../settings.js";
import { evaluateSystemOne } from "../../utils/typesafe.js";
import { formatJevResult, prepareQuestions, resolveQuestions, withQuestionText } from "./jev.js";

const askQuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question in the result." }),
  type: Type.Union(
    [Type.Literal("text"), Type.Literal("single"), Type.Literal("multi")],
    { description: "text = free input, single = one option, multi = many options" },
  ),
  question: Type.String({ description: "Question text shown to the user." }),
  options: Type.Optional(Type.Array(Type.String(), { description: "Options for single or multi choice. Each option MUST be a plain string (not an object). Example: [\"选项A\", \"选项B\", \"选项C\"]. The user picks by index; do NOT pass {id,text} objects." })),
  default: Type.Optional(Type.String({ description: "Default answer. For multi, comma-separated values." })),
});

function formatAnswer(q: AskQuestion, value: string | string[]): string {
  if (q.type === "text") return value as string;
  if (q.type === "single") return value as string;
  return (value as string[]).join(", ");
}

export function formatAnswers(questions: AskQuestion[], answers: { id: string; value: string | string[] }[]): string {
  const lines: string[] = [];
  for (const q of questions) {
    const a = answers.find((x) => x.id === q.id);
    if (!a) continue;
    lines.push(`${q.question}: ${formatAnswer(q, a.value)}`);
  }
  return lines.join("\n");
}

export interface JevAskParams {
  questions: AskQuestion[];
  context?: string;
}

/** Answer through Jev. Every failure mode lands in the same place: the question
 *  is reported as needing the user, and the model asks it in its reply. */
async function answerWithJev(
  params: JevAskParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean; details: Record<string, unknown> }> {
  const apiKey = getTypesafeApiKey();
  const prepared = prepareQuestions(params.questions);
  if (!apiKey || Object.keys(prepared.asked).length === 0) {
    const unanswered = resolveQuestions(prepared, {});
    const needsUser = withQuestionText(unanswered.needsUser, params.questions);
    return {
      content: [{ type: "text", text: formatJevResult(unanswered.resolved, needsUser) }],
      isError: false,
      details: {
        answeredBy: "jev",
        ...(apiKey ? {} : { jevError: "no TypeSafe API key configured (dp-settings → Tools → Ask)" }),
        needsUser,
      },
    };
  }

  try {
    const answers = await evaluateSystemOne({ cwd: ctx.cwd, context: params.context ?? null }, prepared.asked, {
      apiKey,
      signal,
    });
    const resolved = resolveQuestions(prepared, answers);
    const needsUser = withQuestionText(resolved.needsUser, params.questions);
    return {
      content: [{ type: "text", text: formatJevResult(resolved.resolved, needsUser) }],
      isError: false,
      details: { answeredBy: "jev", answers: resolved.resolved, needsUser },
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    // Nothing was answered, so every question goes back to the user — with the
    // transport failure recorded rather than swallowed.
    const all = params.questions.map((q) => ({ id: q.id, question: q.question, reason: "answering service unavailable" }));
    return {
      content: [{ type: "text", text: formatJevResult([], all) }],
      isError: false,
      details: { answeredBy: "jev", jevError: reason, needsUser: all },
    };
  }
}

export function registerAskTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask",
    label: "Ask user",
    description: "Ask the user one or more questions and return their answers. Supports free text, single choice, and multiple choice. Pass `context` with the facts needed to answer. When an answering assistant is configured, only questions that offer `options` can be answered for the user; anything it cannot determine comes back marked as needing the user.",
    promptSnippet: "Ask the user one or more clarifying questions",
    promptGuidelines: [
      "Before acting on a prompt, ensure you fully understand the user's intent — if ambiguous, ask clarifying questions using the ask tool.",
      "Pass `context` with the facts needed to answer: versions, paths, decisions already made, relevant constraints. It is what an answering assistant judges; without it, questions come back marked as needing the user.",
      "Questions the result marks as needing the user must be put to the user in your reply. Do not re-call ask with the same question.",
    ],
    parameters: Type.Object({
      questions: Type.Array(askQuestionSchema, { minItems: 1, description: "Questions to ask. User navigates between them with Tab / Shift+Tab." }),
      context: Type.Optional(Type.String({ description: "Facts the questions should be judged against: what the task is, what has already been decided, versions, paths, constraints. Used when the configured assistant answers instead of the user." })),
    }),
    execute: async (_id, params, signal, _update, ctx: ExtensionContext) => {
      // Validate options for single/multi.
      for (const q of params.questions) {
        if ((q.type === "single" || q.type === "multi") && (!q.options || q.options.length === 0)) {
          return {
            content: [{ type: "text", text: `Question "${q.id}" (${q.type}) requires at least one option.` }],
            isError: true,
            details: {},
          };
        }
      }

      if (isJevAnswering()) return answerWithJev(params, signal, ctx);

      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "ask tool requires an interactive UI session." }],
          isError: true,
          details: {},
        };
      }

      const answers = await ctx.ui.custom<AskAnswer[] | undefined>(
        (tui, theme, _kb, done) => new AskComponent(tui, theme, params.questions, done),
      );

      if (!answers) {
        return {
          content: [{ type: "text", text: "User cancelled the questions." }],
          isError: false,
          details: { cancelled: true },
        };
      }

      return {
        content: [{ type: "text", text: formatAnswers(params.questions, answers) }],
        details: { answers },
      };
    },
  });
}
