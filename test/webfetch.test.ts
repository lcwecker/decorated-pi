/**
 * webfetch — local fetch first, rendering backends on failure.
 *
 * Covers HTML conversion, image handling, the failure classes that trigger the
 * fallback (bot challenge, JS shell, HTTP error), the order of the chain, and
 * `allowRemote: false`. `fetch` is stubbed, so the suite stays offline.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { htmlToMarkdown, htmlToText, isHtmlContentType } from "../tools/webfetch/convert.js";
import { fetchLocal } from "../tools/webfetch/local.js";
import { registerWebFetchTool } from "../tools/webfetch/index.js";
import { isPrivateHost, parseTarget, redactUrl } from "../tools/webfetch/target.js";
import { ANYSEARCH_URL } from "../tools/websearch/anysearch.js";
import { JINA_READER_PREFIX } from "../tools/webfetch/remote.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface RecordedRequest {
  url: string;
  method?: string;
  mcpTool?: string;
}

/** Route stubbed requests by URL prefix; anything unrouted fails loudly. */
function stubRoutes(routes: Record<string, () => Response>): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    const href = String(url);
    let mcpTool: string | undefined;
    if (init.body) {
      try {
        mcpTool = JSON.parse(init.body)?.params?.name;
      } catch {
        /* not JSON-RPC */
      }
    }
    requests.push({ url: href, method: init.method, mcpTool });
    for (const [prefix, handler] of Object.entries(routes)) {
      if (href.startsWith(prefix)) return handler();
    }
    throw new Error(`no stub route for ${href}`);
  });
  return requests;
}

function mcpText(text: string): Response {
  return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", result: { content: [{ type: "text", text }] } })}\n`);
}

function page(body: string, contentType = "text/html; charset=utf-8", status = 200): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

function captureTool(): any {
  let tool: any;
  registerWebFetchTool({ registerTool: (t: any) => { tool = t; } } as any);
  return tool;
}

function run(params: Record<string, unknown>, ctx: any = ctxVision) {
  return captureTool().execute("call-1", params, undefined, undefined, ctx);
}

const ctxVision = { model: { id: "m", input: ["text", "image"] } } as any;
const ctxBlind = { model: { id: "m", input: ["text"] } } as any;

const LONG_HTML =
  "<html><head><title>Doc</title><style>body{color:red}</style></head><body>" +
  "<h1>Heading</h1><p>First paragraph with <a href=\"https://a.test\">a link</a> and enough words to be readable.</p>" +
  "<script>alert('x')</script></body></html>";

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ═════════════════════════════════════════════════════════════════════════════
// Conversion
// ═════════════════════════════════════════════════════════════════════════════

