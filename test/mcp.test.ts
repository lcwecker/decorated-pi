/**
 * tools/mcp.ts — the MCP servers the pack hands to pi's built-in MCP
 * extension.
 *
 * The protocol, the connection lifecycle, the tool registration and /mcp all
 * live in pi; what is left here is the two server definitions, the project
 * gate on codegraph, the dependency-gate entries and the one-time migration
 * of the project server list. Nothing in this spec opens a connection.
 *
 * `which()` is mocked because dependency resolution is the only part that
 * reads the machine: the outcome has to be the same on a developer's box
 * (codegraph installed) as in CI (not installed). `node:fs` is mocked only to
 * arm a failing `writeFileSync` in the unwritable-directory case below.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../utils/which.js", () => ({ which: vi.fn(() => null) }));

/** Armed by the unwritable-directory spec; every other write goes through. */
const failedWrite = vi.hoisted(() => ({ armed: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (failedWrite.armed) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return actual.writeFileSync(...args);
    },
  };
});

import { which } from "../utils/which.js";
import { agentDirFile } from "./agent-dir.js";
import {
  CONTEXT7_BUILTIN,
  CONTEXT7_SERVER_NAME,
  CODEGRAPH_BUILTIN,
  CODEGRAPH_SERVER_NAME,
  hasCodegraphIndex,
  listMcpBinaryNames,
  registerBuiltinMcpServers,
  collectBuiltinMcpDependencyStatuses,
  migrateLegacyGlobalMcpConfig,
  migrateProjectMcpConfig,
} from "../tools/mcp.js";

function makeMockPi() {
  const registrations: Array<{ name: string; config: any }> = [];
  const pi = {
    registerMcpServer: (name: string, config: any) => registrations.push({ name, config }),
  };
  return { pi: pi as any, registrations };
}

const tempDirs: string[] = [];

/** A throwaway project directory; removed after each spec. */
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
  tempDirs.push(dir);
  return dir;
}

