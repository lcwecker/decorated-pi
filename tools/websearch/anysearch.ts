/**
 * AnySearch hosted search — `search` / `batch_search` over MCP.
 *
 * The broadest of the keyless backends: 17 vertical domains, a batch call that
 * returns 2–5 independent query sets in one round trip, and a URL extraction
 * tool that tools/webfetch falls back to. Anonymous access works with lower
 * rate limits (the response carries `x-ratelimit-*` headers).
 *
 * The server returns ready-made markdown, so nothing is reformatted here.
 */

import { callJsonRpcTool } from "../../utils/jsonrpc.js";
import type { WebSearchContext, WebSearchOutcome, WebSearchProvider, WebSearchQuery } from "./types.js";

export const ANYSEARCH_URL = "https://api.anysearch.com/mcp";

/** Provider-enforced ceiling on `max_results`; batch accepts at most 5 queries. */
const MAX_RESULTS = 10;
const MAX_BATCH = 5;

function queryArgs(text: string, query: WebSearchQuery): Record<string, unknown> {
  const args: Record<string, unknown> = { query: text, max_results: Math.min(query.numResults ?? 8, MAX_RESULTS) };
  if (query.domain) args.domain = query.domain;
  if (query.subDomain) args.sub_domain = query.subDomain;
  if (query.subDomainParams) args.sub_domain_params = query.subDomainParams;
  return args;
}

/** The server heads every result set with `## Search Results (N results, Tms)`.
 *  Left as it arrives: it is the provider's own formatting, not ours. */

export const anysearchProvider: WebSearchProvider = {
  name: "anysearch",
  label: "AnySearch",
  // exa's filter set has no AnySearch equivalent, so a request carrying those
  // fields must not land here — the results would ignore them.
  supports: (query) =>
    !query.category &&
    !query.includeDomains?.length &&
    !query.excludeDomains?.length &&
    !query.publishedAfter &&
    !query.publishedBefore &&
    typeof query.maxAgeHours !== "number",
  async search(query: WebSearchQuery, ctx: WebSearchContext): Promise<WebSearchOutcome> {
    const extra = query.searchQueries ?? [];
    const options = { signal: ctx.signal, timeoutMs: ctx.timeoutMs };

    // Several phrasings for one intent → one batch call instead of N round trips.
    if (extra.length > 0) {
      const queries = [query.query, ...extra].slice(0, MAX_BATCH).map((text) => queryArgs(text, query));
      const text = await callJsonRpcTool(ANYSEARCH_URL, "batch_search", { queries }, options);
      return { text, meta: { tool: "batch_search", batch: queries.length } };
    }

    const text = await callJsonRpcTool(ANYSEARCH_URL, "search", queryArgs(query.query, query), options);
    return { text, meta: { tool: "search" } };
  },
};

/** Fetch a page through AnySearch's extraction tool. Used by tools/webfetch.
 *
 * The server answers 200 with an `extract_failed` body for pages it cannot
 * read, so a bare non-throw would hand the caller that string as content — it
 * is raised here instead, which is what lets the webfetch chain continue. */
export async function anysearchExtract(
  url: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const raw = (await callJsonRpcTool(ANYSEARCH_URL, "extract", { url }, options)).trim();

  let payload: { title?: string; url?: string; content?: string; error?: string } | undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") payload = parsed;
  } catch {
    /* not JSON: the server reported a failure as plain text */
  }

  if (payload?.error) throw new Error(`anysearch extract: ${payload.error}`);
  const content = payload?.content ?? raw;
  if (!content.trim()) throw new Error("anysearch extract returned no content");
  if (/extract_failed|unable to extract/i.test(content)) {
    throw new Error(`anysearch extract failed: ${content.replace(/\s+/g, " ").slice(0, 120)}`);
  }

  return [payload?.title ? `# ${payload.title}` : "", content].filter(Boolean).join("\n\n").trim();
}
