/**
 * LSP Client — high-level LSP operations over JSON-RPC stdio.
 */
import { pathToFileURL } from "node:url";
import {
  LspProtocol,
  LspProtocolError,
} from "./protocol.js";
import type {
  LspDiagnostic,
  LspDocumentSymbol,
  LspHover,
  LspLocation,
  LspPosition,
  LspRange,
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
 * Wraps LspProtocol with LSP-specific operations:
 * document open/didChange, hover, definition, references,
 * document symbols, rename, diagnostics.
 */
export class LspClient {
  #protocol = new LspProtocol();
  #options: LspClientOptions;
  #initialized = false;
  #openDocs = new Map<string, OpenDoc>();
  #diagnosticsByUri = new Map<string, LspDiagnostic[]>();

  constructor(options: LspClientOptions) {
    this.#options = options;
    this.#protocol.on("diagnostics", (params: { uri: string; diagnostics: LspDiagnostic[] }) => {
      this.#diagnosticsByUri.set(params.uri, params.diagnostics);
    });
  }

  get protocol(): LspProtocol {
    return this.#protocol;
  }

  #request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    return this.#protocol.request(method, params, timeoutMs ?? this.#options.request_timeout_ms ?? 30_000);
  }

  /** Start the LSP server and complete initialization handshake. */
  async start(timeoutMs?: number): Promise<void> {
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
            publishDiagnostics: { relatedInformation: true },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: false },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            rename: { prepareSupport: true },
          },
          workspace: { workspaceFolders: true, symbol: {} },
        },
        workspaceFolders: [{ uri: this.#options.root_uri, name: "workspace" }],
      }, timeoutMs);
      this.#protocol.notify("initialized", {});
      this.#initialized = true;
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  isReady(): boolean {
    return this.#initialized;
  }

  /** Open or update a document in the LSP server. */
  async ensureDocumentOpen(uri: string, text: string): Promise<void> {
    const existing = this.#openDocs.get(uri);
    const nextVersion = existing ? existing.version + 1 : 1;
    this.#openDocs.set(uri, { version: nextVersion });
    this.#diagnosticsByUri.delete(uri);

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

  getDiagnostics(uri: string): LspDiagnostic[] {
    return this.#diagnosticsByUri.get(uri) ?? [];
  }

  /** Wait for diagnostics, with optional timeout. */
  async waitForDiagnostics(uri: string, timeoutMs = 1500): Promise<LspDiagnostic[]> {
    if (this.#diagnosticsByUri.has(uri)) {
      return this.getDiagnostics(uri);
    }
    return new Promise((resolve) => {
      let active = true;
      const handler = (event: { uri: string; diagnostics: LspDiagnostic[] }) => {
        if (event.uri !== uri || !active) return;
        active = false;
        this.#protocol.off("diagnostics", handler);
        clearTimeout(timer);
        resolve(this.getDiagnostics(uri));
      };
      const timer = setTimeout(() => {
        if (!active) return;
        active = false;
        this.#protocol.off("diagnostics", handler);
        resolve(this.getDiagnostics(uri));
      }, timeoutMs);
      this.#protocol.on("diagnostics", handler);
    });
  }

  async hover(uri: string, position: LspPosition, timeoutMs?: number): Promise<LspHover | null> {
    return (await this.#request("textDocument/hover", {
      textDocument: { uri },
      position,
    }, timeoutMs)) as LspHover | null;
  }

  async definition(uri: string, position: LspPosition, timeoutMs?: number): Promise<LspLocation[]> {
    return normalizeLocations(
      await this.#request("textDocument/definition", {
        textDocument: { uri },
        position,
      }, timeoutMs),
    );
  }

  async references(
    uri: string,
    position: LspPosition,
    includeDeclaration = true,
    timeoutMs?: number,
  ): Promise<LspLocation[]> {
    return normalizeLocations(
      await this.#request("textDocument/references", {
        textDocument: { uri },
        position,
        context: { includeDeclaration },
      }, timeoutMs),
    );
  }

  async documentSymbols(uri: string, timeoutMs?: number): Promise<LspDocumentSymbol[]> {
    return normalizeDocumentSymbols(
      await this.#request("textDocument/documentSymbol", {
        textDocument: { uri },
      }, timeoutMs),
    );
  }

  async rename(
    uri: string,
    position: LspPosition,
    newName: string,
    timeoutMs?: number,
  ): Promise<Record<string, { oldText: string; newText: string }>> {
    const result = (await this.#request("textDocument/rename", {
      textDocument: { uri },
      position,
      newName,
    }, timeoutMs)) as { changes?: Record<string, Array<{ range: LspRange; newText: string }>> } | null;

    const edits: Record<string, { oldText: string; newText: string }> = {};
    if (!result?.changes) return edits;

    for (const [fileUri, changes] of Object.entries(result.changes)) {
      const path = uriToPath(fileUri);
      for (const change of changes) {
        if (!edits[path]) {
          edits[path] = { oldText: "", newText: "" };
        }
        edits[path].oldText += change.range
          ? `[${change.range.start.line}:${change.range.start.character}-${change.range.end.line}:${change.range.end.character}]`
          : "";
        edits[path].newText += change.newText ?? "";
      }
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

function normalizeLocations(result: unknown): LspLocation[] {
  if (!result) return [];
  const entries = Array.isArray(result) ? result : [result];
  return entries.map((entry: any) => {
    if ("uri" in entry && "range" in entry) return entry as LspLocation;
    return {
      uri: entry.targetUri,
      range: entry.targetSelectionRange ?? entry.targetRange,
    } as LspLocation;
  });
}

function normalizeDocumentSymbols(result: unknown): LspDocumentSymbol[] {
  if (!result || !Array.isArray(result) || result.length === 0) return [];
  const first = result[0];
  if ("range" in first && "selectionRange" in first) {
    return result as LspDocumentSymbol[];
  }
  return result.map((entry: any) => ({
    name: entry.name,
    kind: entry.kind,
    range: entry.location.range,
    selectionRange: entry.location.range,
    containerName: entry.containerName,
    uri: entry.location.uri,
  }));
}

function uriToPath(uri: string): string {
  try {
    return uri.startsWith("file:") ? new URL(uri).pathname : uri;
  } catch {
    return uri;
  }
}

export function filePathToUri(filePath: string): string {
  return pathToFileURL(filePath).href;
}
