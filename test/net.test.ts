/**
 * Network error descriptions.
 *
 * Node's fetch collapses every socket failure into "fetch failed", so the
 * useful signal has to be pulled out of `cause`. The proxy hint exists because
 * a machine with HTTP(S)_PROXY set sees curl succeed while Node times out.
 */

import { describe, it, expect, afterEach } from "vitest";
import { describeNetworkError, proxyHint } from "../utils/net.js";

const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NODE_USE_ENV_PROXY"];

function clearProxyEnv() {
  for (const name of PROXY_VARS) delete process.env[name];
}

afterEach(() => {
  clearProxyEnv();
});

describe("describeNetworkError", () => {
  it("reports a timeout without leaking the error name", () => {
    const err = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    expect(describeNetworkError(err, 25_000)).toBe("timed out after 25000ms");
  });

  it("includes the socket error code from the cause", () => {
    const err = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    expect(describeNetworkError(err, 1000)).toContain("fetch failed (ECONNREFUSED)");
  });

  it("does not repeat a code that is already in the message", () => {
    const err = new TypeError("connect ECONNREFUSED", { cause: { code: "ECONNREFUSED" } });
    expect(describeNetworkError(err, 1000)).toBe("connect ECONNREFUSED");
  });

  it("appends the proxy hint when a proxy variable is set", () => {
    clearProxyEnv();
    process.env.https_proxy = "http://127.0.0.1:20000";
    expect(proxyHint()).toContain("https_proxy is set");
    const err = new TypeError("fetch failed", { cause: { code: "ETIMEDOUT" } });
    expect(describeNetworkError(err, 1000)).toContain("NODE_USE_ENV_PROXY=1");
  });

  it("drops the proxy hint when the caller says it does not apply", () => {
    clearProxyEnv();
    process.env.https_proxy = "http://127.0.0.1:20000";
    const err = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    const described = describeNetworkError(err, 1000, { proxyHint: false });
    expect(described).toContain("ECONNREFUSED");
    expect(described).not.toContain("https_proxy");
  });

  it("stays quiet without a proxy variable, and once the process opts in", () => {
    clearProxyEnv();
    expect(proxyHint()).toBeUndefined();

    process.env.HTTPS_PROXY = "http://127.0.0.1:20000";
    process.env.NODE_USE_ENV_PROXY = "1";
    expect(proxyHint()).toBeUndefined();
  });
});
