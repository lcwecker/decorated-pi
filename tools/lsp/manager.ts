/**
 * LSP Server Manager — lifecycle, per-language instances, project-local binaries.
 */
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { LspClient, LspClientStartError } from "./client.js";
import { filePathToUri } from "./uri.js";
import { createChildProcessEnv } from "./env.js";
import {
  detectLanguage,
  findWorkspaceRoot,
  getServerConfig,
  languageIdForFile,
} from "./servers.js";

interface FileState {
  client: LspClient;
  language: string;
  workspaceRoot: string;
  rootUri: string;
  command: string;
  installHint: string;
}

interface ResolvedState {
  abs: string;
  uri: string;
  state: FileState;
}

interface Startup {
  cancelled: boolean;
  promise: Promise<FileState | undefined>;
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, file: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException("This operation was aborted", "AbortError");
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(new LspToolError({ kind: "tool_timeout", file, message: `LSP request timed out after ${timeoutMs}ms` }));
    }, timeoutMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException("This operation was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Abort-only race for paths with no user timeout configured. */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new DOMException("This operation was aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("This operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

export interface LspManagerOptions {
  cwd?: () => string;
}

export interface ResolveFileStateOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Manages LSP server instances per (language, workspace_root).
 *
 * - Deduplicates: one client per language+workspace
 * - Deduplicates startup: concurrent requests share the same startup promise
 * - Caches failures to avoid repeated start attempts
 */
export class LspServerManager {
  cwd: string;
  #clients = new Map<string, FileState>();
  #failures = new Map<string, any>();
  #starting = new Map<string, Startup>();

  constructor(options: LspManagerOptions = {}) {
    this.cwd = options.cwd?.() ?? process.cwd();
  }

  resolveAbs(file: string): string {
    return file.startsWith("/") ? file : resolvePath(this.cwd, file);
  }

  async clearLanguageState(language?: string): Promise<void> {
    const toStop = language
      ? [...this.#clients.values()].filter((s) => s.language === language)
      : [...this.#clients.values()];

    for (const [, startup] of this.#starting) {
      startup.cancelled = true;
    }
    this.#starting.clear();

    await Promise.allSettled(toStop.map((s) => s.client.stop()));
    for (const [key, state] of this.#clients) {
      if (!language || state.language === language) this.#clients.delete(key);
    }
    if (!language) {
      this.#failures.clear();
    } else {
      for (const [key, f] of this.#failures) {
        if (f.language === language) this.#failures.delete(key);
      }
    }
  }

  async resolveFileState(
    file: string,
    options: ResolveFileStateOptions = {},
  ): Promise<{ ok: true; result: ResolvedState } | { ok: false; error: any }> {
    const abs = this.resolveAbs(file);
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new DOMException("This operation was aborted", "AbortError");
    }
    try {
      const work = async () => {
        const state = await this.#getFileState(abs, options);
        if (!state) {
          return { ok: false, error: { kind: "unsupported_language", file: abs, message: `No language server configured for ${abs}` } } as const;
        }
        const uri = await this.#openFile(state, abs, options.signal);
        return { ok: true, result: { abs, uri, state } } as const;
      };
      return options.timeoutMs != null
        ? await raceWithTimeout(work(), options.timeoutMs, abs, options.signal)
        : options.signal != null
          ? await raceWithSignal(work(), options.signal)
          : await work();
    } catch (error) {
      if (isAbort(error, options.signal)) throw error;
      if (error instanceof LspToolError) return { ok: false, error: error.details };
      return {
        ok: false,
        error: { kind: "tool_execution_failed", file: abs, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async #getFileState(file: string, options: ResolveFileStateOptions = {}): Promise<FileState | undefined> {
    const language = detectLanguage(file);
    if (!language) return undefined;

    const workspaceRoot = findWorkspaceRoot(file, this.cwd);
    const key = `${language}\0${workspaceRoot}`;

    const existing = this.#clients.get(key);
    if (existing) return existing;

    if (this.#failures.has(key)) throw new LspToolError(this.#failures.get(key));

    const inFlight = this.#starting.get(key);
    if (inFlight) {
      // Share the background startup but stay abort-aware for this waiter:
      // an abort rejects only this caller, the startup itself keeps warming
      // the server for the next call.
      return options.signal != null
        ? await raceWithSignal(inFlight.promise, options.signal)
        : await inFlight.promise;
    }

    const config = getServerConfig(language, workspaceRoot);
    if (!config) return undefined;

    const rootUri = filePathToUri(workspaceRoot);
    const startup: Startup = { cancelled: false, promise: Promise.resolve(undefined) };

    const startPromise = (async (): Promise<FileState | undefined> => {
      const client = new LspClient({
        command: config.command,
        args: config.args,
        root_uri: rootUri,
        language_id_for_uri: languageIdForFile,
        env: createChildProcessEnv(),
      });

      try {
        await client.start(options.timeoutMs, options.signal);
      } catch (error) {
        if (startup.cancelled) throw new LspStartupCancelledError(language, workspaceRoot);
        // Abort must not be cached as a server failure — the server did
        // nothing wrong, the user just pressed ESC. Let it throw so the
        // tool layer can rethrow for pi's cancellation handling.
        if (isAbort(error, options.signal)) throw error;
        const failure = toLspToolError(file, language, workspaceRoot, config.command, config.install_hint, error);
        this.#failures.set(key, failure);
        throw new LspToolError(failure);
      }

      if (startup.cancelled) {
        await client.stop();
        throw new LspStartupCancelledError(language, workspaceRoot);
      }

      const state: FileState = {
        client, language, workspaceRoot, rootUri,
        command: config.command, installHint: config.install_hint,
      };
      this.#clients.set(key, state);
      this.#failures.delete(key);
      return state;
    })();

    startup.promise = startPromise;
    this.#starting.set(key, startup);

    try {
      if (options.signal != null) {
        return await raceWithSignal(startPromise, options.signal);
      }
      return await startPromise;
    } finally {
      if (this.#starting.get(key) === startup) this.#starting.delete(key);
    }
  }

  async #openFile(state: FileState, absPath: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new DOMException("This operation was aborted", "AbortError");
    }
    const text = await readFile(absPath, "utf-8");
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new DOMException("This operation was aborted", "AbortError");
    }
    const uri = filePathToUri(absPath);
    await state.client.ensureDocumentOpen(uri, text);
    return uri;
  }
}

// ─── Error types ──────────────────────────────────────────────────────────

class LspStartupCancelledError extends Error {
  constructor(language: string, workspaceRoot: string) {
    super(`Startup cancelled for ${language} LSP in ${workspaceRoot}`);
    this.name = "LspStartupCancelledError";
  }
}

export class LspToolError extends Error {
  constructor(public readonly details: LspToolErrorDetail) {
    super(details.message);
    this.name = "LspToolError";
  }
}

export interface LspToolErrorDetail {
  kind: string;
  file?: string;
  language?: string;
  workspace_root?: string;
  command?: string;
  install_hint?: string;
  message: string;
  code?: string;
}

export function toLspToolError(
  file: string, language: string, workspaceRoot: string | undefined,
  command: string, installHint: string | undefined, error: unknown,
): LspToolErrorDetail {
  if (error instanceof LspToolError) return error.details;
  if (error instanceof LspClientStartError) {
    return {
      kind: "server_start_failed", file, language, workspace_root: workspaceRoot,
      command, install_hint: installHint, code: error.code,
      message: error.code === "ENOENT" ? `command "${command}" not found` : error.message,
    };
  }
  const err = error as Record<string, unknown> | undefined;
  return {
    kind: "tool_execution_failed", file, language, workspace_root: workspaceRoot,
    command, install_hint: installHint,
    message: error instanceof Error ? error.message : String(error),
    code: err?.code as string | undefined,
  };
}

export function formatToolError(details: LspToolErrorDetail): string {
  if (details.kind === "unsupported_language" || details.kind === "tool_timeout" || details.kind === "invalid_position") {
    return details.message;
  }
  const lines = [
    details.language ? `${details.language} LSP unavailable for ${details.file}` : `LSP request failed for ${details.file}`,
    `Reason: ${details.message}`,
  ];
  if (details.command) lines.push(`Command: ${details.command}`);
  if (details.workspace_root) lines.push(`Workspace: ${details.workspace_root}`);
  if (details.install_hint) lines.push(`Hint: ${details.install_hint}`);
  return lines.join("\n");
}
