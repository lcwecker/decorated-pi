/**
 * Turn a fetch failure into a message a model or a user can act on.
 *
 * Node's fetch reports everything as "fetch failed"; the useful part is in
 * `cause` (ETIMEDOUT, ECONNREFUSED, ENOTFOUND, a TLS error). One environment
 * deserves a dedicated hint: with `HTTPS_PROXY`/`http_proxy` set, curl works
 * while Node connects directly and times out, because Node's fetch ignores
 * proxy environment variables unless the process opts in.
 */

const PROXY_ENV = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];

export function proxyHint(): string | undefined {
  const set = PROXY_ENV.find((name) => process.env[name]);
  if (!set) return undefined;
  if (process.env.NODE_USE_ENV_PROXY) return undefined;
  return `${set} is set, but Node's fetch ignores proxy environment variables. Use Node 24+ with NODE_USE_ENV_PROXY=1, or reach the host directly.`;
}

export function describeNetworkError(
  err: unknown,
  timeoutMs: number,
  options: { proxyHint?: boolean } = {},
): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return `timed out after ${timeoutMs}ms`;
  }
  const message = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? cause?.message;
  const detail = code && !message.includes(code) ? `${message} (${code})` : message;
  // A proxy only explains a failure to reach a public host; for an internal
  // one the advice is noise, and its absence would be the real surprise.
  const hint = options.proxyHint === false ? undefined : proxyHint();
  return hint ? `${detail} — ${hint}` : detail;
}
