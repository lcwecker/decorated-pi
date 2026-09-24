/**
 * tools/lsp/env.ts + tools/lsp/index.ts — smoke tests.
 *
 * - env.ts: whitelist-only env-var filter for spawning LSP servers
 * - index.ts: thin wrapper that wires up the LSP manager + tools + shutdown
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("createChildProcessEnv (tools/lsp/env.ts)", () => {
  it("passes through whitelisted variables", async () => {
    const { createChildProcessEnv } = await import("../tools/lsp/env.js");
    const env = createChildProcessEnv({}, {
      PATH: "/usr/bin",
      HOME: "/home/u",
      USER: "u",
      SHELL: "/bin/bash",
      TERM: "xterm",
      COLORTERM: "truecolor",
      LANG: "en_US.UTF-8",
      PI_CODING_AGENT_DIR: "/pi",
      NODE_PATH: "/n",
      NODE_OPTIONS: "--max-old-space-size=4096",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.USER).toBe("u");
    expect(env.SHELL).toBe("/bin/bash");
    expect(env.TERM).toBe("xterm");
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.PI_CODING_AGENT_DIR).toBe("/pi");
    expect(env.NODE_PATH).toBe("/n");
    expect(env.NODE_OPTIONS).toBe("--max-old-space-size=4096");
  });

  it("passes through LC_* locale-category variables", async () => {
    const { createChildProcessEnv } = await import("../tools/lsp/env.js");
    const env = createChildProcessEnv({}, {
      LC_ALL: "en_US.UTF-8",
      LC_CTYPE: "C",
    });
    expect(env.LC_ALL).toBe("en_US.UTF-8");
    expect(env.LC_CTYPE).toBe("C");
  });

  it("strips proxy, API keys, tokens, and other non-whitelisted vars", async () => {
    const { createChildProcessEnv } = await import("../tools/lsp/env.js");
    const env = createChildProcessEnv({}, {
      HTTP_PROXY: "http://proxy:8080",
      HTTPS_PROXY: "http://proxy:8080",
      ALL_PROXY: "http://proxy:8080",
      NO_PROXY: "localhost",
      ANTHROPIC_API_KEY: "sk-***...***",
      OPENAI_API_KEY: "sk-***...***",
      GITHUB_TOKEN: "ghp_***...***",
      AWS_SECRET_ACCESS_KEY: "***...***",
      DATABASE_URL: "postgresql://app@db.example.com:5432/app",
      RANDOM_VAR: "should be stripped",
    });
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.ALL_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.RANDOM_VAR).toBeUndefined();
  });

  it("explicit extras always override the inherited env", async () => {
    const { createChildProcessEnv } = await import("../tools/lsp/env.js");
    const env = createChildProcessEnv(
      { PATH: "/custom/bin" },
      { PATH: "/usr/bin" },
    );
    expect(env.PATH).toBe("/custom/bin");
  });

  it("extras are added even when not in source env", async () => {
    const { createChildProcessEnv } = await import("../tools/lsp/env.js");
    const env = createChildProcessEnv(
      { MY_CUSTOM_VAR: "yes" },
      {},
    );
    expect(env.MY_CUSTOM_VAR).toBe("yes");
  });

  it("ignores non-string values in source", async () => {
    const { createChildProcessEnv } = await import("../tools/lsp/env.js");
    const env = createChildProcessEnv({}, {
      PATH: 12345 as any, // coerced to non-string at runtime
    });
    expect(env.PATH).toBeUndefined();
  });
});

describe("setupLsp (tools/lsp/index.ts) + createLspModule (hooks/lsp.ts)", () => {
  it("registers tools, returns the manager, and disposes it on session_shutdown", async () => {
    const { setupLsp } = await import("../tools/lsp/index.js");
    const { createLspModule } = await import("../hooks/lsp.js");
    const tools: string[] = [];
    const pi = {
      // Hard rule: a tool module never registers a hook.
      on: () => {
        throw new Error("setupLsp must not call pi.on()");
      },
      registerTool: (tool: any) => tools.push(tool.name),
    };

    // Spy on the manager to verify clearLanguageState is called on shutdown
    const managerMod = await import("../tools/lsp/manager.js");
    const originalClear = managerMod.LspServerManager.prototype.clearLanguageState;
    let clearCalls = 0;
    managerMod.LspServerManager.prototype.clearLanguageState = async function () {
      clearCalls++;
    };

    try {
      const manager = setupLsp(pi as any);
      expect([...tools].sort()).toEqual([
        "lsp_definition",
        "lsp_document_symbols",
        "lsp_references",
        "lsp_rename",
      ]);

      // Session lifecycle is the hook module's job.
      const module = createLspModule(manager);
      expect(module.name).toBe("lsp");
      const shutdown = module.hooks.session_shutdown![0];
      await shutdown({} as any, {} as any, pi as any);
      expect(clearCalls).toBe(1);
    } finally {
      managerMod.LspServerManager.prototype.clearLanguageState = originalClear;
    }
  });
});
