/**
 * ask — ask the user one or more questions and return their answers.
 *
 * Supports free text, single-choice, and multiple-choice questions.
 * Uses a custom TUI component so multiple questions can be presented
 * together and navigated with Tab / Shift+Tab.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AskComponent, type AskAnswer, type AskQuestion } from "../../ui/ask.js";

const askQuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question in the result." }),
  type: Type.Union(
    [Type.Literal("text"), Type.Literal("single"), Type.Literal("multi")],
    { description: "text = free input, single = one option, multi = many options" },
  ),
  question: Type.String({ description: "Question text shown to the user." }),
  options: Type.Optional(Type.Array(Type.String(), { description: "Options for single or multi choice." })),
  default: Type.Optional(Type.String({ description: "Default answer. For multi, comma-separated values." })),
  allowCustom: Type.Optional(Type.Boolean({
    description: "For single/multi: append an \"Other\" row that toggles into a free-text input. Lets the user enter a custom answer not in the preset list.",
  })),
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

export function registerAskTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask",
    label: "Ask user",
    description: "Ask the user one or more questions and return their answers. Supports free text, single choice, and multiple choice. Use when you need clarification or a decision before continuing.",
    promptSnippet: "Ask the user one or more clarifying questions",
    promptGuidelines: [
      "Before acting on a prompt, ensure you fully understand the user's intent — if ambiguous, ask clarifying questions using the ask tool.",
    ],
    parameters: Type.Object({
      questions: Type.Array(askQuestionSchema, { minItems: 1, description: "Questions to ask. User navigates between them with Tab / Shift+Tab." }),
    }),
    execute: async (_id, params, _signal, _update, ctx) => {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "ask tool requires an interactive UI session." }],
          isError: true,
          details: {},
        };
      }

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
