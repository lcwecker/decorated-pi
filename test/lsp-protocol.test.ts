import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeStream extends EventEmitter {
  writable = true;
  write = vi.fn();
}

class FakeChildProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdin = new FakeStream();
  kill = vi.fn();
}

const state = vi.hoisted(() => {
  let currentProc: any;
  return {
    spawnMock: vi.fn(() => currentProc),
    setCurrentProc(proc: any) { currentProc = proc; },
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: state.spawnMock };
});

import { LspProtocol, LspProtocolError } from "../tools/lsp/protocol.js";

function emitMessage(proc: FakeChildProcess, message: unknown) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  proc.stdout.emit("data", Buffer.concat([header, body]));
}

describe("LspProtocol", () => {
  let proc: FakeChildProcess;

  beforeEach(() => {
    proc = new FakeChildProcess();
    state.setCurrentProc(proc as any);
    state.spawnMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves spawn when child emits spawn", async () => {
    const protocol = new LspProtocol();
    const promise = protocol.spawn("tsserver", ["--stdio"], { PATH: "/bin" });
    proc.emit("spawn");

    await expect(promise).resolves.toBeUndefined();
    expect(state.spawnMock).toHaveBeenCalledWith("tsserver", ["--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/bin" },
    });
  });

  it("resolves requests from JSON-RPC responses", async () => {
    const protocol = new LspProtocol();
    const spawned = protocol.spawn("tsserver", ["--stdio"], {});
    proc.emit("spawn");
    await spawned;

    const req = protocol.request("initialize", { rootUri: "file:///ws" }, 1000);
    emitMessage(proc, { jsonrpc: "2.0", id: 1, result: { ok: true } });

    await expect(req).resolves.toEqual({ ok: true });
    expect(proc.stdin.write).toHaveBeenCalled();
  });

  it("emits diagnostics notifications", async () => {
    const protocol = new LspProtocol();
    const spawned = protocol.spawn("tsserver", ["--stdio"], {});
    proc.emit("spawn");
    await spawned;

    const diagnostics = vi.fn();
    protocol.on("diagnostics", diagnostics);

    emitMessage(proc, {
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: "file:///a.ts", diagnostics: [{ message: "boom" }] },
    });

    expect(diagnostics).toHaveBeenCalledWith({
      uri: "file:///a.ts",
      diagnostics: [{ message: "boom" }],
    });
  });

  it("times out pending requests", async () => {
    vi.useFakeTimers();
    const protocol = new LspProtocol();
    const spawned = protocol.spawn("tsserver", ["--stdio"], {});
    proc.emit("spawn");
    await spawned;

    const req = protocol.request("textDocument/documentSymbol", { textDocument: { uri: "file:///a.ts" } }, 50);
    const assertion = expect(req).rejects.toThrow('LSP request "textDocument/documentSymbol" timed out after 50ms');
    await vi.advanceTimersByTimeAsync(50);

    await assertion;
  });

  it("rejects requests with protocol errors", async () => {
    const protocol = new LspProtocol();
    const spawned = protocol.spawn("tsserver", ["--stdio"], {});
    proc.emit("spawn");
    await spawned;

    const req = protocol.request("initialize", {}, 1000);
    emitMessage(proc, { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "bad" } });

    await expect(req).rejects.toBeInstanceOf(LspProtocolError);
  });
});
