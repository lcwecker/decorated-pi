/**
 * RTK — Unit Tests
 */

import { describe, it, expect } from "vitest";
import {
  appendStatus,
  buildRtkCommand,
  createRtkModule,
  executeOriginalBash,
  shellQuote,
} from "../hooks/rtk";

function makeRtkToolCallEvent(toolCallId: string, command: string) {
  return {
    toolName: "bash",
    toolCallId,
    input: { command },
  };
}

function makeRtkToolResultEvent(toolCallId: string, isError = false) {
  return {
    toolName: "bash",
    toolCallId,
    isError,
    content: [] as any[],
    input: {},
  };
}

describe("RTK integration helpers", () => {
  it("quotes shell paths safely", () => {
    expect(shellQuote("/tmp/rtk/bin")).toBe("'/tmp/rtk/bin'");
    expect(shellQuote("/tmp/it's/bin")).toBe("'/tmp/it'\"'\"'s/bin'");
  });

  it("prepends RTK bin dir to PATH", () => {
    const result = buildRtkCommand("rtk git log -n 5", "/opt/rtk/bin/rtk");
    expect(result).toBe("export PATH='/opt/rtk/bin':$PATH && rtk git log -n 5");
  });

  it("preserves compound rewritten commands", () => {
    const raw = "cd /repo && rtk git log -n 5";
    const result = buildRtkCommand(raw, "/opt/rtk/bin/rtk");
    expect(result).toBe("export PATH='/opt/rtk/bin':$PATH && cd /repo && rtk git log -n 5");
  });
});

describe("runtime fallback helpers", () => {
  it("appends status to non-empty output", () => {
    expect(appendStatus("hello", "Command exited with code 1"))
      .toBe("hello\n\nCommand exited with code 1");
  });

  it("returns status alone for empty output", () => {
    expect(appendStatus("", "Command aborted")).toBe("Command aborted");
  });

  it("executes original bash successfully", async () => {
    const result = await executeOriginalBash("printf 'hello'", process.cwd(), undefined);
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe("hello");
  });

  it("captures failing original bash command", async () => {
    const result = await executeOriginalBash("sh -c 'echo bad >&2; exit 7'", process.cwd(), undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("bad");
    expect(result.content[0].text).toContain("Command exited with code 7");
  });
});

describe("createRtkModule state isolation", () => {
  const fakeBinary = "/fake/rtk";
  // Always-rewrite stub so pending state is set without a real rtk binary.
  const alwaysRewrite = () => "echo rewritten";

  function makeModule() {
    return createRtkModule(fakeBinary, alwaysRewrite);
  }

  it("two module instances do not share pending-command state", async () => {
    const a = makeModule();
    const b = makeModule();

    const aCall = a.hooks.tool_call![0]! as any;
    const bCall = b.hooks.tool_call![0]! as any;
    const aResult = a.hooks.tool_result![0]! as any;
    const bResult = b.hooks.tool_result![0]! as any;

    // A records a pending command, B records a different one.
    aCall(makeRtkToolCallEvent("a-1", "ls"));
    bCall(makeRtkToolCallEvent("b-1", "pwd"));

    // A's tool_result only sees A's pending command (non-error → undefined).
    // Crucially, it must NOT see or clear B's pending entry.
    const aPending = await aResult(makeRtkToolResultEvent("a-1"), { cwd: process.cwd() });
    expect(aPending).toBeUndefined();

    // B's pending is still intact: an error result triggers fallback execution,
    // proving B's map entry survived A's tool_result resolution.
    const bResolved = await bResult(makeRtkToolResultEvent("b-1", true), { cwd: process.cwd() });
    expect(bResolved).toBeDefined();
    expect(bResolved.isError).toBe(false); // "echo rewritten" succeeds
  });

  it("session_start clears pending commands from a previous session", async () => {
    const mod = makeModule();

    const call = mod.hooks.tool_call![0]! as any;
    call(makeRtkToolCallEvent("c-1", "ls"));

    // session_start should reset state
    (mod.hooks.session_start![0]! as any)();

    // After reset, tool_result finds nothing and returns undefined
    const result = await (mod.hooks.tool_result![0]! as any)(makeRtkToolResultEvent("c-1", true), { cwd: process.cwd() });
    expect(result).toBeUndefined();
  });
});
