/**
 * Target classification for tools/webfetch.
 *
 * Two decisions depend on the target, and both are about what must not leave
 * the machine:
 *
 * - A non-HTTP URL is rejected before anything runs. `file:///etc/passwd` has
 *   no business being handed to a third-party rendering backend.
 * - Private and local hosts never reach the rendering backends. The local
 *   fetch exists precisely so intranet names and `localhost` can be read
 *   without publishing them to a crawler.
 */

/** IPv4 ranges that are not publicly routable. */
const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^198\.1[89]\./,
];

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  // IPv6 literals arrive as [::1] / [fd00::1] / [fe80::1].
  if (host.includes(":")) {
    if (host === "::1") return true;
    return /^f[cd]/.test(host) || /^fe[89ab]/.test(host); // fc00::/7 unique-local, fe80::/10 link-local
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return PRIVATE_V4.some((range) => range.test(host));
  // A single label resolves through the local search domain, never publicly.
  return !host.includes(".");
}

/** Accept only absolute http(s) URLs. */
export function parseTarget(raw: string): { url: URL } | { reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: `not a valid absolute URL: ${raw}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { reason: `unsupported scheme "${url.protocol}" — use http:// or https://` };
  }
  return { url };
}
