/**
 * Local HTTP fetch for tools/webfetch.
 *
 * This is the only path that reaches hosts a third-party crawler cannot:
 * localhost, intranet, anything behind the caller's own network. It also keeps
 * the URL private. What it cannot do is execute JavaScript, so bot-challenge
 * interstitials, JS shells and Cloudflare fingerprints are reported as
 * failures rather than returned as "content" — the caller then falls over to a
 * rendering backend.
 */

import { readCappedBytes } from "../../utils/http-body.js";
import { describeNetworkError } from "../../utils/net.js";
import { htmlToMarkdown, htmlToText, isHtmlContentType } from "./convert.js";
import { isPrivateHost } from "./target.js";

export type FetchFormat = "markdown" | "text" | "html";

export interface LocalFetchOutcome {
  ok: boolean;
  text?: string;
  /** Binary image payload, ready to be handed to a vision-capable model. */
  image?: { data: string; mimeType: string };
  mime?: string;
  bytes?: number;
  /** Why the fetch is not usable. Present when ok is false. */
  reason?: string;
}

export const MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;

/** Below this, a text/markdown body from a scripted HTML page is a shell, not content. */
const MIN_READABLE_CHARS = 50;
/** Text-to-markup density of a client-rendered page. Measured against real
 *  pages: documentation and articles land at 0.26–0.45, an app-heavy GitHub
 *  page at 0.06, and a login- wall shell at 0.03. Only large documents are
 *  judged this way, so a short static page is never second-guessed. */
const SHELL_MIN_HTML_CHARS = 100_000;
const SHELL_MAX_TEXT_RATIO = 0.03;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
/** Second attempt after a bot challenge. Its TLS fingerprint does not match a
 *  real browser either, so it only clears challenges that key on the UA string. */
const HONEST_UA = "decorated-pi";

const CHALLENGE_MARKERS = /just a moment|attention required|verifying your browser|enable javascript|checking your browser/i;
const CHALLENGE_HEADERS = ["cf-mitigated", "x-datadome", "x-px-block"];

function acceptFor(format: FetchFormat): string {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    default:
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  }
}

function headersFor(format: FetchFormat, userAgent: string): Record<string, string> {
  return {
    "user-agent": userAgent,
    accept: acceptFor(format),
    "accept-language": "en-US,en;q=0.9",
  };
}

function clampTimeout(timeoutSeconds: number | undefined): number {
  if (!timeoutSeconds) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(timeoutSeconds * 1000, 1000), MAX_TIMEOUT_MS);
}

function looksLikeChallenge(response: Response): boolean {
  if (response.headers.get("cf-mitigated") === "challenge") return true;
  return CHALLENGE_HEADERS.some((h) => response.headers.has(h));
}

function convert(html: string, format: FetchFormat): string {
  if (format === "html") return html;
  if (format === "text") return htmlToText(html);
  return htmlToMarkdown(html);
}

/**
 * Fetch a URL directly. Never throws for a fetch-level failure: the outcome
 * carries a `reason` string so the caller can decide whether to fall over.
 */
export async function fetchLocal(
  url: string,
  options: { format: FetchFormat; timeoutSeconds?: number; signal?: AbortSignal },
): Promise<LocalFetchOutcome> {
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, reason: "URL must start with http:// or https://" };
  }

  const timeoutMs = clampTimeout(options.timeoutSeconds);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const { format } = options;

  const request = (userAgent: string) =>
    fetch(url, { headers: headersFor(format, userAgent), redirect: "follow", signal });

  let privateHost = false;
  try {
    privateHost = isPrivateHost(new URL(url).hostname);
  } catch {
    /* unreachable: the scheme check above rejects what URL cannot parse */
  }

  let response: Response;
  try {
    response = await request(BROWSER_UA);
    if (looksLikeChallenge(response)) {
      await response.body?.cancel().catch(() => {});
      response = await request(HONEST_UA);
    }
  } catch (err) {
    if (options.signal?.aborted) throw err;
    return {
      ok: false,
      reason: `local fetch failed: ${describeNetworkError(err, timeoutMs, { proxyHint: !privateHost })}`,
    };
  }

  if (!response.ok) {
    return { ok: false, reason: `HTTP ${response.status}${response.status === 403 ? " (blocked)" : ""}` };
  }

  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isSafeInteger(declared) && declared > MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, reason: `response larger than ${MAX_BYTES} bytes` };
  }

  const contentType = response.headers.get("content-type") ?? "";
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

  let raw: Buffer;
  try {
    raw = await readCappedBytes(response, MAX_BYTES);
  } catch (err) {
    if (options.signal?.aborted) throw err;
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (mime.startsWith("image/")) {
    return {
      ok: true,
      image: { data: raw.toString("base64"), mimeType: mime },
      mime,
      bytes: raw.byteLength,
    };
  }

  const text = raw.toString("utf-8");
  if (!isHtmlContentType(contentType)) {
    return { ok: true, text, mime: mime || "text/plain", bytes: raw.byteLength };
  }

  if (CHALLENGE_MARKERS.test(text.slice(0, 4000))) {
    return { ok: false, reason: "blocked by bot protection" };
  }

  const converted = convert(text, format);
  // Two shell shapes: almost no text from a scripted page, or a large document
  // whose markup carries the words instead of the body.
  if (format !== "html") {
    const bareScripted = converted.length < MIN_READABLE_CHARS && /<script/i.test(text);
    const lowDensity = text.length > SHELL_MIN_HTML_CHARS && converted.length / text.length < SHELL_MAX_TEXT_RATIO;
    if (bareScripted || lowDensity) {
      return { ok: false, reason: "no readable text (page is likely rendered by JavaScript)" };
    }
  }
  return { ok: true, text: converted, mime: mime || "text/html", bytes: raw.byteLength };
}
