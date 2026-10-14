/**
 * ask — ask the user one or more questions and return their answers.
 *
 * The TUI wizard answers every call: free text, single choice, and multiple
 * choice, navigated together with Tab / Shift+Tab. A session without a UI gets
 * an error rather than a guess.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AskComponent, type AskAnswer, type AskQuestion, type AskQuestionInput } from "../../ui/ask.js";

const askQuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question in the result." }),
  type: Type.Optional(
    Type.Union(
      [Type.Literal("text"), Type.Literal("single"), Type.Literal("multi")],
      { description: "text = free input, single = one option, multi = many options. Optional: a question that lists options defaults to single, one without options to text." },
    ),
  ),
  question: Type.String({ description: "Question text shown to the user." }),
  options: Type.Optional(Type.Array(Type.String(), { description: "Options for single or multi choice. Each option MUST be a plain string (not an object). Example: [\"选项A\", \"选项B\", \"选项C\"]. The user picks by index; do NOT pass {id,text} objects." })),
  default: Type.Optional(Type.String({ description: "Default answer. For multi, comma-separated values." })),
});

/**
 * Fills in a missing `type`: options mean one choice, no options mean free
 * text. Without this a call that omits the field fails schema validation
 * before `execute` ever runs, which costs the model a round trip.
 */
export function normalizeQuestions(questions: AskQuestionInput[]): AskQuestion[] {
  return questions.map((q) => ({
    ...q,
    type: q.type ?? (q.options && q.options.length > 0 ? "single" : "text"),
  }));
}

/**
 * Model-facing note for questions whose `type` was left out, so a wrong
 * inference (options read as one choice) arrives in the result rather than
 * passing unmentioned. `details` reaches the TUI, and this reaches the caller.
 */
export function inferredTypeNote(questions: AskQuestion[], inferredIds: string[]): string {
  if (inferredIds.length === 0) return "";
  const resolved = inferredIds
    .map((id) => {
      const q = questions.find((x) => x.id === id);
      return q ? `${id} \u2192 "${q.type}"` : undefined;
    })
    .filter((entry): entry is string => entry !== undefined)
    .join(", ");
  if (!resolved) return "";
  return `\n\nNote: no \`type\` given; resolved ${resolved}. Re-ask with an explicit type when the intent differed: a question with options defaults to "single", and multiple selections need "multi".`;
}

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

export function registerAskTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask",
    label: "Ask user",
    description: "Ask the user one or more questions and return their answers. Supports free text, single choice, and multiple choice.",
    promptSnippet: "Ask the user one or more clarifying questions",
    promptGuidelines: [
      "Before acting on a prompt, ensure you fully understand the user's intent — if ambiguous, ask clarifying questions using the ask tool.",
    ],
    parameters: Type.Object({
      questions: Type.Array(askQuestionSchema, {
        minItems: 1,
        description: "Questions to ask. Each one needs an id and a question; add options for a choice question. The type is optional — a question with options reads as single choice, one without as free text. User navigates between them with Tab / Shift+Tab.",
      }),
    }),
    execute: async (_id, params, _signal, _update, ctx: ExtensionContext) => {
      const questions = normalizeQuestions(params.questions);
      const inferredTypeIds = params.questions.filter((q) => q.type === undefined).map((q) => q.id);

      // Validate options for single/multi.
      for (const q of questions) {
        if ((q.type === "single" || q.type === "multi") && (!q.options || q.options.length === 0)) {
          return {
            content: [{ type: "text", text: `Question "${q.id}" (${q.type}) requires at least one option.` }],
            isError: true,
            details: {},
          };
        }
      }

      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "ask tool requires an interactive UI session." }],
          isError: true,
          details: {},
        };
      }

      const answers = await ctx.ui.custom<AskAnswer[] | undefined>(
        (tui, theme, _kb, done) => new AskComponent(tui, theme, questions, done),
      );

      if (!answers) {
        return {
          content: [{ type: "text", text: "User cancelled the questions." }],
          isError: false,
          details: { cancelled: true },
        };
      }

      return {
        content: [{ type: "text", text: formatAnswers(questions, answers) + inferredTypeNote(questions, inferredTypeIds) }],
        details: { answers },
      };
    },
  });
}
