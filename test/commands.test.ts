/**
 * /dp-model, /dp-settings, /retry, /mcp — command smoke tests.
 *
 * These commands are thin glue between ExtensionAPI and UI components /
 * hook functions. We stub everything and assert:
 *  - the right component is shown in interactive mode
 *  - the right notification is sent in non-interactive mode
 *  - side effects (sendMessage, abort, toggle) fire as expected
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Shared mocks ─────────────────────────────────────────────────────────

const mockCustom = vi.fn();
const mockNotify = vi.fn();
const mockSendMessage = vi.fn();
const mockAbort = vi.fn();
const mockRegisterCommand = vi.fn();
const mockRegisterShortcut = vi.fn();
const mockOn = vi.fn();

let lastCommand: { name: string; handler: (...args: any[]) => any } | null = null;
let lastAgentStartHandler: (() => void) | null = null;

function makeCtx(overrides: Partial<{
  hasUI: boolean;
  isIdle: () => boolean;
  modelRegistry: unknown;
  cwd: string;
}> = {}) {
  return {
    hasUI: true,
    isIdle: () => true,
    modelRegistry: {},
    cwd: "/tmp",
    ui: {
      custom: mockCustom,
      notify: mockNotify,
    },
    abort: mockAbort,
    ...overrides,
  };
}

function makePi() {
  return {
    registerCommand: mockRegisterCommand.mockImplementation((name, opts) => {
      lastCommand = { name, handler: opts.handler };
    }),
    registerShortcut: mockRegisterShortcut,
    sendMessage: mockSendMessage,
    on: mockOn.mockImplementation((event, handler) => {
      if (event === "agent_start") lastAgentStartHandler = handler;
    }),
  };
}

beforeEach(() => {
  mockCustom.mockReset();
  mockNotify.mockReset();
  mockSendMessage.mockReset();
  mockAbort.mockReset();
  mockRegisterCommand.mockReset();
  mockOn.mockReset();
  lastCommand = null;
  lastAgentStartHandler = null;
});

// ─── /dp-model ────────────────────────────────────────────────────────────

describe("/dp-model", () => {
  it("shows the ModelPickerComponent in interactive mode", async () => {
    const { registerDpModelCommand } = await import("../commands/dp-model.js");
    const pi = makePi();
    registerDpModelCommand(pi as any);

    const ctx = makeCtx();
    await lastCommand!.handler([], ctx);

    expect(mockCustom).toHaveBeenCalledTimes(1);
    expect(mockCustom.mock.calls[0][0]).toBeTypeOf("function"); // factory
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("notifies 'requires interactive mode' in non-interactive mode", async () => {
    const { registerDpModelCommand } = await import("../commands/dp-model.js");
    const pi = makePi();
    registerDpModelCommand(pi as any);

    const ctx = makeCtx({ hasUI: false });
    await lastCommand!.handler([], ctx);

    expect(mockCustom).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      "dp-model requires interactive mode.",
      "warning",
    );
  });

  it("factory builds a ModelPickerComponent", async () => {
    const { registerDpModelCommand } = await import("../commands/dp-model.js");
    const pi = makePi();
    registerDpModelCommand(pi as any);

    const ctx = makeCtx();
    await lastCommand!.handler([], ctx);

    const factory = mockCustom.mock.calls[0][0];
    expect(factory).toBeTypeOf("function");
    // The factory returns a Component instance; we don't fully instantiate
    // it because ModelPickerComponent's constructor reads a global theme
    // (initTheme) that's not available in unit tests. The fact that the
    // factory is called by pi and returned as a Component is the contract.
  });
});

// ─── /dp-settings ─────────────────────────────────────────────────────────

describe("/dp-settings", () => {
  it("shows the ModuleSettingsComponent in interactive mode", async () => {
    const { registerDpSettingsCommand } = await import("../commands/dp-settings.js");
    const pi = makePi();
    registerDpSettingsCommand(pi as any);

    const ctx = makeCtx();
    await lastCommand!.handler([], ctx);

    expect(mockCustom).toHaveBeenCalledTimes(1);
    expect(mockNotify).not.toHaveBeenCalledWith(
      "dp-settings requires interactive mode.",
      expect.anything(),
    );
  });

  it("notifies 'requires interactive mode' in non-interactive mode", async () => {
    const { registerDpSettingsCommand } = await import("../commands/dp-settings.js");
    const pi = makePi();
    registerDpSettingsCommand(pi as any);

    const ctx = makeCtx({ hasUI: false });
    await lastCommand!.handler([], ctx);

    expect(mockCustom).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      "dp-settings requires interactive mode.",
      "warning",
    );
  });

  it("notifies about reload when module settings changed", async () => {
    const settings = await import("../settings.js");
    settings.captureModuleSnapshot(); // baseline

    const { registerDpSettingsCommand } = await import("../commands/dp-settings.js");
    const pi = makePi();
    registerDpSettingsCommand(pi as any);

    // Toggle a module AFTER the baseline so moduleSnapshotChanged() returns true
    settings.setModuleEnabled("lsp", !settings.isModuleEnabled("lsp"));

    const ctx = makeCtx();
    await lastCommand!.handler([], ctx);

    expect(mockNotify).toHaveBeenCalledWith(
      "Module settings updated. /reload to apply.",
      "warning",
    );

    // Reset to avoid affecting other tests
    settings.setModuleEnabled("lsp", !settings.isModuleEnabled("lsp"));
  });

  it("does not notify about reload when settings are unchanged", async () => {
    const settings = await import("../settings.js");
    settings.captureModuleSnapshot();
    // do not change anything

    const { registerDpSettingsCommand } = await import("../commands/dp-settings.js");
    const pi = makePi();
    registerDpSettingsCommand(pi as any);

    const ctx = makeCtx();
    await lastCommand!.handler([], ctx);

    const reloadNotify = mockNotify.mock.calls.find(
      (call) => call[0] === "Module settings updated. /reload to apply.",
    );
    expect(reloadNotify).toBeUndefined();
  });
});

// ─── /retry ───────────────────────────────────────────────────────────────

describe("/retry", () => {
  it("sends a 'Continue.' message and triggers a turn", async () => {
    const { registerRetryCommand } = await import("../commands/retry.js");
    const pi = makePi();
    registerRetryCommand(pi as any);

    const ctx = makeCtx({ isIdle: () => true });
    await lastCommand!.handler([], ctx);

    expect(mockSendMessage).toHaveBeenCalledWith(
      { customType: "retry-trigger", content: "Continue.", display: false },
      { triggerTurn: true },
    );
    expect(mockAbort).not.toHaveBeenCalled();
  });

  it("aborts the current agent when not idle", async () => {
    const { registerRetryCommand } = await import("../commands/retry.js");
    const pi = makePi();
    registerRetryCommand(pi as any);

    const ctx = makeCtx({ isIdle: () => false });
    await lastCommand!.handler([], ctx);

    expect(mockAbort).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects concurrent retry with a warning", async () => {
    const { registerRetryCommand } = await import("../commands/retry.js");
    const pi = makePi();
    registerRetryCommand(pi as any);

    const ctx = makeCtx();
    // First call: succeeds, sets retryInProgress
    await lastCommand!.handler([], ctx);
    // Second call while still in progress
    await lastCommand!.handler([], ctx);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      "Retry is already in progress",
      "warning",
    );
  });

  it("agent_start handler resets retryInProgress so next /retry works", async () => {
    const { registerRetryCommand } = await import("../commands/retry.js");
    const pi = makePi();
    registerRetryCommand(pi as any);

    const ctx = makeCtx();
    await lastCommand!.handler([], ctx);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    // Simulate agent_start firing
    lastAgentStartHandler!();
    await lastCommand!.handler([], ctx);

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });
});

// ─── /mcp (non-interactive branch) ────────────────────────────────────────

describe("/mcp — non-interactive", () => {
  it("notifies 'No MCP servers configured' when list is empty", async () => {
    vi.resetModules();
    vi.doMock("../hooks/mcp.js", () => ({
      getMcpStatus: vi.fn(() => []),
      refreshServerCache: vi.fn(),
      updateConfigEnabled: vi.fn(),
    }));
    const { registerMcpStatusCommand } = await import("../commands/mcp-status.js");
    const pi = makePi();
    registerMcpStatusCommand(pi as any);

    const ctx = makeCtx({ hasUI: false });
    await lastCommand!.handler([], ctx);

    expect(mockNotify).toHaveBeenCalledWith(
      "No MCP servers configured.",
      "info",
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
    vi.doUnmock("../hooks/mcp.js");
  });

  it("sends a mcp-status custom message when servers are present", async () => {
    vi.resetModules();
    vi.doMock("../hooks/mcp.js", () => ({
      getMcpStatus: vi.fn(() => [
        {
          name: "exa",
          url: "https://mcp.exa.ai/mcp",
          source: "builtin",
          state: "connected",
          toolCount: 2,
          tools: [
            { name: "web_search", description: "Search the web" },
            { name: "fetch", description: "Fetch a URL" },
          ],
        },
        {
          name: "broken",
          url: "https://broken.example/mcp",
          source: "project",
          state: "failed",
          toolCount: 0,
          tools: [],
          error: "DNS resolution failed",
        },
      ]),
      refreshServerCache: vi.fn(),
      updateConfigEnabled: vi.fn(),
    }));
    const { registerMcpStatusCommand } = await import("../commands/mcp-status.js");
    const pi = makePi();
    registerMcpStatusCommand(pi as any);

    const ctx = makeCtx({ hasUI: false });
    await lastCommand!.handler([], ctx);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = mockSendMessage.mock.calls[0];
    expect(msg.customType).toBe("mcp-status");
    expect(msg.display).toBe(true);
    expect(opts).toEqual({ triggerTurn: false });
    expect(msg.content).toContain("MCP servers (2):");
    expect(msg.content).toContain("exa");
    expect(msg.content).toContain("web_search");
    expect(msg.content).toContain("broken");
    expect(msg.content).toContain("failed");
    expect(msg.content).toContain("DNS resolution failed");
    vi.doUnmock("../hooks/mcp.js");
  });

  it("shows 'connecting...' state without listing tools", async () => {
    vi.resetModules();
    vi.doMock("../hooks/mcp.js", () => ({
      getMcpStatus: vi.fn(() => [
        {
          name: "loading",
          url: "https://loading.example/mcp",
          source: "global",
          state: "connecting",
          toolCount: 0,
          tools: [],
        },
      ]),
      refreshServerCache: vi.fn(),
      updateConfigEnabled: vi.fn(),
    }));
    const { registerMcpStatusCommand } = await import("../commands/mcp-status.js");
    const pi = makePi();
    registerMcpStatusCommand(pi as any);

    const ctx = makeCtx({ hasUI: false });
    await lastCommand!.handler([], ctx);

    const [msg] = mockSendMessage.mock.calls[0];
    expect(msg.content).toContain("connecting...");
    expect(msg.content).not.toContain("Tools: 0"); // we don't list tools when connecting
    vi.doUnmock("../hooks/mcp.js");
  });
});
