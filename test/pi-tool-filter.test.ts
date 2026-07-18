/**
 * hooks/pi-tool-filter.ts — drops pi native tools that are replaced
 * by our extensions (edit).
 */
import { describe, it, expect, vi } from "vitest";
import { piToolFilterModule, setupPiToolFilter } from "../hooks/pi-tool-filter.js";

describe("pi-tool-filter", () => {
  it("filters out only edit (replaced by patch)", async () => {
    const ctx = {} as any;
    const pi = {
      getActiveTools: () => ["read", "bash", "write", "edit", "grep", "find", "ls", "custom"],
      setActiveTools: vi.fn(),
    };
    const handler = piToolFilterModule.hooks.session_start![0];
    await handler({ reason: "startup" } as any, ctx, pi as any);
    expect(pi.setActiveTools).toHaveBeenCalledWith([
      "read", "bash", "write", "grep", "find", "ls", "custom",
    ]);
  });

  it("preserves all tools when edit is not active", async () => {
    const ctx = {} as any;
    const pi = {
      getActiveTools: () => ["read", "bash", "write"],
      setActiveTools: vi.fn(),
    };
    const handler = piToolFilterModule.hooks.session_start![0];
    await handler({ reason: "startup" } as any, ctx, pi as any);
    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash", "write"]);
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
