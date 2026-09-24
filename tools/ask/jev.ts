/**
 * ask → Jev translation, and the rules that decide when Jev's answer counts.
 *
 * Every question becomes a closed question so the answer space is finite:
 *
 *   single → one `choice` over the options, with an `ask user` option appended
 *   multi  → one `noul` per option, plus a `noul` for "the context cannot decide"
 *   text   → nothing is asked; free text has no answer space to judge
 *
 * The `ask user` option competes for probability mass against the real options
 * inside one distribution, which is the point: a context that does not contain
 * the answer should push mass there rather than into the most plausible-
 * sounding option. A wrong auto-answer costs more than an extra question.
 *
 * Question `default` values are deliberately NOT sent. A default is the asking
 * model's own guess, and feeding it back would let Jev echo that guess while
 * looking like independent evidence.
 */

import type { SystemOneAnswer, SystemOneQuestion } from "../../utils/typesafe.js";

/** Appended to every `single` question. Kept in English: it is part of the
 *  rubric Jev reads, and the result tells the model what it means. */
export const ASK_USER_OPTION = "ask user";

/** Winner probability needed to accept a single-choice answer. */
export const CHOICE_ACCEPT = 0.8;
/** Probability mass on `ask user` that always routes to the user. */
export const CHOICE_ASK_USER_MAX = 0.1;
/** Per-option probability needed to select an option in a multi question.
 *  Same bar as a single choice: an option Jev is not sure about is left out
 *  rather than asserted, and the asking model's own question to the user costs
 *  less than a wrong auto-answer. */
export const NOUL_ACCEPT = 0.8;
/** Probability that the context cannot decide, which routes a multi to the user. */
export const NOUL_ESCALATE = 0.3;

/** Irreversible or consequential asks stay with the user whatever Jev answers:
 *  the point of those questions is that a person owns the decision. Matching is
 *  a backstop, not the primary mechanism — it only has to catch the case where
 *  the asking model forgot that it was asking one. */
const CONSEQUENTIAL = [
  /\bdelete\b|\bdrop\b|\btruncate\b|\breset --hard\b|\bforce[- ]?push\b/i,
  /\bprod(uction)?\b|\bdeploy\b|\brelease\b|\bro[lt]{2}back\b/i,
  /\bcredential|\bapi[-_ ]?key|\bsecret|\btoken\b/i,
  /删除|删掉|清空|回滚|重推|部署|上线|发布|凭据|密钥|密码/,
];

export interface AskQuestionLike {
  id: string;
  type: "text" | "single" | "multi";
  question: string;
  options?: string[];
  /** Present on the tool's questions; deliberately unused here — see the note
   *  at the top of this file. */
  default?: string;
}

/** A question that never reaches Jev, with the reason to report. */
export interface DeferredQuestion {
  id: string;
  question: string;
  reason: string;
}

export interface PreparedQuestions {
  /** Question ids in the caller's order, so the result reads in that order. */
  order: string[];
  /** Questions to send, keyed by the answer id they come back under. */
  asked: Record<string, SystemOneQuestion>;
  /** Questions answered by the user without asking: already decided. */
  deferred: DeferredQuestion[];
  /** Answer id → how to fold it back into the original question. */
  plan: AnswerPlan[];
}

export type AnswerPlan =
  | { kind: "choice"; questionId: string; question: string }
  | { kind: "multi"; questionId: string; question: string; optionKeys: Array<{ key: string; option: string }>; escalateKey: string };

export function isConsequential(text: string): boolean {
  return CONSEQUENTIAL.some((pattern) => pattern.test(text));
}

/** Build the request questions and the plan for reading the answers back. */
export function prepareQuestions(questions: AskQuestionLike[]): PreparedQuestions {
  const prepared: PreparedQuestions = { order: questions.map((q) => q.id), asked: {}, deferred: [], plan: [] };

  for (const question of questions) {
    if (isConsequential(question.question)) {
      prepared.deferred.push({
        id: question.id,
        question: question.question,
        reason: "consequential question — the user decides",
      });
      continue;
    }

    if (question.type === "single") {
      const options = question.options ?? [];
      if (options.length === 0) {
        prepared.deferred.push({ id: question.id, question: question.question, reason: "no options offered" });
        continue;
      }
      const criteria: Record<string, string | null> = {};
      for (const option of options) criteria[option] = null;
      criteria[ASK_USER_OPTION] = "The context does not determine which option the user wants.";
      prepared.asked[question.id] = { type: "choice", instructions: question.question, criteria };
      prepared.plan.push({ kind: "choice", questionId: question.id, question: question.question });
      continue;
    }

    if (question.type === "multi") {
      const options = question.options ?? [];
      if (options.length === 0) {
        prepared.deferred.push({ id: question.id, question: question.question, reason: "no options offered" });
        continue;
      }
      const optionKeys = options.map((option, index) => ({ key: `${question.id}#${index}`, option }));
      for (const { key, option } of optionKeys) {
        prepared.asked[key] = {
          type: "noul",
          instructions: `Should "${option}" be selected for this question: ${question.question}`,
        };
      }
      const escalateKey = `${question.id}#ask_user`;
      prepared.asked[escalateKey] = {
        type: "noul",
        instructions: `Does the available context fail to determine which options apply to this question: ${question.question}`,
      };
      prepared.plan.push({
        kind: "multi",
        questionId: question.id,
        question: question.question,
        optionKeys,
        escalateKey,
      });
      continue;
    }

    prepared.deferred.push({
      id: question.id,
      question: question.question,
      reason: "free-text question — only the user can answer it",
    });
  }

  return prepared;
}

