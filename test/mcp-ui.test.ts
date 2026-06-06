/**
 * McpStatusComponent (UI) — pure presentation.
 *
 * Verifies the UI is decoupled from the hook layer: it talks only
 * through the McpStatusCallbacks interface, so tests can drive it
 * with mocks and don't need to load hooks/mcp.ts or tools/mcp/builtin.
 */

import { describe, it, expect, vi } from "vitest";
import { McpStatusComponent, type McpServerView } from "../ui/mcp-status.js";

// Minimal TUI/theme stand-ins: the component only uses tui.requestRender()
// and theme.fg(name, str). No real rendering is asserted here — that
// requires a renderer. This test just exercises the contract.
function fakeTui() {
  return { requestRender: vi.fn() } as any;
}
function fakeTheme() {
  return { fg: (_: string, s: string) => s } as any;
}

function makeServer(over: Partial<McpServerView> = {}): McpServerView {
  return {
    name: "test1",
    url: "http://test1",
    source: "global",
    state: "connected",
    toolCount: 0,
    tools: [],
    ...over,
  };
}

describe("McpStatusComponent (decoupled UI)", () => {
  it("uses callbacks.read() for state, never imports the hook layer", () => {
    const read = vi.fn(() => [makeServer()]);
    const toggle = vi.fn(() => true);
    const refresh = vi.fn(async () => ({ ok: true }));
    const comp = new McpStatusComponent(fakeTui(), fakeTheme(), { read, toggle, refresh }, vi.fn());
    // read() should have been called during construction.
    expect(read).toHaveBeenCalled();
    comp.dispose();
  });

  it("calls callbacks.toggle(name, enabled) when space is pressed", () => {
    const toggle = vi.fn(() => true);
    const comp = new McpStatusComponent(fakeTui(), fakeTheme(), {
      read: () => [makeServer({ state: "disabled" })],
      toggle,
      refresh: async () => ({ ok: true }),
    }, vi.fn());
    comp.handleInput(" ");
    // toggle called with (name, true) because the server is currently disabled.
    expect(toggle).toHaveBeenCalledWith("test1", true);
    comp.dispose();
  });

  it("calls callbacks.refresh(name) when 'r' is pressed", () => {
    const refresh = vi.fn(async () => ({ ok: true }));
    const comp = new McpStatusComponent(fakeTui(), fakeTheme(), {
      read: () => [makeServer()],
      toggle: () => true,
      refresh,
    }, vi.fn());
    comp.handleInput("r");
    expect(refresh).toHaveBeenCalledWith("test1");
    comp.dispose();
  });

  it("invokes onDone when 'q' is pressed", () => {
    const done = vi.fn();
    const comp = new McpStatusComponent(fakeTui(), fakeTheme(), {
      read: () => [makeServer()],
      toggle: () => true,
      refresh: async () => ({ ok: true }),
    }, done);
    comp.handleInput("q");
    expect(done).toHaveBeenCalled();
    comp.dispose();
  });
});
