/**
 * hooks/pi-tool-filter.ts — drops pi native tools that are replaced
 * by our extensions (edit, write, grep, find, ls).
 */
import { describe, it, expect, vi } from "vitest";
import { piToolFilterModule, setupPiToolFilter } from "../hooks/pi-tool-filter.js";

describe("pi-tool-filter", () => {
  it("filters out replaced tools (edit, write, grep, find, ls)", async () => {
    const ctx = {} as any;
    const pi = {
      getActiveTools: () => ["read", "bash", "write", "edit", "grep", "find", "ls", "custom"],
      setActiveTools: vi.fn(),
    };
    const handler = piToolFilterModule.hooks.session_start![0];
    await handler({ reason: "startup" } as any, ctx, pi as any);
    expect(pi.setActiveTools).toHaveBeenCalledWith([
      "read", "bash", "custom",
    ]);
  });

  it("preserves tools when no replacements are active", async () => {
    const ctx = {} as any;
    const pi = {
      getActiveTools: () => ["read", "bash", "write"],
      setActiveTools: vi.fn(),
    };
    const handler = piToolFilterModule.hooks.session_start![0];
    await handler({ reason: "startup" } as any, ctx, pi as any);
    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash"]);
  });

  it("works with an empty tool list", async () => {
    const ctx = {} as any;
    const pi = {
      getActiveTools: () => [],
      setActiveTools: vi.fn(),
    };
    const handler = piToolFilterModule.hooks.session_start![0];
    await handler({ reason: "startup" } as any, ctx, pi as any);
    expect(pi.setActiveTools).toHaveBeenCalledWith([]);
  });

  it("setupPiToolFilter registers the module with the skeleton", async () => {
    const sk = {
      register: vi.fn(),
    };
    setupPiToolFilter(sk as any);
    expect(sk.register).toHaveBeenCalledWith(piToolFilterModule);
  });

  it("module metadata is correct", () => {
    expect(piToolFilterModule.name).toBe("pi-tool-filter");
    expect(piToolFilterModule.hooks.session_start).toHaveLength(1);
  });
});
