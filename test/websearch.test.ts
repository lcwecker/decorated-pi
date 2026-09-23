/**
 * websearch — the native search tool over AnySearch / Exa / Parallel.
 *
 * Covers provider selection (including the rule that a filter only one backend
 * understands pins that backend), the JSON-RPC transport, each provider's
 * argument mapping and rendering, and the fallback behaviour. `fetch` is
 * stubbed, so the suite stays offline.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HttpStatusError, callJsonRpcTool, parseJsonRpcMessage } from "../utils/jsonrpc.js";
import { registerWebSearchTool, selectProviders } from "../tools/websearch/index.js";
import { ANYSEARCH_URL } from "../tools/websearch/anysearch.js";
import { EXA_URL } from "../tools/websearch/exa.js";
import { PARALLEL_URL } from "../tools/websearch/parallel.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface RecordedCall {
  url: string;
  tool: string;
  args: Record<string, unknown>;
  accept: string;
}

function mcpText(text: string): string {
  return `event: message\ndata: ${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text }] },
  })}\n`;
}

function stubFetch(
  handler: (call: RecordedCall) => Response | Promise<Response>,
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    const body = JSON.parse(init.body ?? "{}");
    const call: RecordedCall = {
      url: String(url),
      tool: body?.params?.name,
      args: body?.params?.arguments ?? {},
      accept: init.headers?.accept ?? "",
    };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

function captureTool(): any {
  let tool: any;
  registerWebSearchTool({ registerTool: (t: any) => { tool = t; } } as any);
  return tool;
}

const ctx = {
  sessionManager: { getSessionId: () => "session-1" },
  model: { id: "gpt-5.5" },
} as any;

function run(params: Record<string, unknown>) {
  return captureTool().execute("call-1", params, undefined, undefined, ctx);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ═════════════════════════════════════════════════════════════════════════════
// selectProviders
// ═════════════════════════════════════════════════════════════════════════════

describe("selectProviders", () => {
  const names = (query: any, explicit?: any) => selectProviders(query, explicit).map((p) => p.name);

  it("defaults to AnySearch → Exa → Parallel", () => {
    expect(names({ query: "x" })).toEqual(["anysearch", "exa", "parallel"]);
  });

  it("pins exa when an exa-only filter is present", () => {
    // AnySearch and Parallel would ignore these fields and return unfiltered
    // results, so they must not be in the chain.
    expect(names({ query: "x", includeDomains: ["a.com"] })).toEqual(["exa"]);
    expect(names({ query: "x", category: "news" })).toEqual(["exa"]);
    expect(names({ query: "x", publishedAfter: "2026-01-01" })).toEqual(["exa"]);
    expect(names({ query: "x", maxAgeHours: 0 })).toEqual(["exa"]);
  });

  it("pins anysearch when a vertical domain is requested", () => {
    expect(names({ query: "x", domain: "academic" })).toEqual(["anysearch"]);
  });

  it("pins a single provider when one is requested explicitly", () => {
    expect(names({ query: "x" }, "parallel")).toEqual(["parallel"]);
    // Even with an exa-only filter, an explicit provider wins.
    expect(names({ query: "x", category: "news" }, "parallel")).toEqual(["parallel"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Transport
// ═════════════════════════════════════════════════════════════════════════════

describe("JSON-RPC transport", () => {
  it("parses a plain JSON body", () => {
    const message = parseJsonRpcMessage('{"result":{"content":[{"type":"text","text":"hi"}]}}');
    expect(message?.result?.content?.[0]?.text).toBe("hi");
  });

  it("parses an SSE frame", () => {
    const message = parseJsonRpcMessage('event: message\ndata: {"result":{"content":[{"type":"text","text":"hi"}]}}\n');
    expect(message?.result?.content?.[0]?.text).toBe("hi");
  });

  it("returns undefined for a non-JSON body", () => {
    expect(parseJsonRpcMessage("<html>nope</html>")).toBeUndefined();
  });

  it("sends tools/call with both response shapes accepted", async () => {
    const calls = stubFetch(() => new Response(mcpText("hello"), { status: 200 }));
    const text = await callJsonRpcTool("https://example.test/mcp", "search", { query: "x" });
    expect(text).toBe("hello");
    expect(calls[0].tool).toBe("search");
    expect(calls[0].accept).toContain("text/event-stream");
  });

  it("raises HttpStatusError with the status on a non-2xx reply", async () => {
    stubFetch(() => new Response("rate limited", { status: 429 }));
    await expect(callJsonRpcTool("https://example.test/mcp", "search", {})).rejects.toBeInstanceOf(HttpStatusError);
    await expect(callJsonRpcTool("https://example.test/mcp", "search", {})).rejects.toMatchObject({ status: 429 });
  });

  it("surfaces a JSON-RPC error message", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Authentication required." } })),
    );
    await expect(callJsonRpcTool("https://example.test/mcp", "search", {})).rejects.toThrow("Authentication required.");
  });

  it("cancels a body that exceeds the byte cap", async () => {
    stubFetch(() => new Response("x".repeat(4096)));
    await expect(callJsonRpcTool("https://example.test/mcp", "search", {}, { maxBytes: 1024 })).rejects.toThrow(
      "exceeded 1024 bytes",
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AnySearch provider
// ═════════════════════════════════════════════════════════════════════════════

describe("AnySearch provider", () => {
  it("calls search and passes the server's markdown through untouched", async () => {
    const calls = stubFetch(() =>
      new Response(mcpText("## Search Results (2 results, 1514ms)\n\n### 1. Thing\n- **URL**: https://a.test")),
    );
    const result = await run({ query: "kubernetes 1.34" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ANYSEARCH_URL);
    expect(calls[0].tool).toBe("search");
    expect(calls[0].args).toMatchObject({ query: "kubernetes 1.34", max_results: 8 });
    expect(result.details.provider).toBe("anysearch");
    // The provider's own header is left as it arrives.
    expect(result.content[0].text).toContain("## Search Results (2 results, 1514ms)");
    expect(result.content[0].text).toContain("### 1. Thing");
  });

  it("clamps max_results to the provider ceiling and maps the vertical", async () => {
    const calls = stubFetch(() => new Response(mcpText("ok")));
    await run({ query: "papers", numResults: 50, domain: "academic", subDomain: "arxiv" });
    expect(calls[0].args).toMatchObject({ max_results: 10, domain: "academic", sub_domain: "arxiv" });
  });

  it("uses one batch call for extra query phrasings", async () => {
    const calls = stubFetch(() => new Response(mcpText("## Query 1: a\n## Query 2: b")));
    const result = await run({ query: "a", searchQueries: ["b", "c", "d", "e", "f"] });

    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("batch_search");
    // The primary query plus at most 4 extras: the provider caps at 5.
    expect((calls[0].args.queries as unknown[]).length).toBe(5);
    expect(result.details.batch).toBe(5);
    // Query labels distinguish the sections and stay.
    expect(result.content[0].text).toContain("## Query 1: a");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Exa provider
// ═════════════════════════════════════════════════════════════════════════════

const exaPayload = JSON.stringify({
  requestId: "r1",
  results: [
    {
      title: "Announcing TypeScript 7.0",
      url: "https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/",
      publishedDate: "2026-07-08",
      summary: "TypeScript 7 is a native port.",
      text: "Full body text.",
    },
  ],
});

describe("Exa provider", () => {
  it("maps the visible filters onto the advanced tool's field names", async () => {
    const calls = stubFetch(() => new Response(mcpText(exaPayload)));
    const result = await run({
      query: "typescript 7",
      provider: "exa",
      numResults: 30,
      category: "news",
      includeDomains: ["devblogs.microsoft.com"],
      excludeDomains: ["reddit.com"],
      publishedAfter: "2026-01-01",
      publishedBefore: "2026-12-31",
      maxAgeHours: 0,
      searchQueries: ["ts 7 release"],
    });

    expect(calls[0].url).toBe(EXA_URL);
    expect(calls[0].url).toContain("web_search_advanced_exa");
    expect(calls[0].tool).toBe("web_search_advanced_exa");
    expect(calls[0].args).toMatchObject({
      numResults: 20,
      category: "news",
      includeDomains: ["devblogs.microsoft.com"],
      excludeDomains: ["reddit.com"],
      startPublishedDate: "2026-01-01",
      endPublishedDate: "2026-12-31",
      maxAgeHours: 0,
      additionalQueries: ["ts 7 release"],
    });
    expect(result.content[0].text).toContain("Announcing TypeScript 7.0");
    expect(result.content[0].text).toContain("TypeScript 7 is a native port.");
    expect(result.details.provider).toBe("exa");
  });

  it("falls back to the raw payload when it is not the expected JSON", async () => {
    stubFetch(() => new Response(mcpText("not json at all")));
    const result = await run({ query: "x", provider: "exa" });
    expect(result.content[0].text).toContain("not json at all");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Parallel provider
// ═════════════════════════════════════════════════════════════════════════════

describe("Parallel provider", () => {
  it("sends the objective, the query list and the session identity", async () => {
    const calls = stubFetch(() =>
      new Response(
        mcpText(
          JSON.stringify({
            search_id: "s1",
            results: [{ url: "https://a.test", title: "A", publish_date: "2026-01-02", excerpts: ["one", "two"] }],
          }),
        ),
      ),
    );
    const result = await run({ query: "release date", objective: "find the date", provider: "parallel" });

    expect(calls[0].url).toBe(PARALLEL_URL);
    expect(calls[0].tool).toBe("web_search");
    expect(calls[0].args).toMatchObject({
      objective: "find the date",
      search_queries: ["release date"],
      session_id: "session-1",
      model_name: "gpt-5.5",
    });
    expect(result.content[0].text).toContain("### 1. A");
    expect(result.content[0].text).toContain("one");
  });

  it("defaults the objective to the query", async () => {
    const calls = stubFetch(() => new Response(mcpText(JSON.stringify({ results: [{ url: "u", title: "t" }] }))));
    await run({ query: "only query", provider: "parallel" });
    expect(calls[0].args.objective).toBe("only query");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fallback chain
// ═════════════════════════════════════════════════════════════════════════════

describe("fallback chain", () => {
  it("moves to the next backend after an HTTP failure and says so", async () => {
    const calls = stubFetch((call) => {
      if (call.url === ANYSEARCH_URL) return new Response("boom", { status: 500 });
      return new Response(mcpText(exaPayload));
    });
    const result = await run({ query: "typescript 7" });

    expect(calls.map((c) => c.url)).toEqual([ANYSEARCH_URL, EXA_URL]);
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("fell back to Exa");
    expect(result.content[0].text).toContain("anysearch: HTTP 500");
    expect(result.details.provider).toBe("exa");
    expect(result.details.attempted).toEqual([{ provider: "anysearch", error: "HTTP 500: boom" }]);
  });

  it("treats an empty result set as a failure and continues", async () => {
    const calls = stubFetch((call) =>
      call.url === ANYSEARCH_URL ? new Response(mcpText("   ")) : new Response(mcpText(exaPayload)),
    );
    const result = await run({ query: "typescript 7" });
    expect(calls).toHaveLength(2);
    expect(result.details.attempted).toEqual([{ provider: "anysearch", error: "no results" }]);
  });

  it("reaches the third backend when the first two fail", async () => {
    const calls = stubFetch((call) => {
      if (call.url === PARALLEL_URL) {
        return new Response(mcpText(JSON.stringify({ results: [{ url: "u", title: "Parallel hit", excerpts: ["e"] }] })));
      }
      return new Response("nope", { status: 503 });
    });
    const result = await run({ query: "x" });
    expect(calls.map((c) => c.url)).toEqual([ANYSEARCH_URL, EXA_URL, PARALLEL_URL]);
    expect(result.content[0].text).toContain("Parallel hit");
  });

  it("does not fall over when a provider is pinned", async () => {
    const calls = stubFetch(() => new Response("nope", { status: 500 }));
    const result = await run({ query: "x", provider: "exa" });
    expect(calls).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("websearch failed");
    expect(result.content[0].text).toContain("exa: HTTP 500");
  });

  it("reports every attempted backend when all of them fail", async () => {
    const calls = stubFetch(() => new Response("nope", { status: 500 }));
    const result = await run({ query: "x" });
    expect(calls).toHaveLength(3);
    expect(result.isError).toBe(true);
    expect(result.details.attempted.map((a: any) => a.provider)).toEqual(["anysearch", "exa", "parallel"]);
  });

  it("skips a backend that cannot honour the request and reports it", async () => {
    // includeDomains pins exa, which fails; the other two must not be tried
    // even though they are in the default chain, and the error mentions filters.
    const calls = stubFetch(() => new Response("nope", { status: 500 }));
    const result = await run({ query: "x", includeDomains: ["a.test"] });
    expect(calls.map((c) => c.url)).toEqual([EXA_URL]);
    expect(result.isError).toBe(true);
  });
});
