/**
 * tool-compress — Unit Tests
 */

import { describe, it, expect } from "vitest";
import { appendStatus, buildRtkCommand, executeOriginalBash, shellQuote, shouldBypassRtkRewrite } from "../extensions/tool-compress";

// ── ANSI strip ─────────────────────────────────────────────────────────────

describe("ANSI strip", () => {
  it("removes ANSI color codes", () => {
    const input = "\x1b[31mError\x1b[0m: something failed";
    const expected = "Error: something failed";
    expect(input.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")).toBe(expected);
  });

  it("removes multiple ANSI codes", () => {
    const input = "\x1b[1;32mSuccess\x1b[0m: \x1b[34mdone\x1b[0m";
    const expected = "Success: done";
    expect(input.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")).toBe(expected);
  });

  it("handles text without ANSI codes", () => {
    const input = "No ANSI codes here";
    expect(input.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")).toBe(input);
  });
});

// ── Blank line collapse ────────────────────────────────────────────────────

describe("blank line collapse", () => {
  // Collapse 4+ consecutive newlines into 3 (preserves 2 blank lines)
  function collapseBlankLines(text: string): string {
    return text.replace(/\n{4,}/g, "\n\n\n");
  }

  it("collapses 5 newlines into 3", () => {
    const input = "line1\n\n\n\n\nline2";
    const expected = "line1\n\n\nline2";
    expect(collapseBlankLines(input)).toBe(expected);
  });

  it("preserves 3 newlines (2 blank lines)", () => {
    const input = "line1\n\n\nline2";
    expect(collapseBlankLines(input)).toBe(input);
  });

  it("handles no blank lines", () => {
    const input = "line1\nline2\nline3";
    expect(collapseBlankLines(input)).toBe(input);
  });
});

// ── Deduplicate lines ──────────────────────────────────────────────────────

describe("deduplicate lines", () => {
  function deduplicateLines(text: string): string {
    const lines = text.split("\n");
    const result: string[] = [];
    let prev = "";
    let count = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed !== "" && trimmed === prev) {
        count++;
      } else {
        if (count > 2) {
          result.push(`<<< REPEAT ${count}x >>>`);
          result.push(prev);
          result.push("<<< END REPEAT >>>");
        } else if (count === 2) {
          // Two identical lines: keep both
          result.push(prev);
        }
        result.push(line);
        prev = trimmed;
        count = trimmed === "" ? 0 : 1;
      }
    }

    // Handle trailing repeats
    if (count > 2) {
      result.push(`<<< REPEAT ${count}x >>>`);
      result.push(prev);
      result.push("<<< END REPEAT >>>");
    } else if (count === 2) {
      result.push(prev);
    }

    return result.join("\n");
  }

  it("deduplicates 3+ repeated lines", () => {
    const input = "npm install...\nnpm install...\nnpm install...\nnpm install...";
    const result = deduplicateLines(input);
    expect(result).toContain("<<< REPEAT 4x >>>");
    expect(result).toContain("npm install...");
    expect(result).toContain("<<< END REPEAT >>>");
  });

  it("keeps 2 identical lines as-is", () => {
    const input = "line1\nline1";
    const result = deduplicateLines(input);
    expect(result).toBe("line1\nline1");
  });

  it("handles no duplicates", () => {
    const input = "line1\nline2\nline3";
    expect(deduplicateLines(input)).toBe(input);
  });

  it("handles empty lines between duplicates", () => {
    const input = "line1\nline1\nline1\n\nline1\nline1\nline1\nline1";
    const result = deduplicateLines(input);
    // First group: 3 identical lines
    expect(result).toContain("<<< REPEAT 3x >>>");
    // Second group: 4 identical lines
    expect(result).toContain("<<< REPEAT 4x >>>");
  });

  it("handles multiple groups of duplicates", () => {
    const input = "aaa\naaa\naaa\nbbb\nbbb\nbbb\nbbb";
    const result = deduplicateLines(input);
    expect(result).toContain("<<< REPEAT 3x >>>");
    expect(result).toContain("<<< REPEAT 4x >>>");
  });
});

// ── RTK rewrite helpers ────────────────────────────────────────────────────

describe("RTK rewrite helpers", () => {
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

  it("does not bypass simple find commands", () => {
    expect(shouldBypassRtkRewrite("find . -name '*.ts'"))
      .toBe(false);
    expect(shouldBypassRtkRewrite("cd /repo && find . -name foo | sort")).toBe(false);
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

// ── Runtime fallback helpers ───────────────────────────────────────────────

describe("runtime fallback helpers", () => {
  it("appends status to non-empty output", () => {
    expect(appendStatus("hello", "Command exited with code 1")).toBe("hello\n\nCommand exited with code 1");
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

// ── Command extraction ─────────────────────────────────────────────────────

describe("extract main command", () => {
  function extractMainCommand(command: string): string {
    let cmd = command.trim().toLowerCase();
    cmd = cmd.replace(/^cd\s+\S+\s*(&&|;|\n)\s*/, "");
    cmd = cmd.replace(/^(?:[a-z_][a-z0-9_]*=\S*\s+)+/, "");
    const prefixes = ["sudo ", "time ", "nohup ", "nice ", "env "];
    for (const prefix of prefixes) {
      if (cmd.startsWith(prefix)) {
        cmd = cmd.slice(prefix.length);
      }
    }
    return cmd;
  }

  it("strips cd prefix with &&", () => {
    expect(extractMainCommand("cd /path && git status")).toBe("git status");
    expect(extractMainCommand("cd /path && npm install")).toBe("npm install");
  });

  it("strips cd prefix with ;", () => {
    expect(extractMainCommand("cd /path; ls -la")).toBe("ls -la");
  });

  it("strips env var assignments", () => {
    expect(extractMainCommand("FOO=bar BAZ=qux cargo test")).toBe("cargo test");
  });

  it("strips multiple prefixes", () => {
    expect(extractMainCommand("cd /path && sudo npm install")).toBe("npm install");
  });

  it("preserves command without prefix", () => {
    expect(extractMainCommand("git log")).toBe("git log");
    expect(extractMainCommand("ls -la")).toBe("ls -la");
  });
});

// ── Command level detection ────────────────────────────────────────────────

describe("command level detection", () => {
  const COMMAND_LEVELS: Record<string, number> = {
    "ls": 1,
    "tree": 1,
    "git status": 2,
    "git log": 2,
    "git diff": 2,
    "npm install": 2,
    "pnpm install": 2,
    "cargo test": 2,
    "pytest": 2,
    "jest": 2,
    "vitest": 2,
    "docker ps": 1,
    "docker images": 1,
  };

  function extractMainCommand(command: string): string {
    let cmd = command.trim().toLowerCase();
    cmd = cmd.replace(/^cd\s+\S+\s*(&&|;|\n)\s*/, "");
    cmd = cmd.replace(/^(?:[a-z_][a-z0-9_]*=\S*\s+)+/, "");
    const prefixes = ["sudo ", "time ", "nohup ", "nice ", "env "];
    for (const prefix of prefixes) {
      if (cmd.startsWith(prefix)) {
        cmd = cmd.slice(prefix.length);
      }
    }
    return cmd;
  }

  function getCommandLevel(command: string): number {
    const stripped = extractMainCommand(command);
    let bestLevel = 0;
    let bestLen = 0;
    for (const [pattern, level] of Object.entries(COMMAND_LEVELS)) {
      if (stripped.startsWith(pattern) && pattern.length > bestLen) {
        bestLevel = level;
        bestLen = pattern.length;
      }
    }
    return bestLevel;
  }

  it("detects ls as level 1", () => {
    expect(getCommandLevel("ls -la")).toBe(1);
    expect(getCommandLevel("ls")).toBe(1);
  });

  it("detects tree as level 1", () => {
    expect(getCommandLevel("tree -L 2")).toBe(1);
  });

  it("detects git status as level 2", () => {
    expect(getCommandLevel("git status")).toBe(2);
    expect(getCommandLevel("git status --short")).toBe(2);
  });

  it("detects git log as level 2", () => {
    expect(getCommandLevel("git log -n 10")).toBe(2);
  });

  it("detects npm install as level 2", () => {
    expect(getCommandLevel("npm install")).toBe(2);
    expect(getCommandLevel("npm install lodash")).toBe(2);
  });

  it("detects pnpm install as level 2", () => {
    expect(getCommandLevel("pnpm install")).toBe(2);
  });

  it("detects cargo test as level 2", () => {
    expect(getCommandLevel("cargo test")).toBe(2);
    expect(getCommandLevel("cargo test --release")).toBe(2);
  });

  it("detects pytest as level 2", () => {
    expect(getCommandLevel("pytest")).toBe(2);
    expect(getCommandLevel("pytest -v")).toBe(2);
  });

  it("detects docker ps as level 1", () => {
    expect(getCommandLevel("docker ps")).toBe(1);
    expect(getCommandLevel("docker ps -a")).toBe(1);
  });

  it("returns 0 for unknown commands", () => {
    expect(getCommandLevel("cat file.txt")).toBe(0);
    expect(getCommandLevel("head -n 10 file.txt")).toBe(0);
    expect(getCommandLevel("echo hello")).toBe(0);
  });

  it("handles sudo prefix", () => {
    expect(getCommandLevel("sudo npm install")).toBe(2);
    expect(getCommandLevel("sudo ls -la")).toBe(1);
  });

  it("handles time prefix", () => {
    expect(getCommandLevel("time cargo test")).toBe(2);
  });

  it("prefers longer match", () => {
    // "npm install" should match over "npm"
    expect(getCommandLevel("npm install lodash")).toBe(2);
    expect(getCommandLevel("npm test")).toBe(0); // not in whitelist
  });

  it("handles cd prefix", () => {
    expect(getCommandLevel("cd /path && git status")).toBe(2);
    expect(getCommandLevel("cd /path && npm install")).toBe(2);
    expect(getCommandLevel("cd /path; ls -la")).toBe(1);
  });
});