export interface ResolvedAnswer {
  id: string;
  /** The question as asked, so the result reads `question: answer`. */
  question: string;
  value: string;
  /** How likely the accepted answer is: winner probability, or the weakest
   *  selected option for a multi question. */
  probability: number;
}

export interface ResolvedQuestions {
  resolved: ResolvedAnswer[];
  /** Everything Jev handed back, with the reason to report. */
  needsUser: DeferredQuestion[];
}

export interface ResolveOptions {
  /** Reason recorded for a question that was sent but came back without an
   *  answer. Defaults to "no answer returned"; the caller overrides it when
   *  the request never went out, so the reported reason matches the cause. */
  noAnswerReason?: string;
}

/** Apply the accept/escalate thresholds to Jev's answers. */
export function resolveQuestions(
  prepared: PreparedQuestions,
  answers: Record<string, SystemOneAnswer>,
  options: ResolveOptions = {},
): ResolvedQuestions {
  const noAnswer = options.noAnswerReason ?? "no answer returned";
  const resolved: ResolvedAnswer[] = [];
  const needsUser: DeferredQuestion[] = [...prepared.deferred];

  for (const plan of prepared.plan) {
    if (plan.kind === "choice") {
      const answer = answers[plan.questionId];
      const pick = answer?.choice;
      if (!pick) {
        needsUser.push({ id: plan.questionId, question: plan.question, reason: noAnswer });
        continue;
      }
      const askUser = answer.probabilities?.[ASK_USER_OPTION] ?? 0;
      const probability = answer.probabilities?.[pick] ?? 0;
      if (pick === ASK_USER_OPTION) {
        needsUser.push({ id: plan.questionId, question: plan.question, reason: "the context does not determine it" });
        continue;
      }
      if (askUser > CHOICE_ASK_USER_MAX || probability < CHOICE_ACCEPT) {
        needsUser.push({
          id: plan.questionId,
          question: plan.question,
          reason: `not confident enough (${(probability * 100).toFixed(0)}%)`,
        });
        continue;
      }
      resolved.push({ id: plan.questionId, question: plan.question, value: pick, probability });
      continue;
    }

    const escalateAnswer = answers[plan.escalateKey];
    if (!escalateAnswer) {
      needsUser.push({ id: plan.questionId, question: plan.question, reason: noAnswer });
      continue;
    }
    const escalate = escalateAnswer.noul ?? 1;
    const selected = plan.optionKeys
      .map(({ key, option }) => ({ option, probability: answers[key]?.noul ?? 0 }))
      .filter(({ probability }) => probability >= NOUL_ACCEPT);
    if (selected.length === 0 || escalate > NOUL_ESCALATE) {
      needsUser.push({
        id: plan.questionId,
        question: plan.question,
        reason: selected.length === 0 ? "no option cleared the threshold" : "the context does not determine it",
      });
      continue;
    }
    resolved.push({
      id: plan.questionId,
      question: plan.question,
      value: selected.map((s) => s.option).join(", "),
      probability: Math.min(...selected.map((s) => s.probability)),
    });
  }

  // Both blocks are collected across passes (deferred before the request,
  // escalated while resolving), so restore the order the caller asked in
  // rather than relying on plan order.
  const position = (id: string) => {
    const index = prepared.order.indexOf(id);
    return index === -1 ? prepared.order.length : index;
  };
  const byCallerOrder = (a: { id: string }, b: { id: string }) => position(a.id) - position(b.id);
  resolved.sort(byCallerOrder);
  needsUser.sort(byCallerOrder);

  return { resolved, needsUser };
}

/** Model-facing result.
 *
 *  Answered questions read `question: answer` — the same shape the wizard path
 *  produces, so a person reading the transcript does not have to learn two
 *  layouts. Questions that came back are listed after a single marker; the
 *  probabilities stay in `details` for anyone checking calibration. */
export function formatJevResult(
  resolved: ResolvedAnswer[],
  needsUser: DeferredQuestion[],
  jevError?: string,
): string {
  const lines: string[] = [];
  for (const answer of resolved) lines.push(`${answer.question}: ${answer.value}`);
  if (jevError) lines.push(`Jev unavailable: ${jevError}`);
  if (needsUser.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("needs the user (put these in your reply):");
    for (const entry of needsUser) lines.push(`- ${entry.question}`);
  }
  return lines.join("\n");
}
