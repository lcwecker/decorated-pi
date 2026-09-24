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
  if (host.includes(":")) {
    // IPv6 literals arrive as [::1] / [fd00::1] / [fe80::1] / [::ffff:7f00:1].
    if (host === "::1") return true;
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true; // fc00::/7 unique-local, fe80::/10 link-local
    // `::ffff:7f00:1`, `::7f00:1` and `64:ff9b::7f00:1` all name the host
    // `127.0.0.1`, so the IPv4 ranges decide those too.
    const embedded = embeddedIPv4(host);
    return embedded ? PRIVATE_V4.some((range) => range.test(embedded)) : false;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return PRIVATE_V4.some((range) => range.test(host));
  // A single label resolves through the local search domain, never publicly.
  return !host.includes(".");
}

/** Expand an IPv6 literal into its eight groups, filling `::` with zeros.
 *  Returns undefined when the input is not an IPv6 literal. */
function expandIPv6(host: string): string[] | undefined {
  const [headRaw, tailRaw, ...rest] = host.split("::");
  if (rest.length > 0) return undefined;
  const head = headRaw ? headRaw.split(":") : [];
  if (tailRaw === undefined) return head.length === 8 ? head : undefined;
  const tail = tailRaw ? tailRaw.split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return undefined;
  return [...head, ...Array<string>(missing).fill("0"), ...tail];
}

/** The IPv4 address an IPv6 literal embeds, as a dotted quad, when the prefix
 *  marks it as one: `::ffff:0:0/96` (IPv4-mapped), `::/96` (IPv4-compatible)
 *  and `64:ff9b::/96` (NAT64). Anything else returns undefined. */
function embeddedIPv4(host: string): string | undefined {
  const groups = expandIPv6(host);
  if (!groups) return undefined;
  const prefix = groups.slice(0, 6).join(":");
  const mapped = prefix === "0:0:0:0:0:ffff";
  const compatible = prefix === "0:0:0:0:0:0";
  const nat64 = groups[0] === "64" && groups[1] === "ff9b" && groups.slice(2, 6).every((g) => g === "0");
  if (!mapped && !compatible && !nat64) return undefined;
  const low = (Number.parseInt(groups[6], 16) << 16) | Number.parseInt(groups[7], 16);
  return `${(low >>> 24) & 255}.${(low >>> 16) & 255}.${(low >>> 8) & 255}.${low & 255}`;
}

/** Accept only absolute http(s) URLs, without userinfo. */
export function parseTarget(raw: string): { url: URL } | { reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: `not a valid absolute URL: ${redactUrl(raw)}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { reason: `unsupported scheme "${url.protocol}" — use http:// or https://` };
  }
  if (url.username || url.password) {
    return { reason: "URLs carrying credentials are not supported" };
  }
  return { url };
}

/** Drop any userinfo from a URL before it appears in a message. Node's fetch
 *  refuses a Request built from a URL that carries credentials, and a password
 *  in an error text is still a leaked password. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.username && !url.password) return raw;
    return `${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return raw.replace(/\/\/[^/@]*@/, "//");
  }
}
