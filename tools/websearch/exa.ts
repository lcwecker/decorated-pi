/**
 * Exa hosted search — `web_search_advanced_exa` over MCP.
 *
 * No API key: the anonymous tier of `mcp.exa.ai` exposes the advanced tool
 * once it is listed in the `tools` query parameter. That tool is the only
 * provider-side way to reach category filters, domain filters, date ranges,
 * summaries and highlights — `web_search_exa` accepts just
 * query/numResults/objective (`additionalProperties: false`) and silently
 * ignores anything else, which is why this calls the advanced one.
 *
 * An `EXA_API_KEY` lifts the free-tier limits; the hosted endpoint takes it as
 * `?exaApiKey=`, which a user can add through `~/.pi/agent/mcp.json`-style
 * overrides or by editing the URL below.
 */

import { callJsonRpcTool } from "../../utils/jsonrpc.js";
import type { WebSearchContext, WebSearchOutcome, WebSearchProvider, WebSearchQuery } from "./types.js";

export const EXA_URL =
  "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,web_search_advanced_exa";

/** Per-result body cap: results arrive as full page text and would otherwise
 *  dominate the context window. */
const MAX_RESULT_CHARS = 2500;

interface ExaResult {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  summary?: string;
  highlights?: string[];
  text?: string;
}

function renderExaResults(raw: string, query: WebSearchQuery): string | undefined {
  let payload: { results?: ExaResult[]; searchTime?: number };
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const results = payload.results ?? [];
  if (results.length === 0) return "";
  // No header line: the model needs the results, and the backend that answered
  // is already named in the fallback note and in the tool's details.
  const lines: string[] = [];
  results.forEach((r, i) => {
    lines.push(`### ${i + 1}. ${r.title ?? r.url ?? "(untitled)"}`);
    if (r.url) lines.push(r.url);
    if (r.publishedDate) lines.push(`Published: ${r.publishedDate}`);
    if (r.author) lines.push(`Author: ${r.author}`);
    const body = r.summary || (r.highlights?.length ? r.highlights.join("\n") : "");
    if (body) lines.push("", body);
    if (r.text) {
      const text = r.text.length > MAX_RESULT_CHARS ? `${r.text.slice(0, MAX_RESULT_CHARS)}…` : r.text;
      lines.push("", text);
    }
    lines.push("");
  });
  if (query.numResults && results.length < query.numResults) {
    lines.push(`(Exa returned ${results.length} of ${query.numResults} requested results.)`);
  }
  return lines.join("\n").trimEnd();
}

export const exaProvider: WebSearchProvider = {
  name: "exa",
  label: "Exa",
  // AnySearch verticals have no exa equivalent; everything else is exa's.
  supports: (query) => !query.domain && !query.subDomain,
  async search(query: WebSearchQuery, ctx: WebSearchContext): Promise<WebSearchOutcome> {
    const args: Record<string, unknown> = {
      query: query.query,
      numResults: Math.min(query.numResults ?? 8, 20),
      type: "auto",
      enableHighlights: true,
      textMaxCharacters: MAX_RESULT_CHARS,
    };
    if (query.objective) args.highlightsQuery = query.objective;
    if (query.category) args.category = query.category;
    if (query.includeDomains?.length) args.includeDomains = query.includeDomains;
    if (query.excludeDomains?.length) args.excludeDomains = query.excludeDomains;
    if (query.publishedAfter) args.startPublishedDate = query.publishedAfter;
    if (query.publishedBefore) args.endPublishedDate = query.publishedBefore;
    if (typeof query.maxAgeHours === "number") args.maxAgeHours = query.maxAgeHours;
    if (query.searchQueries?.length) args.additionalQueries = query.searchQueries;

    const raw = await callJsonRpcTool(EXA_URL, "web_search_advanced_exa", args, {
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
    });
    return {
      text: renderExaResults(raw, query) ?? raw,
      meta: { tool: "web_search_advanced_exa" },
    };
  },
};
