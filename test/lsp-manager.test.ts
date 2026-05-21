import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  readFileMock: vi.fn(async () => "const x = 1;\n"),
  createEnvMock: vi.fn(() => ({ PATH: "/mock/bin", HOME: "/tmp/home" })),
  detectLanguageMock: vi.fn(() => "typescript"),
  findWorkspaceRootMock: vi.fn(() => "/workspace"),
  getServerConfigMock: vi.fn(() => ({
    language: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    install_hint: "install tsls",
  })),
  languageIdForFileMock: vi.fn(() => "typescript"),
  filePathToUriMock: vi.fn((p: string) => `file://${p}`),
  clientInstances: [] as any[],
  startImpl: (timeoutMs?: number) => Promise.resolve() as Promise<void>,
}));

vi.mock("node:fs/promises", () => ({ readFile: state.readFileMock }));
vi.mock("../extensions/lsp/env.js", () => ({ createChildProcessEnv: state.createEnvMock }));
vi.mock("../extensions/lsp/servers.js", () => ({
  detectLanguage: state.detectLanguageMock,
  findWorkspaceRoot: state.findWorkspaceRootMock,
  getServerConfig: state.getServerConfigMock,
  languageIdForFile: state.languageIdForFileMock,
}));
vi.mock("../extensions/lsp/client.js", () => {
  class MockLspClient {
    options: any;
    start = vi.fn((timeoutMs?: number) => state.startImpl(timeoutMs));
    ensureDocumentOpen = vi.fn(async () => {});
    stop = vi.fn(async () => {});

    constructor(options: any) {
      this.options = options;
      state.clientInstances.push(this);
    }
  }

  class MockLspClientStartError extends Error {
    constructor(message: string, public readonly command: string, public readonly args: string[], public readonly code?: string) {
      super(message);
    }
  }

  return {
    LspClient: MockLspClient,
    LspClientStartError: MockLspClientStartError,
    filePathToUri: state.filePathToUriMock,
  };
});

import { LspServerManager } from "../extensions/lsp/manager.js";

describe("LspServerManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.clientInstances.length = 0;
    state.startImpl = () => Promise.resolve();
  });

  it("wires whitelist env into the client and passes per-call startup timeout", async () => {
    const manager = new LspServerManager({ cwd: () => "/cwd" });

    const result = await manager.resolveFileState("src/app.ts", { timeoutMs: 4321 });

    expect(result.ok).toBe(true);
    expect(state.createEnvMock).toHaveBeenCalledOnce();
    expect(state.clientInstances[0]!.options.env).toEqual({ PATH: "/mock/bin", HOME: "/tmp/home" });
    expect(state.clientInstances[0]!.start).toHaveBeenCalledWith(4321);
    expect(state.clientInstances[0]!.ensureDocumentOpen).toHaveBeenCalledWith("file:///cwd/src/app.ts", "const x = 1;\n");
  });

  it("returns tool_timeout when startup exceeds timeoutMs", async () => {
    vi.useFakeTimers();
    state.startImpl = () => new Promise<void>(() => {});
    const manager = new LspServerManager({ cwd: () => "/cwd" });

    const pending = manager.resolveFileState("src/app.ts", { timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected timeout error");
    expect(result.error.kind).toBe("tool_timeout");
    expect(result.error.message).toContain("25ms");
    vi.useRealTimers();
  });
});
