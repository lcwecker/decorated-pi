import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LspDiagnostic } from "../tools/lsp/types.js";

const state = vi.hoisted(() => ({
  protocolInstances: [] as any[],
}));

vi.mock("../tools/lsp/protocol.js", async () => {
  const { EventEmitter } = await import("node:events");
  class MockProtocol extends EventEmitter {
    spawn = vi.fn(async () => {});
    request = vi.fn(async () => null);
    notify = vi.fn();
    kill = vi.fn();
    shutdown = vi.fn(async () => {});

    constructor() {
      super();
      state.protocolInstances.push(this);
    }
  }

  return {
    LspProtocol: MockProtocol,
    LspProtocolError: class LspProtocolError extends Error {
      constructor(public readonly code: number, message: string) {
        super(message);
      }
    },
  };
});

import { LspClient } from "../tools/lsp/client.js";

function lastProtocol(): any {
  return state.protocolInstances[state.protocolInstances.length - 1]!;
}

describe("LspClient", () => {
  beforeEach(() => {
    state.protocolInstances.length = 0;
    vi.clearAllMocks();
  });

  it("uses the provided timeout for initialize during start", async () => {
    const client = new LspClient({
      command: "tsserver",
      args: ["--stdio"],
      root_uri: "file:///ws",
      language_id_for_uri: () => "typescript",
    });

    await client.start(4321);

    const protocol = lastProtocol();
    expect(protocol.spawn).toHaveBeenCalledWith("tsserver", ["--stdio"], process.env);
    expect(protocol.request).toHaveBeenCalledWith(
      "initialize",
      expect.objectContaining({ rootUri: "file:///ws" }),
      4321,
    );
    expect(protocol.notify).toHaveBeenCalledWith("initialized", {});
  });

  it("forwards per-call timeout to documentSymbols", async () => {
    const client = new LspClient({
      command: "tsserver",
      args: ["--stdio"],
      root_uri: "file:///ws",
      language_id_for_uri: () => "typescript",
    });
    const protocol = lastProtocol();
    protocol.request.mockResolvedValueOnce([]);

    await client.documentSymbols("file:///a.ts", 2222);

    expect(protocol.request).toHaveBeenCalledWith(
      "textDocument/documentSymbol",
      { textDocument: { uri: "file:///a.ts" } },
      2222,
    );
  });

  it("waitForDiagnostics resolves when matching diagnostics event arrives", async () => {
    const client = new LspClient({
      command: "tsserver",
      args: ["--stdio"],
      root_uri: "file:///ws",
      language_id_for_uri: () => "typescript",
    });
    const protocol = lastProtocol();
    const diagnostics: LspDiagnostic[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "boom" },
    ];

    const pending = client.waitForDiagnostics("file:///a.ts", 1000);
    protocol.emit("diagnostics", { uri: "file:///other.ts", diagnostics: [] });
    protocol.emit("diagnostics", { uri: "file:///a.ts", diagnostics });

    await expect(pending).resolves.toEqual(diagnostics);
  });
});
