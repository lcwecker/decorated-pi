/**
 * Parallel.ai hosted search — `web_search` over MCP.
 *
 * Objective-shaped rather than keyword-shaped: one natural-language objective
 * plus 1–3 short keyword queries. Free tier is counted per `session_id`, so
 * calls carry pi's session id; `model_name` is analytics only on their side.
 * The reply advertises what the call cost (`_meta.parallel/usage`), which is
 * surfaced as metadata.
 *
 * `web_fetch` on the same endpoint is the retrieval half and is used by
 * tools/webfetch when the local fetch fails.
 */

import { callJsonRpcTool } from "../../utils/jsonrpc.js";
import type { WebSearchContext, WebSearchOutcome, WebSearchProvider, WebSearchQuery } from "./types.js";

export const PARALLEL_URL = "https://search.parallel.ai/mcp";

const MAX_EXCERPT_CHARS = 1200;

interface ParallelResult {
  url?: string;
  title?: string;
  publish_date?: string;
  excerpts?: string[];
}

function renderParallelResults(raw: string): string | undefined {
  let payload: { results?: ParallelResult[]; warnings?: unknown };
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const results = payload.results ?? [];
  if (results.length === 0) return "";
  // No header line: results only, same shape as the other backends.
  const lines: string[] = [];
  results.forEach((r, i) => {
    lines.push(`### ${i + 1}. ${r.title ?? r.url ?? "(untitled)"}`);
    if (r.url) lines.push(r.url);
    if (r.publish_date) lines.push(`Published: ${r.publish_date}`);
    const body = (r.excerpts ?? []).join("\n…\n");
    if (body) {
      lines.push("", body.length > MAX_EXCERPT_CHARS ? `${body.slice(0, MAX_EXCERPT_CHARS)}…` : body);
    }
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

export const parallelProvider: WebSearchProvider = {
  name: "parallel",
  label: "Parallel",
  // Parallel's tool takes an objective and keyword queries. Every filter field
  // in WebSearchQuery beyond those two would be ignored.
  supports: (query) =>
    !query.domain &&
    !query.subDomain &&
    !query.category &&
    !query.includeDomains?.length &&
    !query.excludeDomains?.length &&
    !query.publishedAfter &&
    !query.publishedBefore &&
    typeof query.maxAgeHours !== "number",
  async search(query: WebSearchQuery, ctx: WebSearchContext): Promise<WebSearchOutcome> {
    const searchQueries = query.searchQueries?.length ? query.searchQueries : [query.query];
    const args: Record<string, unknown> = {
      objective: query.objective ?? query.query,
      search_queries: searchQueries.slice(0, 3),
    };
    if (ctx.sessionId) args.session_id = ctx.sessionId;
    if (ctx.modelName) args.model_name = ctx.modelName;

    const raw = await callJsonRpcTool(PARALLEL_URL, "web_search", args, {
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
    });
    return { text: renderParallelResults(raw) ?? raw, meta: { tool: "web_search" } };
  },
};
