/**
 * webfetch — read a URL the caller already has.
 *
 * Chain: local HTTP → AnySearch extract → Jina reader. The local path runs
 * first because it is private, unlimited and reaches hosts no crawler can
 * (localhost, intranet). It fails on bot challenges, JS shells and pages that
 * only exist after client-side rendering; the two rendering backends cover
 * exactly those cases, and only in that order.
 *
 * `allowRemote: false` keeps a URL from leaving the machine, which matters for
 * internal hosts and signed URLs.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderToolTextResult } from "../../utils/tool-output.js";
import { MAX_TIMEOUT_MS, fetchLocal, type FetchFormat } from "./local.js";
import { fetchViaAnySearch, fetchViaJina } from "./remote.js";
import { isPrivateHost, parseTarget, redactUrl } from "./target.js";

/** Model-facing cap: a fetched page is a reference, not the whole context window. */
const MAX_OUTPUT_CHARS = 30_000;
const REMOTE_TIMEOUT_MS = 30_000;

const webFetchParams = Type.Object({
  url: Type.String({ description: "The URL to read. Must start with http:// or https://." }),
  format: Type.Optional(
    Type.Union([Type.Literal("markdown"), Type.Literal("text"), Type.Literal("html")], {
      description:
        "markdown (default) keeps structure, links and code fences; text drops all markup and costs the fewest tokens; html returns the raw source.",
    }),
  ),
  timeout: Type.Optional(
    Type.Number({ description: `Timeout in seconds (default: 30, max: ${MAX_TIMEOUT_MS / 1000}).` }),
  ),
  allowRemote: Type.Optional(
    Type.Boolean({
      description:
        "Default true. When the local fetch fails, retry through AnySearch extract, then Jina reader. Private and local hosts skip those backends regardless. Set false to keep every URL on this machine.",
    }),
  ),
});

function capOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n[Truncated: kept the first ${MAX_OUTPUT_CHARS} of ${text.length} characters]`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function attemptNote(attempted: Array<{ source: string; error?: string }>, winner: string): string {
  if (attempted.length === 0) return "";
  const skipped = attempted.map((a) => `${a.source}: ${a.error}`).join("; ");
  return `(local fetch unusable — ${skipped}; content via ${winner})\n\n`;
}

export function registerWebFetchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "webfetch",
    label: "Web fetch",
    description:
      "Read the content of a URL as markdown, text or raw HTML. Fetches directly from this machine first, so localhost and internal hosts work; when a page blocks plain HTTP or renders client-side, it retries through a rendering backend. Private and local hosts skip those backends, so an intranet URL is never published. Returns the page body, or an image attachment for image URLs. Use websearch to discover URLs and webfetch to read them.",
    promptSnippet: "Fetch a URL and return its content as markdown, text or HTML",
    promptGuidelines: [
      "Prefer webfetch over bash curl for reading pages: it negotiates the right Accept header, converts HTML to markdown, and falls over to a rendering backend when the page blocks plain HTTP.",
      "Use format text when only the prose matters and context is tight; markdown keeps links and code fences.",
    ],
    parameters: webFetchParams,
    renderResult: renderToolTextResult,
    execute: async (_id, params, signal, _update, ctx: ExtensionContext) => {
      const format: FetchFormat = params.format ?? "markdown";
      const attempted: Array<{ source: string; error?: string }> = [];
      const remoteTimeoutMs = params.timeout
        ? Math.min(params.timeout * 1000, MAX_TIMEOUT_MS)
        : REMOTE_TIMEOUT_MS;

      // Classify before doing anything: a non-HTTP URL is rejected outright,
      // and an internal host never reaches a rendering backend.
      const target = parseTarget(params.url);
      if ("reason" in target) {
        return {
          content: [{ type: "text", text: `webfetch refused ${redactUrl(params.url)} — ${target.reason}` }],
          isError: true,
          details: { attempted },
        };
      }
      const internal = isPrivateHost(target.url.hostname);

      const local = await fetchLocal(params.url, {
        format,
        timeoutSeconds: params.timeout,
        signal,
      });

      if (local.ok) {
        const details = { source: "local", mime: local.mime, bytes: local.bytes, format };
        if (local.image) {
          const note = `Fetched image (${local.image.mimeType}).`;
          const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
            { type: "text", text: note },
          ];
          if (ctx.model?.input?.includes("image")) {
            content.push({ type: "image", data: local.image.data, mimeType: local.image.mimeType });
          } else {
            content[0] = { type: "text", text: `${note} The active model has no image input, so it was not attached.` };
          }
          return { content, isError: false, details };
        }
        return {
          content: [{ type: "text", text: capOutput(local.text ?? "") }],
          isError: false,
          details,
        };
      }

      attempted.push({ source: "local", error: local.reason });

      // The rendering backends see the URL, so an internal host is excluded
      // even when the caller left remote fetching enabled.
      const remoteAllowed = params.allowRemote !== false && !internal;
      if (params.allowRemote !== false && internal) {
        attempted.push({ source: "remote fallbacks", error: "skipped: private or local host" });
      }

      if (remoteAllowed) {
        const backends: Array<{ source: string; run: () => Promise<string> }> = [
          { source: "anysearch extract", run: () => fetchViaAnySearch(params.url, { signal, timeoutMs: remoteTimeoutMs }) },
          { source: "jina reader", run: () => fetchViaJina(params.url, { signal, timeoutMs: remoteTimeoutMs }) },
        ];
        for (const backend of backends) {
          try {
            const text = await backend.run();
            return {
              content: [
                { type: "text", text: capOutput(attemptNote(attempted, backend.source) + text.trim()) },
              ],
              isError: false,
              details: { source: backend.source, format, attempted },
            };
          } catch (err) {
            if (signal?.aborted) throw err;
            attempted.push({ source: backend.source, error: errorText(err) });
          }
        }
      }

      const reasons = attempted.map((a) => `${a.source}: ${a.error}`).join("; ");
      return {
        content: [{ type: "text", text: `webfetch failed for ${redactUrl(params.url)} — ${reasons}` }],
        isError: true,
        details: { attempted },
      };
    },
  });
}