function initProject(withIndex: boolean): string {
  const dir = tmpProject();
  if (withIndex) fs.mkdirSync(path.join(dir, ".codegraph"));
  return dir;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

beforeEach(() => {
  vi.mocked(which).mockReturnValue(null);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("builtin server definitions", () => {
  it("context7 is a hosted HTTP server", () => {
    expect(CONTEXT7_BUILTIN).toEqual({
      type: "http",
      url: "https://mcp.context7.com/mcp",
      exposure: "direct",
    });
  });

  it("codegraph runs its CLI over stdio", () => {
    expect(CODEGRAPH_BUILTIN).toEqual({
      type: "stdio",
      command: "codegraph",
      args: ["serve", "--mcp"],
      exposure: "direct",
    });
  });

  it("declares both servers with direct exposure, so the model sees their tools", () => {
    // pi's default is codemode, where the tools are reachable only from
    // codemode scripts. The pack's two servers are meant to look like plain
    // tools, the way they did before the handover.
    expect(CONTEXT7_BUILTIN.exposure).toBe("direct");
    expect(CODEGRAPH_BUILTIN.exposure).toBe("direct");
  });

  it("listMcpBinaryNames reports the one server that needs a binary", () => {
    expect(listMcpBinaryNames()).toEqual(["codegraph"]);
  });
});

describe("codegraph project gate", () => {
  it("hasCodegraphIndex follows the .codegraph/ directory", () => {
    expect(hasCodegraphIndex(initProject(false))).toBe(false);
    expect(hasCodegraphIndex(initProject(true))).toBe(true);
  });

  it("registers context7 everywhere and codegraph only in an indexed project with its CLI", () => {
    vi.mocked(which).mockReturnValue("/usr/local/bin/codegraph");

    const bare = makeMockPi();
    registerBuiltinMcpServers(bare.pi, initProject(false));
    expect(bare.registrations.map((r) => r.name)).toEqual([CONTEXT7_SERVER_NAME]);

    const indexed = makeMockPi();
    registerBuiltinMcpServers(indexed.pi, initProject(true));
    expect(indexed.registrations).toEqual([
      { name: "context7", config: expect.objectContaining({ url: "https://mcp.context7.com/mcp" }) },
      {
        name: "codegraph",
        config: expect.objectContaining({
          command: "/usr/local/bin/codegraph",
          args: ["serve", "--mcp"],
        }),
      },
    ]);
  });

  it("registers nothing for an indexed project whose CLI is missing", () => {
    // Registering it anyway would list a server in /mcp whose spawn fails;
    // the dependency gate below is what tells the user to install it.
    const { pi, registrations } = makeMockPi();
    registerBuiltinMcpServers(pi, initProject(true));
    expect(registrations.map((r) => r.name)).toEqual([CONTEXT7_SERVER_NAME]);
  });

  it("registers the codegraph command a /dp-settings path resolves to", () => {
    vi.mocked(which).mockReturnValue("/opt/codegraph/bin/codegraph");
    const { pi, registrations } = makeMockPi();
    registerBuiltinMcpServers(pi, initProject(true));

    const codegraph = registrations.find((r) => r.name === CODEGRAPH_SERVER_NAME);
    expect(codegraph?.config.command).toBe("/opt/codegraph/bin/codegraph");
  });

  it("keeps loading when pi rejects a registration", () => {
    // A clash with another extension's server throws; the throw must not
    // escape the factory, because pi drops an extension whose factory throws.
    const pi = {
      registerMcpServer: () => {
        throw new Error("another extension registered \"context7\"");
      },
    };
    expect(() => registerBuiltinMcpServers(pi as any, initProject(true))).not.toThrow();
  });
});

describe("dependency gate entries", () => {
  it("reports nothing outside a codegraph project", () => {
    expect(collectBuiltinMcpDependencyStatuses(initProject(false))).toEqual([]);
  });

  it("reports the codegraph CLI as missing when it cannot be resolved", () => {
    expect(collectBuiltinMcpDependencyStatuses(initProject(true))).toEqual([
      {
        module: "mcp:codegraph",
        label: "codegraph",
        state: "missing",
        detail: "Install the codegraph CLI, or set its path with /dp-settings.",
        path: undefined,
      },
    ]);
  });

  it("reports the resolved path when the CLI is found", () => {
    vi.mocked(which).mockReturnValue("/opt/codegraph/bin/codegraph");
    expect(collectBuiltinMcpDependencyStatuses(initProject(true))).toEqual([
      {
        module: "mcp:codegraph",
        label: "codegraph",
        state: "ok",
        detail: "Install the codegraph CLI, or set its path with /dp-settings.",
        path: "/opt/codegraph/bin/codegraph",
      },
    ]);
  });
});

describe("project server-list migration", () => {
  it("moves legacy .pi/agent/mcp.json entries into .pi/mcp.json", () => {
    const cwd = initProject(true);
    writeJson(path.join(cwd, ".pi/agent/mcp.json"), {
      mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } },
      keep: 1,
    });

    migrateProjectMcpConfig(cwd);

    expect(JSON.parse(fs.readFileSync(path.join(cwd, ".pi/mcp.json"), "utf-8"))).toEqual({
      mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } },
    });
    // The legacy server keys are gone, so a second load is a no-op — every
    // other key in the file stays where it was.
    expect(JSON.parse(fs.readFileSync(path.join(cwd, ".pi/agent/mcp.json"), "utf-8"))).toEqual({
      keep: 1,
    });
    migrateProjectMcpConfig(cwd);
    expect(JSON.parse(fs.readFileSync(path.join(cwd, ".pi/mcp.json"), "utf-8"))).toEqual({
      mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } },
    });
  });

  it("keeps the entries the new file already defines", () => {
    const cwd = initProject(true);
    writeJson(path.join(cwd, ".pi/agent/mcp.json"), {
      mcpServers: {
        sentry: { url: "https://old.example/mcp" },
        linear: { url: "https://mcp.linear.app/mcp" },
      },
    });
    writeJson(path.join(cwd, ".pi/mcp.json"), {
      mcpServers: { sentry: { url: "https://new.example/mcp" } },
    });

    migrateProjectMcpConfig(cwd);

    expect(JSON.parse(fs.readFileSync(path.join(cwd, ".pi/mcp.json"), "utf-8"))).toEqual({
      mcpServers: {
        sentry: { url: "https://new.example/mcp" },
        linear: { url: "https://mcp.linear.app/mcp" },
      },
    });
  });

  it("reads the hyphenated legacy key too", () => {
    const cwd = initProject(true);
    writeJson(path.join(cwd, ".pi/agent/mcp.json"), {
      "mcp-servers": { sentry: { url: "https://mcp.sentry.dev/mcp" } },
    });

    migrateProjectMcpConfig(cwd);

    expect(JSON.parse(fs.readFileSync(path.join(cwd, ".pi/mcp.json"), "utf-8"))).toEqual({
      mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } },
    });
    expect(JSON.parse(fs.readFileSync(path.join(cwd, ".pi/agent/mcp.json"), "utf-8"))).toEqual({});
  });

  it("stays out of the way of an empty server list", () => {
    const cwd = initProject(true);
    writeJson(path.join(cwd, ".pi/agent/mcp.json"), { mcpServers: {}, keep: 1 });

    migrateProjectMcpConfig(cwd);

    // No servers to move: the new file is not even created.
    expect(fs.existsSync(path.join(cwd, ".pi/mcp.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(cwd, ".pi/agent/mcp.json"), "utf-8"))).toEqual({
      mcpServers: {},
      keep: 1,
    });
  });

  it("leaves a legacy file it cannot parse alone", () => {
    const cwd = initProject(true);
    const legacy = path.join(cwd, ".pi/agent/mcp.json");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, "{ not json", "utf-8");

    expect(() => migrateProjectMcpConfig(cwd)).not.toThrow();

    expect(fs.existsSync(path.join(cwd, ".pi/mcp.json"))).toBe(false);
    expect(fs.readFileSync(legacy, "utf-8")).toBe("{ not json");
  });

  it("rebuilds a new file whose server map is not a map", () => {
    const cwd = initProject(true);
    writeJson(path.join(cwd, ".pi/agent/mcp.json"), {
      mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } },
    });
    writeJson(path.join(cwd, ".pi/mcp.json"), { mcpServers: "not-a-map" });

    migrateProjectMcpConfig(cwd);

    expect(JSON.parse(fs.readFileSync(path.join(cwd, ".pi/mcp.json"), "utf-8"))).toEqual({
      mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } },
    });
  });

  it("leaves a new file that is not an object alone", () => {
    const cwd = initProject(true);
    const legacyServers = { sentry: { url: "https://mcp.sentry.dev/mcp" } };
    writeJson(path.join(cwd, ".pi/agent/mcp.json"), { mcpServers: legacyServers });
    writeJson(path.join(cwd, ".pi/mcp.json"), []);

    migrateProjectMcpConfig(cwd);

    // Nothing is written and nothing is lost: the legacy entries stay where
    // they are for a user to move by hand.
    expect(JSON.parse(fs.readFileSync(path.join(cwd, ".pi/mcp.json"), "utf-8"))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(cwd, ".pi/agent/mcp.json"), "utf-8"))).toEqual({
      mcpServers: legacyServers,
    });
  });

  it("stays out of pi's own global server list", () => {
    // pi resolves its global config through the agent dir, which can sit inside
    // the project — launching from the home directory is exactly that case, and
    // migrating there would hand the user's global servers to one directory.
    const cwd = initProject(true);
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(cwd, ".pi/agent");
    try {
      writeJson(path.join(cwd, ".pi/agent/mcp.json"), {
        mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } },
      });

      migrateProjectMcpConfig(cwd);

      expect(fs.existsSync(path.join(cwd, ".pi/mcp.json"))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(cwd, ".pi/agent/mcp.json"), "utf-8"))).toEqual({
        mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } },
      });
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
  it("leaves a corrupt new file untouched", () => {
    const cwd = initProject(true);
    writeJson(path.join(cwd, ".pi/agent/mcp.json"), {
      mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } },
    });
    fs.writeFileSync(path.join(cwd, ".pi/mcp.json"), "{ not json", "utf-8");

    migrateProjectMcpConfig(cwd);

    expect(fs.readFileSync(path.join(cwd, ".pi/mcp.json"), "utf-8")).toBe("{ not json");
    // The legacy entry stays put too, so a fixed file migrates later.
    expect(
      JSON.parse(fs.readFileSync(path.join(cwd, ".pi/agent/mcp.json"), "utf-8")),
    ).toEqual({ mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } } });
  });

  it("does nothing without a legacy file or legacy entries", () => {
    const cwd = initProject(true);

    migrateProjectMcpConfig(cwd);
    expect(fs.existsSync(path.join(cwd, ".pi/mcp.json"))).toBe(false);

    writeJson(path.join(cwd, ".pi/agent/mcp.json"), { dependencies: {} });
    migrateProjectMcpConfig(cwd);
    expect(fs.existsSync(path.join(cwd, ".pi/mcp.json"))).toBe(false);
  });

  it("does not throw when the new list cannot be written", () => {
    // The migration runs while the extension factory loads, and pi drops an
    // extension whose factory throws. A failed write has to leave the legacy
    // list alone so the next load retries it.
    const cwd = initProject(true);
    writeJson(path.join(cwd, ".pi/agent/mcp.json"), {
      mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } },
    });
    failedWrite.armed = true;
    try {
      expect(() => migrateProjectMcpConfig(cwd)).not.toThrow();
    } finally {
      failedWrite.armed = false;
    }

    expect(fs.existsSync(path.join(cwd, ".pi/mcp.json"))).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(cwd, ".pi/agent/mcp.json"), "utf-8")),
    ).toEqual({ mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } } });
  });
});

