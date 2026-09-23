/**
 * Types shared by the websearch providers.
 *
 * The tool exposes one parameter surface; each provider maps the subset it
 * understands. `supports` is the guard that keeps a filter from being silently
 * dropped by a backend that cannot honour it.
 */

export type WebSearchProviderName = "anysearch" | "exa" | "parallel";

/** Unified, provider-agnostic search request assembled from tool params. */
export interface WebSearchQuery {
  query: string;
  /** What the caller wants out of this search. Defaults to `query`. */
  objective?: string;
  numResults?: number;
  /** Extra query phrasings. Parallel takes them as its query list, exa as `additionalQueries`. */
  searchQueries?: string[];
  /** AnySearch vertical domain (academic, code, finance, legal, …). */
  domain?: string;
  subDomain?: string;
  subDomainParams?: Record<string, unknown>;
  /** Exa category filter. */
  category?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  /** ISO dates, exa only. */
  publishedAfter?: string;
  publishedBefore?: string;
  maxAgeHours?: number;
}

export interface WebSearchOutcome {
  /** Model-facing markdown. */
  text: string;
  meta?: Record<string, unknown>;
}

export interface WebSearchContext {
  sessionId?: string;
  modelName?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface WebSearchProvider {
  name: WebSearchProviderName;
  label: string;
  /**
   * False when the request carries fields this backend would ignore. A
   * backend that cannot honour a filter must not be used for it: returning
   * unfiltered results silently is worse than an error.
   */
  supports(query: WebSearchQuery): boolean;
  search(query: WebSearchQuery, ctx: WebSearchContext): Promise<WebSearchOutcome>;
}
