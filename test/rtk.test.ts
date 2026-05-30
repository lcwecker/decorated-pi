/**
 * RTK — Unit Tests
 */

import { describe, it, expect } from "vitest";
import {
  appendStatus,
  buildRtkCommand,
  executeOriginalBash,
  extractMainCommand,
  shellQuote,
  shouldBypassRtkRewrite,
} from "../extensions/rtk";

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

  it("extracts main command through prefixes", () => {
    expect(extractMainCommand("cd /path && git status")).toBe("git status");
    expect(extractMainCommand("FOO=bar BAZ=qux cargo test")).toBe("cargo test");
    expect(extractMainCommand("time sudo npm install")).toBe("npm install");
  });

  it("does not bypass simple find commands", () => {
    expect(shouldBypassRtkRewrite("find . -name '*.ts'"))
      .toBe(false);
    expect(shouldBypassRtkRewrite("cd /repo && find . -name foo | sort"))
      .toBe(false);
  });

  it("bypasses compound find predicates", () => {
    expect(shouldBypassRtkRewrite("find . -name a -o -name b")).toBe(true);
    expect(shouldBypassRtkRewrite("cd /repo && find . -name a -o -name b | sort")).toBe(true);
    expect(shouldBypassRtkRewrite("find . \\( -name a -o -name b \\)"))
      .toBe(true);
  });

  it("bypasses unsupported find actions", () => {
    expect(shouldBypassRtkRewrite("find . -name foo -exec cat {} \\;"))
      .toBe(true);
    expect(shouldBypassRtkRewrite("find . -name foo -print0 | xargs -0 rm")).toBe(true);
    expect(shouldBypassRtkRewrite("find . -name foo -delete")).toBe(true);
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
