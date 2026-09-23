/**
 * websearch — one tool over three keyless hosted search backends.
 *
 * AnySearch → exa → parallel, stopping at the first backend that returns
 * results. All three answer without an API key, so the chain has no
 * configuration surface: no key prompt, no provider choice the user must make
 * before searching. `provider` pins a single backend when the caller wants a
 * specific one; that also disables the fallback, since pinning is a statement
 * about where the answer must come from.
 *
 * A request carrying a filter only one backend understands is sent to that
 * backend alone: handing `includeDomains` to a backend that ignores it would
 * return confident, unfiltered results.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderToolTextResult } from "../../utils/tool-output.js";
import { anysearchProvider } from "./anysearch.js";
import { exaProvider } from "./exa.js";
import { parallelProvider } from "./parallel.js";
import type { WebSearchProvider, WebSearchProviderName, WebSearchQuery } from "./types.js";

const PROVIDERS: WebSearchProvider[] = [anysearchProvider, exaProvider, parallelProvider];
const DEFAULT_CHAIN: WebSearchProviderName[] = ["anysearch", "exa", "parallel"];
const REQUEST_TIMEOUT_MS = 25_000;

/** Search payloads are the whole point of the call, but they still get a cap. */
const MAX_OUTPUT_CHARS = 20_000;

const webSearchParams = Type.Object({
  query: Type.String({
    description: "Natural language search query describing the ideal page, not just keywords.",
  }),
  objective: Type.Optional(
    Type.String({
      description:
        "What this search should establish: which sources to prefer, which facts or figures to pull. Defaults to the query. Parallel uses it as the ranking objective, exa as the highlight focus.",
    }),
  ),
  numResults: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 20,
      description: "Results to ask for (default: 8). AnySearch and Exa honour it; Parallel chooses its own count.",
    }),
  ),
  searchQueries: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Up to 4 extra phrasings of the same intent (3-6 keywords each). AnySearch runs them in one batch call, exa as additionalQueries, Parallel as its query list.",
    }),
  ),
  provider: Type.Optional(
    Type.Union(
      [Type.Literal("anysearch"), Type.Literal("exa"), Type.Literal("parallel")],
      { description: "Pin one backend instead of the default chain. Disables fallback." },
    ),
  ),
  domain: Type.Optional(
    Type.String({
      description:
        "AnySearch vertical: academic, agriculture, business, code, energy, environment, film, finance, gaming, health, ip, legal, resource, security, social_media, travel.",
    }),
  ),
  subDomain: Type.Optional(
    Type.String({ description: "AnySearch vertical sub-domain. Call with domain to target a specific dataset." }),
  ),
  category: Type.Optional(
    Type.String({
      description: "exa category filter: company, publication, news, pdf, github, personal site, people, financial report.",
    }),
  ),
  includeDomains: Type.Optional(Type.Array(Type.String(), { description: "exa only. Restrict results to these domains." })),
  excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "exa only. Drop results from these domains." })),
  publishedAfter: Type.Optional(Type.String({ description: "exa only. ISO date (YYYY-MM-DD)." })),
  publishedBefore: Type.Optional(Type.String({ description: "exa only. ISO date (YYYY-MM-DD)." })),
  maxAgeHours: Type.Optional(
    Type.Number({ description: "exa only. Maximum cached-content age; 0 forces a fresh fetch." }),
  ),
});

function providerByName(name: WebSearchProviderName): WebSearchProvider {
  const found = PROVIDERS.find((p) => p.name === name);
  if (!found) throw new Error(`unknown search provider: ${name}`);
  return found;
}

/** True when the request carries an exa-only filter. */
function needsExa(query: WebSearchQuery): boolean {
  return Boolean(
    query.category ||
      query.includeDomains?.length ||
      query.excludeDomains?.length ||
      query.publishedAfter ||
      query.publishedBefore ||
      typeof query.maxAgeHours === "number",
  );
}

/** True when the request carries an AnySearch-only vertical. */
function needsAnysearch(query: WebSearchQuery): boolean {
  return Boolean(query.domain || query.subDomain);
}

export function selectProviders(
  query: WebSearchQuery,
  explicit?: WebSearchProviderName,
): WebSearchProvider[] {
  if (explicit) return [providerByName(explicit)];
  if (needsExa(query)) return [exaProvider];
  if (needsAnysearch(query)) return [anysearchProvider];
  return DEFAULT_CHAIN.map(providerByName);
}

function capOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n[Truncated: kept the first ${MAX_OUTPUT_CHARS} of ${text.length} characters]`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function noteFallback(attempted: Array<{ provider: string; error?: string }>, winner: string): string {
  if (attempted.length === 0) return "";
  const skipped = attempted.map((a) => `${a.provider}: ${a.error}`).join("; ");
  return `(fell back to ${providerByName(winner as WebSearchProviderName).label} — ${skipped})\n\n`;
}

export function registerWebSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "websearch",
    label: "Web search",
    description:
      "Search the web for current information, news, docs, versions and facts beyond the training cutoff. Tries AnySearch, then Exa, then Parallel — all work without an API key. Returns result titles, URLs and extracted page text. Use it to discover pages; use webfetch to read a URL you already have.",
    promptSnippet: "Search the web (AnySearch, Exa, Parallel — no API key required)",
    promptGuidelines: [
      "Prefer websearch over guessing when a question depends on current versions, release notes, prices, or anything past your training cutoff.",
      "Pass extra phrasings through searchQueries instead of calling websearch several times; the backends batch them in one round trip.",
      "Use search results as pointers, then webfetch or read the specific page when the snippet is not enough to answer.",
    ],
    parameters: webSearchParams,
    renderResult: renderToolTextResult,
    execute: async (_id, params, signal, _update, ctx: ExtensionContext) => {
      const query: WebSearchQuery = {
        query: params.query,
        objective: params.objective,
        numResults: params.numResults,
        searchQueries: params.searchQueries,
        domain: params.domain,
        subDomain: params.subDomain,
        category: params.category,
        includeDomains: params.includeDomains,
        excludeDomains: params.excludeDomains,
        publishedAfter: params.publishedAfter,
        publishedBefore: params.publishedBefore,
        maxAgeHours: params.maxAgeHours,
      };

      const chain = selectProviders(query, params.provider);
      const attempted: Array<{ provider: string; error?: string }> = [];
      const context = {
        sessionId: ctx.sessionManager?.getSessionId?.(),
        modelName: ctx.model?.id,
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
      };

      for (const provider of chain) {
        if (!provider.supports(query)) {
          attempted.push({ provider: provider.name, error: "cannot honour the requested filters" });
          continue;
        }
        try {
          const outcome = await provider.search(query, context);
          const text = outcome.text.trim();
          if (!text) {
            attempted.push({ provider: provider.name, error: "no results" });
            continue;
          }
          return {
            content: [{ type: "text", text: capOutput(noteFallback(attempted, provider.name) + text) }],
            isError: false,
            details: { provider: provider.name, attempted, ...(outcome.meta ?? {}) },
          };
        } catch (err) {
          if (signal?.aborted) throw err;
          attempted.push({ provider: provider.name, error: errorText(err) });
        }
      }

      const reasons = attempted.map((a) => `${a.provider}: ${a.error}`).join("; ");
      return {
        content: [{ type: "text", text: `websearch failed — ${reasons || "no provider available"}` }],
        isError: true,
        details: { attempted },
      };
    },
  });
}
