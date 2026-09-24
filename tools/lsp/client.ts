/**
 * LSP Client — high-level LSP operations over JSON-RPC stdio.
 *
 * Navigation and multi-file edits: definition, references, document symbols
 * and rename. Nothing here watches diagnostics — the tool surface reads what
 * the compiler knows and hands the edits back, it does not grade the code.
 */
import { uriToFilePath } from "./uri.js";
import { LspProtocol } from "./protocol.js";
import type {
  LspDocumentSymbol,
  LspLocation,
  LspPosition,
  LspSymbolInformation,
  LspTextEdit,
  LspWorkspaceEdit,
} from "./types.js";

export class LspClientStartError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly args: string[],
    public readonly code?: string,
    cause?: Error
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = "LspClientStartError";
  }
}

export interface LspClientOptions {
  command: string;
  args: string[];
  root_uri: string;
  language_id_for_uri: (uri: string) => string | undefined;
  env?: NodeJS.ProcessEnv;
  request_timeout_ms?: number;
}

interface OpenDoc {
  version: number;
}

/**
 * High-level LSP client.
 *
 * Wraps LspProtocol with LSP-specific operations: document open/didChange,
 * definition, references, document symbols and rename.
 */
export class LspClient {
  #protocol = new LspProtocol();
  #options: LspClientOptions;
  #initialized = false;
  #openDocs = new Map<string, OpenDoc>();

  constructor(options: LspClientOptions) {
    this.#options = options;
  }

  #request(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    return this.#protocol.request(method, params, timeoutMs ?? this.#options.request_timeout_ms ?? 30_000, signal);
  }

  /** Start the LSP server and complete initialization handshake. */
  async start(timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    try {
      await this.#protocol.spawn(
        this.#options.command,
        this.#options.args,
        this.#options.env ?? process.env,
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new LspClientStartError(
        code === "ENOENT"
          ? `command "${this.#options.command}" not found`
          : `Failed to spawn ${this.#options.command}: ${(err as Error).message}`,
        this.#options.command,
        this.#options.args,
        code,
        err instanceof Error ? err : undefined,
      );
    }

    try {
      await this.#request("initialize", {
        processId: process.pid,
        rootUri: this.#options.root_uri,
        capabilities: {
          textDocument: {
            definition: { linkSupport: false },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            rename: { prepareSupport: true },
          },
          workspace: { workspaceFolders: true },
        },
        workspaceFolders: [{ uri: this.#options.root_uri, name: "workspace" }],
      }, timeoutMs, signal);
      this.#protocol.notify("initialized", {});
      this.#initialized = true;
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  /** Open or update a document in the LSP server. */
  async ensureDocumentOpen(uri: string, text: string): Promise<void> {
    const existing = this.#openDocs.get(uri);
    const nextVersion = existing ? existing.version + 1 : 1;
    this.#openDocs.set(uri, { version: nextVersion });

    if (existing) {
      this.#protocol.notify("textDocument/didChange", {
        textDocument: { uri, version: nextVersion },
        contentChanges: [{ text }],
      });
    } else {
      const languageId = this.#options.language_id_for_uri(uri) ?? "plaintext";
      this.#protocol.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
    }
  }

  async definition(uri: string, position: LspPosition, timeoutMs?: number, signal?: AbortSignal): Promise<LspLocation[]> {
    return normalizeLocations(
      await this.#request("textDocument/definition", {
        textDocument: { uri },
        position,
      }, timeoutMs, signal),
    );
  }

  async references(
    uri: string,
    position: LspPosition,
    includeDeclaration = true,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<LspLocation[]> {
    return normalizeLocations(
      await this.#request("textDocument/references", {
        textDocument: { uri },
        position,
        context: { includeDeclaration },
      }, timeoutMs, signal),
    );
  }

  /** Document symbols, as a tree. A flat `SymbolInformation[]` reply is folded
   *  into the same shape so callers only deal with one. */
  async documentSymbols(uri: string, timeoutMs?: number, signal?: AbortSignal): Promise<LspDocumentSymbol[]> {
    const result = await this.#request("textDocument/documentSymbol", {
      textDocument: { uri },
    }, timeoutMs, signal);
    if (!Array.isArray(result)) return [];
    return result.map(toDocumentSymbol).filter((symbol): symbol is LspDocumentSymbol => symbol !== undefined);
  }

  /**
   * Rename a symbol, returning the edits grouped by absolute file path.
   *
   * The server decides the whole workspace edit; applying it is the caller's
   * job. An empty record means the position holds nothing renamable.
   */
  async rename(
    uri: string,
    position: LspPosition,
    newName: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<Record<string, LspTextEdit[]>> {
    const result = (await this.#request("textDocument/rename", {
      textDocument: { uri },
      position,
      newName,
    }, timeoutMs, signal)) as LspWorkspaceEdit | null;

    const edits: Record<string, LspTextEdit[]> = {};
    if (!result) return edits;

    const buckets: Array<[string, LspTextEdit[]]> = [];
    for (const [fileUri, list] of Object.entries(result.changes ?? {})) {
      if (Array.isArray(list) && list.length > 0) buckets.push([fileUri, list]);
    }
    for (const change of result.documentChanges ?? []) {
      const fileUri = change?.textDocument?.uri;
      const list = change?.edits;
      if (fileUri && Array.isArray(list) && list.length > 0) buckets.push([fileUri, list]);
    }

    for (const [fileUri, list] of buckets) {
      const path = uriToFilePath(fileUri);
      edits[path] = [...(edits[path] ?? []), ...list];
    }
    return edits;
  }

  async stop(): Promise<void> {
    if (this.#initialized) {
      await this.#protocol.shutdown(1000);
    } else {
      this.#protocol.kill();
    }
  }
}

// ─── Result normalization ────────────────────────────────────────────────

function toDocumentSymbol(entry: unknown): LspDocumentSymbol | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const flat = entry as LspSymbolInformation & { location?: { uri?: string; range?: LspDocumentSymbol["range"] } };
  if (flat.location?.uri) {
    const range = flat.location.range;
    if (!range) return undefined;
    return { name: flat.name, kind: flat.kind, range, selectionRange: range };
  }
  const nested = entry as LspDocumentSymbol;
  if (nested.range && typeof nested.name === "string") {
    return {
      name: nested.name,
      kind: nested.kind,
      range: nested.range,
      selectionRange: nested.selectionRange ?? nested.range,
      children: Array.isArray(nested.children)
        ? nested.children.map(toDocumentSymbol).filter((child): child is LspDocumentSymbol => child !== undefined)
        : undefined,
    };
  }
  return undefined;
}

function normalizeLocations(result: unknown): LspLocation[] {
  if (!result) return [];
  const entries = Array.isArray(result) ? result : [result];
  return entries
    .map((entry: any) => {
      if (!entry) return undefined;
      if ("uri" in entry && "range" in entry) return entry as LspLocation;
      return {
        uri: entry.targetUri,
        range: entry.targetSelectionRange ?? entry.targetRange,
      } as LspLocation;
    })
    .filter((location): location is LspLocation => Boolean(location?.uri && location.range));
}