describe("HTML conversion", () => {
  it("converts to markdown keeping structure and dropping script/style", () => {
    const markdown = htmlToMarkdown(LONG_HTML);
    expect(markdown).toContain("# Heading");
    expect(markdown).toContain("[a link](https://a.test)");
    expect(markdown).not.toContain("alert");
    expect(markdown).not.toContain("color:red");
  });

  it("extracts text, skipping script and style", () => {
    const text = htmlToText(LONG_HTML);
    expect(text).toContain("Heading");
    expect(text).toContain("First paragraph");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
    expect(text.split("\n").length).toBeGreaterThan(1);
  });

  it("recognises HTML content types", () => {
    expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true);
    expect(isHtmlContentType("application/xhtml+xml")).toBe(true);
    expect(isHtmlContentType("application/json")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Target classification
// ═════════════════════════════════════════════════════════════════════════════

describe("target classification", () => {
  it("treats every non-routable address form as private", () => {
    const privateHosts = [
      // IPv4 ranges
      "127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "198.18.0.1",
      // IPv6 specials
      "[::1]", "[fd00::1]", "[fe80::1]",
      // IPv4 embedded in IPv6: mapped, compatible and NAT64
      "[::ffff:7f00:1]", "[::ffff:c0a8:101]", "[::ffff:a00:1]", "[::ffff:a9fe:a9fe]",
      "[::7f00:1]", "[64:ff9b::a00:1]",
      // Names that never resolve publicly
      "localhost", "api.local", "host.internal", "printer",
    ];
    for (const host of privateHosts) expect(isPrivateHost(host), host).toBe(true);
  });

  it("leaves public addresses public", () => {
    for (const host of ["example.com", "8.8.8.8", "[2606:4700::1111]", "[::ffff:8.8.8.8]"]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });

  it("accepts only an absolute http(s) URL", () => {
    expect(parseTarget("file:///etc/passwd")).toHaveProperty("reason");
    expect(parseTarget("not a url")).toHaveProperty("reason");
    expect(parseTarget("https://user:pass@example.com/")).toHaveProperty("reason");
    expect(parseTarget("https://example.com/a")).toHaveProperty("url");
  });

  it("redacts credentials before a URL reaches a message", () => {
    expect(redactUrl("https://user:pass@a.test/x?y=1#z")).toBe("https://a.test/x?y=1#z");
    expect(redactUrl("https://a.test/x")).toBe("https://a.test/x");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Local fetch
// ═════════════════════════════════════════════════════════════════════════════

describe("local fetch", () => {
  it("rejects a URL without an http scheme", async () => {
    const result = await fetchLocal("file:///etc/passwd", { format: "markdown" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("http://");
  });

  it("passes a non-HTML body through untouched", async () => {
    stubRoutes({ "https://a.test/": () => page('{"a":1}', "application/json") });
    const result = await fetchLocal("https://a.test/", { format: "markdown" });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('{"a":1}');
    expect(result.mime).toBe("application/json");
  });

  it("reports a JS shell instead of returning an empty body", async () => {
    stubRoutes({
      "https://a.test/": () =>
        page('<html><body><div id="root"></div><script src="/main.js"></script></body></html>'),
    });
    const result = await fetchLocal("https://a.test/", { format: "markdown" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("JavaScript");
  });

  it("returns a short static page rather than calling it a shell", async () => {
    stubRoutes({ "https://a.test/": () => page("<html><body><p>Short but real.</p></body></html>") });
    const result = await fetchLocal("https://a.test/", { format: "markdown" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Short but real.");
  });

  it("reports a large, low-density document as a shell", async () => {
    // 100KB of markup carrying a couple of navigation labels: the words live
    // in the bundle, not in the document. This is what a rendered app and a
    // login wall look like — an X/Twitter profile page measures 0.03.
    const html = `<html><body><head></head>${'<div class="row"></div>'.repeat(5500)}<p>${"nav ".repeat(40)}</p></body></html>`;
    expect(html.length).toBeGreaterThan(100_000);
    stubRoutes({ "https://a.test/": () => page(html) });
    const result = await fetchLocal("https://a.test/", { format: "markdown" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("JavaScript");
  });

  it("keeps a large document that carries real prose", async () => {
    const html = `<html><body><p>${"word ".repeat(30_000)}</p></body></html>`;
    expect(html.length).toBeGreaterThan(100_000);
    stubRoutes({ "https://a.test/": () => page(html) });
    const result = await fetchLocal("https://a.test/", { format: "markdown" });
    expect(result.ok).toBe(true);
    expect(result.text!.length).toBeGreaterThan(500);
  });

  it("reports a bot challenge served with status 200", async () => {
    stubRoutes({
      "https://a.test/": () => page("<html><head><title>Just a moment...</title></head><body>verifying</body></html>"),
    });
    const result = await fetchLocal("https://a.test/", { format: "markdown" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("bot protection");
  });

  it("reports a 403", async () => {
    stubRoutes({ "https://a.test/": () => page("nope", "text/html", 403) });
    const result = await fetchLocal("https://a.test/", { format: "markdown" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("403");
  });

  it("mentions a proxy variable for a public host that cannot be reached", async () => {
    const previous = process.env.https_proxy;
    process.env.https_proxy = "http://127.0.0.1:20000";
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed", { cause: { code: "ETIMEDOUT" } });
    });
    const result = await fetchLocal("https://public.test/", { format: "markdown" });

    expect(result.reason).toContain("ETIMEDOUT");
    expect(result.reason).toContain("NODE_USE_ENV_PROXY");
    if (previous === undefined) delete process.env.https_proxy;
    else process.env.https_proxy = previous;
  });

  it("does not blame a proxy for a failed internal host", async () => {
    const previous = process.env.https_proxy;
    process.env.https_proxy = "http://127.0.0.1:20000";
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    });
    const result = await fetchLocal("http://127.0.0.1:45999/", { format: "markdown" });

    expect(result.reason).toContain("ECONNREFUSED");
    expect(result.reason).not.toContain("https_proxy");
    if (previous === undefined) delete process.env.https_proxy;
    else process.env.https_proxy = previous;
  });

  it("returns an image payload instead of text", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    stubRoutes({
      "https://a.test/i.png": () => new Response(bytes, { headers: { "content-type": "image/png" } }),
    });
    const result = await fetchLocal("https://a.test/i.png", { format: "markdown" });
    expect(result.ok).toBe(true);
    expect(result.image?.mimeType).toBe("image/png");
    expect(Buffer.from(result.image!.data, "base64")).toEqual(bytes);
  });

  it("retries with an honest UA when a bot protection header is present", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: any = {}) => {
      seen.push(init.headers["user-agent"]);
      if (seen.length === 1) {
        return new Response("<html><body>challenge</body></html>", {
          status: 403,
          headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
        });
      }
      return page(LONG_HTML);
    });

    const result = await fetchLocal("https://a.test/", { format: "markdown" });
    expect(seen).toHaveLength(2);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("# Heading");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Tool: local path
// ═════════════════════════════════════════════════════════════════════════════

describe("webfetch tool — local path", () => {
  it("returns markdown by default and never touches a backend", async () => {
    const requests = stubRoutes({ "https://a.test/": () => page(LONG_HTML) });
    const result = await run({ url: "https://a.test/" });

    expect(requests).toHaveLength(1);
    expect(result.isError).toBe(false);
    expect(result.details.source).toBe("local");
    expect(result.content[0].text).toContain("# Heading");
  });

  it("honours format: text and format: html", async () => {
    stubRoutes({ "https://a.test/": () => page(LONG_HTML) });
    const text = await run({ url: "https://a.test/", format: "text" });
    expect(text.content[0].text).toContain("First paragraph");
    expect(text.content[0].text).not.toContain("[a link]");

    const html = await run({ url: "https://a.test/", format: "html" });
    expect(html.content[0].text).toContain("<h1>Heading</h1>");
  });

  it("attaches an image when the model accepts images", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    stubRoutes({
      "https://a.test/i.png": () => new Response(bytes, { headers: { "content-type": "image/png" } }),
    });
    const result = await run({ url: "https://a.test/i.png" });
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("says so when the model cannot take images", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    stubRoutes({
      "https://a.test/i.png": () => new Response(bytes, { headers: { "content-type": "image/png" } }),
    });
    const result = await run({ url: "https://a.test/i.png" }, ctxBlind);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("no image input");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Tool: fallback chain
// ═════════════════════════════════════════════════════════════════════════════

describe("webfetch tool — fallback chain", () => {
  it("falls over to AnySearch extract after a local block", async () => {
    const requests = stubRoutes({
      "https://a.test/": () => page("nope", "text/html", 403),
      [ANYSEARCH_URL]: () => mcpText(JSON.stringify({ title: "Doc", url: "https://a.test/", content: "Body via AnySearch" })),
    });
    const result = await run({ url: "https://a.test/" });

    expect(requests.map((r) => r.url)).toEqual(["https://a.test/", ANYSEARCH_URL]);
    expect(requests[1].mcpTool).toBe("extract");
    expect(result.isError).toBe(false);
    expect(result.details.source).toBe("anysearch extract");
    expect(result.content[0].text).toContain("# Doc");
    expect(result.content[0].text).toContain("Body via AnySearch");
    expect(result.content[0].text).toContain("local: HTTP 403 (blocked)");
  });

  it("falls over to Jina reader when AnySearch also fails", async () => {
    const requests = stubRoutes({
      "https://a.test/": () => page("nope", "text/html", 403),
      [ANYSEARCH_URL]: () => new Response("down", { status: 503 }),
      [JINA_READER_PREFIX]: () => new Response("Title: Doc\n\nMarkdown Content:\nbody from reader"),
    });
    const result = await run({ url: "https://a.test/" });

    expect(requests.map((r) => r.url)).toEqual([
      "https://a.test/",
      ANYSEARCH_URL,
      `${JINA_READER_PREFIX}https://a.test/`,
    ]);
    expect(result.details.source).toBe("jina reader");
    expect(result.content[0].text).toContain("body from reader");
    expect(result.content[0].text).toContain("anysearch extract: HTTP 503");
  });

  it("treats AnySearch's extract_failed reply as a failure", async () => {
    // The extraction endpoint answers 200 with this body when it cannot read a
    // page. Returning it as content would look like a successful fetch.
    stubRoutes({
      "https://a.test/": () => page("nope", "text/html", 403),
      [ANYSEARCH_URL]: () => mcpText("extract_failed\nUnable to extract content from the URL."),
      [JINA_READER_PREFIX]: () => new Response("body from reader"),
    });
    const result = await run({ url: "https://a.test/" });

    expect(result.details.source).toBe("jina reader");
    expect(result.content[0].text).toContain("anysearch extract failed");
  });

  it("treats a reader that reports a target error as a failure", async () => {
    // The reader returns 200 with a warning when the target refused it.
    stubRoutes({
      "https://a.test/": () => page("nope", "text/html", 403),
      [ANYSEARCH_URL]: () => new Response("down", { status: 503 }),
      [JINA_READER_PREFIX]: () =>
        new Response("Title: Just a moment...\nWarning: Target URL returned error 403: Forbidden\n"),
    });
    const result = await run({ url: "https://a.test/" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("target refused the reader (Target URL returned error 403: Forbidden)");
  });

  it("keeps the URL local when allowRemote is false", async () => {
    const requests = stubRoutes({ "https://a.test/": () => page("nope", "text/html", 403) });
    const result = await run({ url: "https://a.test/", allowRemote: false });

    expect(requests).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("webfetch failed");
    expect(result.content[0].text).toContain("local: HTTP 403 (blocked)");
  });

  it("refuses a non-HTTP URL without touching the network", async () => {
    const requests = stubRoutes({});
    const result = await run({ url: "file:///etc/passwd" });

    expect(requests).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unsupported scheme");
  });

  it("never sends an internal host to a rendering backend", async () => {
    // The local fetch is the only path for these, so a failure must not fall
    // through to a third party.
    const requests = stubRoutes({ "http://127.0.0.1:9/": () => page("nope", "text/html", 502) });
    const result = await run({ url: "http://127.0.0.1:9/" });

    expect(requests.map((r) => r.url)).toEqual(["http://127.0.0.1:9/"]);
    expect(result.isError).toBe(true);
    expect(result.details.attempted).toEqual([
      { source: "local", error: "HTTP 502" },
      { source: "remote fallbacks", error: "skipped: private or local host" },
    ]);
    expect(result.content[0].text).toContain("private or local host");
  });

  it("refuses a URL carrying credentials without echoing the password", async () => {
    // Node's fetch refuses a Request built from a credentialed URL anyway, and
    // a password in the tool output (or in details) is a leaked password.
    const requests = stubRoutes({});
    const result = await run({ url: "https://user:pass@a.test/" });

    expect(requests).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("credentials");
    expect(result.content[0].text).not.toContain("pass");
    expect(JSON.stringify(result.details)).not.toContain("pass");
  });

  it("reports every attempt when the whole chain fails", async () => {
    stubRoutes({
      "https://a.test/": () => page("nope", "text/html", 403),
      [ANYSEARCH_URL]: () => new Response("down", { status: 503 }),
      [JINA_READER_PREFIX]: () => new Response("down", { status: 429 }),
    });
    const result = await run({ url: "https://a.test/" });

    expect(result.isError).toBe(true);
    expect(result.details.attempted.map((a: any) => a.source)).toEqual([
      "local",
      "anysearch extract",
      "jina reader",
    ]);
    expect(result.content[0].text).toContain("jina reader: HTTP 429");
  });
});
