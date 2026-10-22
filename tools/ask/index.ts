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
      [Type.Literal("text"), Type.Literal("single"), Type.Literal("multi"), Type.Null()],
      { description: "Send this on every question. text = free input, single = one option, multi = many options. A question that leaves it out and lists options is read as single, one without options as text." },
    ),
  ),
  question: Type.String({ description: "Question text shown to the user." }),
  options: Type.Optional(Type.Array(Type.String(), { description: "Options for single or multi choice. Each option MUST be a plain string (not an object). Example: [\"选项A\", \"选项B\", \"选项C\"]. The user picks by index; do NOT pass {id,text} objects." })),
  default: Type.Optional(Type.String({ description: "Default answer. For multi, comma-separated values." })),
});

/**
 * Fills in a missing `type`: options mean one choice, no options mean free
 * text. Without this a call that omits the field fails schema validation
 * before `execute` ever runs, which costs the model a round trip. A `null`
 * type — what a model sends when it reads an optional field as nullable —
 * falls through the same `??` and is resolved the same way.
 */
export function normalizeQuestions(questions: AskQuestionInput[]): AskQuestion[] {
  return questions.map((q) => ({
    ...q,
    type: q.type ?? (q.options && q.options.length > 0 ? "single" : "text"),
  }));
}

/** Whether the model left the type to us: absent, or `null` for the same
 *  reason. Both end up in the note that names what was inferred. */
function hasNoType(q: AskQuestionInput): boolean {
  return q.type === undefined || q.type === null;
}

/**
 * Model-facing note for the questions whose `type` we inferred.
 *
 * Only a choice question can be answered wrongly, so a question read as free
 * text stays silent: free text accepts every answer an option list would have
 * offered, and a note about it costs the caller tokens on a call that lost
 * nothing.
 */
export function inferredTypeNote(questions: AskQuestion[], inferredIds: string[]): string {
  const readAsOneChoice = inferredIds
    .map((id) => questions.find((q) => q.id === id))
    .filter((q): q is AskQuestion => q !== undefined && q.type === "single")
    .map((q) => q.id);
  if (readAsOneChoice.length === 0) return "";
  return `\n\nNote: no \`type\` given; ${readAsOneChoice.join(", ")} read as one choice. Send "multi" when several selections are possible.`;
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
    description: "Ask the user one or more questions and return their answers. Supports free text, single choice, and multiple choice; every question carries its `type`.",
    promptSnippet: "Ask the user one or more clarifying questions",
    promptGuidelines: [
      "Before acting on a prompt, ensure you fully understand the user's intent — if ambiguous, ask clarifying questions using the ask tool.",
    ],
    parameters: Type.Object({
      questions: Type.Array(askQuestionSchema, {
        minItems: 1,
        // The example is what makes models send `type` — the schema marks it
        // optional so an omission is still accepted, and a description alone
        // does not carry the shape.
        description: "Questions to ask. Send `type` on every question; a question with options needs one. Example: [{\"id\":\"scope\",\"type\":\"single\",\"question\":\"Which scope?\",\"options\":[\"local\",\"remote\"]}]. User navigates between them with Tab / Shift+Tab.",
      }),
    }),
    execute: async (_id, params, _signal, _update, ctx: ExtensionContext) => {
      const questions = normalizeQuestions(params.questions);
      const inferredTypeIds = params.questions.filter(hasNoType).map((q: AskQuestionInput) => q.id);

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