describe("global server-list migration", () => {
  it("moves servers out of the pack's own settings file", () => {
    writeJson(agentDirFile("decorated-pi.json"), {
      mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } },
      modules: { hooks: { wakatime: false } },
    });

    migrateLegacyGlobalMcpConfig();

    expect(JSON.parse(fs.readFileSync(agentDirFile("mcp.json"), "utf-8"))).toEqual({
      mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } },
    });
    // The pack's settings file keeps everything else, so a second load is a
    // no-op and the user's other configuration is untouched.
    expect(JSON.parse(fs.readFileSync(agentDirFile("decorated-pi.json"), "utf-8"))).toEqual({
      modules: { hooks: { wakatime: false } },
    });
    migrateLegacyGlobalMcpConfig();
    expect(JSON.parse(fs.readFileSync(agentDirFile("mcp.json"), "utf-8"))).toEqual({
      mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } },
    });
  });

  it("keeps the servers pi's own file already defines", () => {
    writeJson(agentDirFile("decorated-pi.json"), {
      mcpServers: { sentry: { url: "https://old.example/mcp" } },
    });
    writeJson(agentDirFile("mcp.json"), {
      mcpServers: { sentry: { url: "https://new.example/mcp" } },
    });

    migrateLegacyGlobalMcpConfig();

    expect(JSON.parse(fs.readFileSync(agentDirFile("mcp.json"), "utf-8"))).toEqual({
      mcpServers: { sentry: { url: "https://new.example/mcp" } },
    });
  });
});
