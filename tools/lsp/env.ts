/**
 * LSP Child Process Environment — whitelist-only for maximum security.
 *
 * LSP servers communicate over stdio, not HTTP. They only need a minimal
 * set of environment variables to locate binaries, read user config, and
 * respect locale settings.
 *
 * Proxy variables are explicitly excluded — LSP over stdio has no use for
 * them, and passing them through could cause hangs if the server tries
 * to make outbound HTTP requests.
 */

const WHITELIST = new Set([
  // Core — needed to find binaries and user config
  "PATH", "HOME", "USER", "SHELL",
  // Terminal compatibility
  "TERM", "COLORTERM",
  // Locale
  "LANG",
  // Pi-specific
  "PI_CODING_AGENT_DIR",
  // Node.js
  "NODE_PATH", "NODE_OPTIONS",
]);

/**
 * Build a safe environment for spawning an LSP server child process.
 *
 * Strategy: whitelist. Only variables explicitly listed are passed through.
 * Proxy, API keys, tokens, and all other env vars are silently stripped.
 */
export function createChildProcessEnv(
  extras: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (WHITELIST.has(key)) env[key] = value;
    // Also pass through LC_* variables (locale category vars)
    if (key.startsWith("LC_")) env[key] = value;
  }

  // Explicit overrides always win
  for (const [key, value] of Object.entries(extras)) {
    if (typeof value === "string") env[key] = value;
  }

  return env;
}
