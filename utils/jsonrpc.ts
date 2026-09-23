/**
 * One-shot JSON-RPC over HTTP — the stateless subset of MCP needed to call a
 * hosted tool (`tools/call`).
 *
 * No `initialize` handshake, no session header, no `tools/list`: hosted
 * endpoints such as `mcp.exa.ai`, `search.parallel.ai` and `api.anysearch.com`
 * answer `tools/call` directly, which keeps a search to a single POST. Tools
 * that advertise themselves over streamable HTTP reply either as plain JSON or
 * as an SSE frame (`data: {...}`), so both shapes are parsed here.
 *
 * Shared by tools/websearch and tools/webfetch; knows nothing about either.
 */

import { readCappedBody } from "./http-body.js";
import { describeNetworkError } from "./net.js";

export const DEFAULT_TIMEOUT_MS = 25_000;
export const DEFAULT_MAX_BYTES = 256 * 1024;

export interface JsonRpcCallOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

/** Non-2xx response. Callers use `status` to decide whether to fail over. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "HttpStatusError";
  }
}

interface JsonRpcMessage {
  result?: { content?: Array<{ type?: string; text?: string }> };
  error?: { code?: number; message?: string };
}

function parseMessage(raw: string): JsonRpcMessage | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed) as JsonRpcMessage;
  } catch {
    return undefined;
  }
}

/** Parse a JSON-RPC reply from either a plain body or an SSE frame. */
export function parseJsonRpcMessage(body: string): JsonRpcMessage | undefined {
  const direct = parseMessage(body);
  if (direct) return direct;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const parsed = parseMessage(line.slice(6));
    if (parsed) return parsed;
  }
  return undefined;
}

/** Concatenate the text parts of a `tools/call` result. */
export function extractToolText(message: JsonRpcMessage): string {
  return (message.result?.content ?? [])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

function describeFetchError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && err.name === "TimeoutError") return `request timed out after ${timeoutMs}ms`;
  return describeNetworkError(err, timeoutMs);
}

/**
 * POST `tools/call` and return the text of the first text content part.
 *
 * Throws HttpStatusError on a non-2xx status, and a plain Error on a JSON-RPC
 * error, an unparsable body, a timeout or a size overrun. An aborted caller
 * signal rethrows the original abort so tool code can treat it as cancelled.
 */
export async function callJsonRpcTool(
  url: string,
  tool: string,
  args: unknown,
  options: JsonRpcCallOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...options.headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
      signal,
    });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new Error(describeFetchError(err, timeoutMs));
  }

  let body: string;
  try {
    body = await readCappedBody(response, options.maxBytes ?? DEFAULT_MAX_BYTES);
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new Error(describeFetchError(err, timeoutMs));
  }

  if (!response.ok) throw new HttpStatusError(response.status, body);

  const message = parseJsonRpcMessage(body);
  if (!message) throw new Error(`${tool}: unparsable response (${body.trim().slice(0, 120)})`);
  if (message.error) throw new Error(`${tool}: ${message.error.message ?? "JSON-RPC error"}`);
  return extractToolText(message);
}
