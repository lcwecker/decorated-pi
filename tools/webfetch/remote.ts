/**
 * Rendering backends for tools/webfetch.
 *
 * A plain HTTP client cannot execute JavaScript, pass a bot challenge or match
 * a browser's TLS fingerprint, and those are exactly the pages that matter for
 * research. Both backends below render server-side. They are only reached when
 * the local fetch fails, so a URL is handed to a third party only in the case
 * where the local path could not read it anyway.
 */

import { readCappedBytes } from "../../utils/http-body.js";
import { describeNetworkError } from "../../utils/net.js";
import { anysearchExtract } from "../websearch/anysearch.js";

/** Jina's reader prefix: `<prefix><url>` returns the page as markdown. */
export const JINA_READER_PREFIX = "https://r.jina.ai/";

/** Reader-side cap; the tool truncates further for the model. */
const MAX_BYTES = 5 * 1024 * 1024;

/** AnySearch's extraction tool renders server-side and returns markdown. */
export async function fetchViaAnySearch(
  url: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const text = await anysearchExtract(url, options);
  if (!text.trim()) throw new Error("anysearch extract returned no content");
  return text;
}

/** Jina reader. Free tier is 20 requests per minute per IP; no key needed. */
export async function fetchViaJina(
  url: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  let response: Response;
  let body: string;
  try {
    response = await fetch(`${JINA_READER_PREFIX}${url}`, {
      headers: { accept: "text/plain", "user-agent": "decorated-pi" },
      redirect: "follow",
      signal,
    });
    body = (await readCappedBytes(response, MAX_BYTES)).toString("utf-8");
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new Error(describeNetworkError(err, timeoutMs));
  }

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!body.trim()) throw new Error("reader returned no content");
  // The reader answers 200 even when the target refused it, and says so in the
  // body. Passing that through would hand the caller a challenge page as text.
  const targetError = /Warning: (Target URL returned error .+)/i.exec(body);
  if (targetError) throw new Error(`target refused the reader (${targetError[1].trim()})`);
  return body;
}
