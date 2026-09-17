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
      undefined,
    );
    expect(protocol.notify).toHaveBeenCalledWith("initialized", {});
  });

  it("pulls diagnostics when the server advertises diagnosticProvider", async () => {
    const client = new LspClient({
      command: "tsc",
      args: ["--lsp", "--stdio"],
      root_uri: "file:///ws",
      language_id_for_uri: () => "typescript",
    });
    const protocol = lastProtocol();
    const diagnostics: LspDiagnostic[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, code: 2322, message: "boom" },
    ];
    protocol.request.mockImplementation(async (method: string) => {
      if (method === "initialize") return { capabilities: { diagnosticProvider: {} } };
      if (method === "textDocument/diagnostic") return { kind: "full", items: diagnostics };
      return null;
    });

    await client.start();

    await expect(client.waitForDiagnostics("file:///a.ts", 1000)).resolves.toEqual(diagnostics);
    expect(protocol.request).toHaveBeenCalledWith(
      "textDocument/diagnostic",
      { textDocument: { uri: "file:///a.ts" } },
      1000,
      undefined,
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

  it("forwards the abort signal to initialize during start", async () => {
    const client = new LspClient({
      command: "tsserver",
      args: ["--stdio"],
      root_uri: "file:///ws",
      language_id_for_uri: () => "typescript",
    });
    const controller = new AbortController();
    await client.start(4321, controller.signal);
    expect(lastProtocol().request).toHaveBeenCalledWith(
      "initialize",
      expect.objectContaining({ rootUri: "file:///ws" }),
      4321,
      controller.signal,
    );
  });

  it("forwards the abort signal to hover", async () => {
    const client = new LspClient({
      command: "tsserver",
      args: ["--stdio"],
      root_uri: "file:///ws",
      language_id_for_uri: () => "typescript",
    });
    const protocol = lastProtocol();
    protocol.request.mockResolvedValueOnce({ contents: "hi" });
    const controller = new AbortController();
    await client.hover("file:///a.ts", { line: 0, character: 1 }, 1000, controller.signal);
    expect(protocol.request).toHaveBeenCalledWith(
      "textDocument/hover",
      { textDocument: { uri: "file:///a.ts" }, position: { line: 0, character: 1 } },
      1000,
      controller.signal,
    );
  });

  it("rejects push-wait diagnostics when aborted", async () => {
    const client = new LspClient({
      command: "tsserver",
      args: ["--stdio"],
      root_uri: "file:///ws",
      language_id_for_uri: () => "typescript",
    });
    const protocol = lastProtocol();
    const controller = new AbortController();
    const pending = client.waitForDiagnostics("file:///a.ts", 1000, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
    // Back to the constructor's permanent cache listener only.
    expect(protocol.listenerCount("diagnostics")).toBe(1);
  });

  it("rejects immediately when already aborted", async () => {
    const client = new LspClient({
      command: "tsserver",
      args: ["--stdio"],
      root_uri: "file:///ws",
      language_id_for_uri: () => "typescript",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(client.waitForDiagnostics("file:///a.ts", 1000, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
