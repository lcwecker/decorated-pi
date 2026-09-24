import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  protocolInstances: [] as any[],
}));

vi.mock("../tools/lsp/protocol.js", async () => {
  class MockProtocol {
    spawn = vi.fn(async () => {});
    request = vi.fn(async () => null);
    notify = vi.fn();
    kill = vi.fn();
    shutdown = vi.fn(async () => {});

    constructor() {
      state.protocolInstances.push(this);
    }
  }

  return { LspProtocol: MockProtocol };
});

import { LspClient } from "../tools/lsp/client.js";

function lastProtocol(): any {
  return state.protocolInstances[state.protocolInstances.length - 1]!;
}

function makeClient(): LspClient {
  return new LspClient({
    command: "tsc",
    args: ["--lsp", "--stdio"],
    root_uri: "file:///ws",
    language_id_for_uri: () => "typescript",
  });
}

describe("LspClient", () => {
  beforeEach(() => {
    state.protocolInstances.length = 0;
    vi.clearAllMocks();
  });

  it("advertises navigation and rename, never diagnostics", async () => {
    const client = makeClient();
    const protocol = lastProtocol();

    await client.start(4321);

    const [method, params, timeout] = protocol.request.mock.calls[0];
    expect(method).toBe("initialize");
    expect(params.rootUri).toBe("file:///ws");
    expect(params.capabilities.textDocument.rename).toEqual({ prepareSupport: true });
    expect(params.capabilities.textDocument.definition).toBeDefined();
    expect(params.capabilities.textDocument.references).toBeDefined();
    expect(params.capabilities.textDocument.documentSymbol).toBeDefined();
    // The module no longer watches diagnostics.
    expect(params.capabilities.textDocument.publishDiagnostics).toBeUndefined();
    expect(params.capabilities.textDocument.diagnostic).toBeUndefined();
    expect(params.capabilities.textDocument.hover).toBeUndefined();
    expect(timeout).toBe(4321);
    expect(protocol.spawn).toHaveBeenCalledWith("tsc", ["--lsp", "--stdio"], process.env);
    expect(protocol.notify).toHaveBeenCalledWith("initialized", {});
  });

  it("forwards the abort signal to initialize during start", async () => {
    const client = makeClient();
    const controller = new AbortController();
    await client.start(4321, controller.signal);
    expect(lastProtocol().request).toHaveBeenCalledWith(
      "initialize",
      expect.objectContaining({ rootUri: "file:///ws" }),
      4321,
      controller.signal,
    );
  });

  it("normalizes definition results, including LocationLink", async () => {
    const client = makeClient();
    const protocol = lastProtocol();
    const range = { start: { line: 3, character: 6 }, end: { line: 3, character: 11 } };
    protocol.request.mockResolvedValueOnce([
      { uri: "file:///ws/a.ts", range },
      { targetUri: "file:///ws/b.ts", targetRange: range, targetSelectionRange: range },
      { targetUri: "file:///ws/c.ts", targetRange: range },
    ]);

    const locations = await client.definition("file:///ws/a.ts", { line: 0, character: 0 }, 1000);

    expect(locations).toEqual([
      { uri: "file:///ws/a.ts", range },
      { uri: "file:///ws/b.ts", range },
      { uri: "file:///ws/c.ts", range },
    ]);
    expect(protocol.request).toHaveBeenCalledWith(
      "textDocument/definition",
      { textDocument: { uri: "file:///ws/a.ts" }, position: { line: 0, character: 0 } },
      1000,
      undefined,
    );
  });

  it("passes includeDeclaration through to references", async () => {
    const client = makeClient();
    const protocol = lastProtocol();
    protocol.request.mockResolvedValueOnce([]);
    const controller = new AbortController();

    await client.references("file:///ws/a.ts", { line: 1, character: 2 }, false, 1000, controller.signal);

    expect(protocol.request).toHaveBeenCalledWith(
      "textDocument/references",
      {
        textDocument: { uri: "file:///ws/a.ts" },
        position: { line: 1, character: 2 },
        context: { includeDeclaration: false },
      },
      1000,
      controller.signal,
    );
  });

  it("keeps hierarchical document symbols and folds the flat reply", async () => {
    const client = makeClient();
    const protocol = lastProtocol();
    const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } };
    protocol.request.mockResolvedValueOnce([
      {
        name: "Greeter",
        kind: 5,
        range,
        selectionRange: range,
        children: [{ name: "greet", kind: 6, range, selectionRange: range }],
      },
      { name: "flatHelper", kind: 12, location: { uri: "file:///ws/a.ts", range } },
    ]);

    const symbols = await client.documentSymbols("file:///ws/a.ts", 1000);

    expect(symbols).toHaveLength(2);
    expect(symbols[0].children?.[0].name).toBe("greet");
    // A SymbolInformation becomes a leaf with the same range twice.
    expect(symbols[1]).toEqual({ name: "flatHelper", kind: 12, range, selectionRange: range });
  });

  it("groups rename changes by absolute path", async () => {
    const client = makeClient();
    const protocol = lastProtocol();
    const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } };
    protocol.request.mockResolvedValueOnce({
      changes: {
        "file:///ws/a.ts": [{ range, newText: "renamed" }],
        "file:///ws/b.ts": [{ range, newText: "renamed" }, { range, newText: "renamed" }],
      },
    });

    const edits = await client.rename("file:///ws/a.ts", { line: 0, character: 6 }, "renamed", 1000);

    expect(edits).toEqual({
      "/ws/a.ts": [{ range, newText: "renamed" }],
      "/ws/b.ts": [{ range, newText: "renamed" }, { range, newText: "renamed" }],
    });
    expect(protocol.request).toHaveBeenCalledWith(
      "textDocument/rename",
      { textDocument: { uri: "file:///ws/a.ts" }, position: { line: 0, character: 6 }, newName: "renamed" },
      1000,
      undefined,
    );
  });

  it("reads documentChanges too, and yields nothing for a null edit", async () => {
    const client = makeClient();
    const protocol = lastProtocol();
    const range = { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } };
    protocol.request.mockResolvedValueOnce({
      documentChanges: [{ textDocument: { uri: "file:///ws/a.ts" }, edits: [{ range, newText: "x" }] }],
    });

    const edits = await client.rename("file:///ws/a.ts", { line: 2, character: 0 }, "x");
    expect(edits).toEqual({ "/ws/a.ts": [{ range, newText: "x" }] });

    protocol.request.mockResolvedValueOnce(null);
    await expect(client.rename("file:///ws/a.ts", { line: 2, character: 0 }, "x")).resolves.toEqual({});
  });

  it("merges changes and documentChanges that target the same file", async () => {
    const client = makeClient();
    const protocol = lastProtocol();
    const first = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    const second = { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } };
    protocol.request.mockResolvedValueOnce({
      changes: { "file:///ws/a.ts": [{ range: first, newText: "x" }] },
      documentChanges: [{ textDocument: { uri: "file:///ws/a.ts" }, edits: [{ range: second, newText: "y" }] }],
    });

    const edits = await client.rename("file:///ws/a.ts", { line: 0, character: 0 }, "x");
    expect(edits).toEqual({ "/ws/a.ts": [{ range: first, newText: "x" }, { range: second, newText: "y" }] });
  });

  it("opens a document once and sends changes afterwards", async () => {
    const client = makeClient();
    const protocol = lastProtocol();

    await client.ensureDocumentOpen("file:///ws/a.ts", "one");
    await client.ensureDocumentOpen("file:///ws/a.ts", "two");

    expect(protocol.notify).toHaveBeenNthCalledWith(1, "textDocument/didOpen", {
      textDocument: { uri: "file:///ws/a.ts", languageId: "typescript", version: 1, text: "one" },
    });
    expect(protocol.notify).toHaveBeenNthCalledWith(2, "textDocument/didChange", {
      textDocument: { uri: "file:///ws/a.ts", version: 2 },
      contentChanges: [{ text: "two" }],
    });
  });
});
