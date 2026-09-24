/**
 * TypeSafe System One client — one evaluation per request.
 *
 * The endpoint takes a `state` plus a map of typed questions and returns one
 * typed answer per question, so a caller never parses prose out of a model.
 * Only the two question shapes the `ask` tool can express are modelled here:
 * `choice` (a closed option set) and `noul` (a yes/no probability).
 *
 * The API key is only ever placed in the Authorization header; it is not
 * logged, not echoed into errors, and not part of the request body.
 */

import { readCappedBody } from "./http-body.js";

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_MODEL = "jev-latest";

/** Jev answers in 70–500ms. A question that has to wait longer than this is
 *  one the caller would rather route to the user. */
export const DEFAULT_TIMEOUT_MS = 1500;
export const DEFAULT_MAX_BYTES = 256 * 1024;

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Option → rubric description. `null` when the option needs no detail. */
  criteria: Record<string, string | null>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export type SystemOneQuestion = ChoiceQuestion | NoulQuestion;

export interface SystemOneAnswer {
  type: "choice" | "noul";
  /** Highest-probability option (choice answers). */
  choice?: string;
  /** Probability that the statement is true (noul answers). */
  noul?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export class TypesafeError extends Error {
  constructor(
    message: string,
    /** HTTP status when the failure was a response; undefined for transport. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "TypesafeError";
  }
}

export interface EvaluateOptions {
  apiKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  model?: string;
}

function isAnswerMap(value: unknown): value is Record<string, SystemOneAnswer> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Evaluate `questions` against `state`. Throws TypesafeError on any failure —
 *  the caller decides what an unanswered question means. */
export async function evaluateSystemOne(
  state: unknown,
  questions: Record<string, SystemOneQuestion>,
  options: EvaluateOptions,
): Promise<Record<string, SystemOneAnswer>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await fetch(TYPESAFE_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        state,
        model: options.model ?? TYPESAFE_MODEL,
        questions,
      }),
      signal,
    });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new TypesafeError(`timed out after ${timeoutMs}ms`);
    }
    throw new TypesafeError(err instanceof Error ? err.message : String(err));
  }

  let body: string;
  try {
    body = await readCappedBody(response, DEFAULT_MAX_BYTES);
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new TypesafeError(err instanceof Error ? err.message : String(err));
  }

  if (!response.ok) {
    // 422 means our question shapes are wrong, so the body is worth keeping.
    throw new TypesafeError(`HTTP ${response.status}: ${body.trim().slice(0, 200)}`, response.status);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new TypesafeError(`unparsable response: ${body.trim().slice(0, 120)}`);
  }

  const answers = (payload as { answers?: unknown })?.answers;
  if (!isAnswerMap(answers)) throw new TypesafeError("response carried no answers");
  return answers;
}
