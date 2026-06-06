/**
 * End-to-end integration smoke test for codegraph.
 * Validates the full chain: dp-settings → module flag → guidance → MCP broker.
 *
 * Uses `process.cwd()` so the test works regardless of where the
 * decorated-pi repo is checked out. Each test sets a deterministic
 * module state via `setModuleEnabled` and restores it in `afterEach`.
 *
 * The global `mcpServers.codegraph` entry in the user's
 * `~/.pi/agent/decorated-pi.json` would override the builtin codegraph
 * entry with `source: "global"` and a user-controlled `enabled` flag,
 * polluting these tests. We snapshot+strip `mcpServers` in `beforeEach`
 * and restore it in `afterEach` so the suite is independent of the
 * user's actual config.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isModuleEnabled, setModuleEnabled, getAllModuleSettings } from "../settings.js";
import { resolveMcpConfigs, BUILTIN_MCP_SERVERS } from "../tools/mcp/config.js";

const PROJECT_CWD = process.cwd();
const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "decorated-pi.json");

describe.sequential("codegraph end-to-end integration", () => {
  let prevModuleState: boolean | undefined;
  let prevConfigRaw: string | null = null;
  let hadConfig = false;

  beforeEach(() => {
    prevModuleState = getAllModuleSettings().codegraph;
    // Snapshot and strip `mcpServers` from the global config so it
    // doesn't override the builtin codegraph entry.
    if (fs.existsSync(CONFIG_FILE)) {
      hadConfig = true;
      prevConfigRaw = fs.readFileSync(CONFIG_FILE, "utf-8");
      const parsed = JSON.parse(prevConfigRaw);
      delete parsed.mcpServers;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    } else {
      hadConfig = false;
      prevConfigRaw = null;
    }
  });
  afterEach(() => {
    if (hadConfig && prevConfigRaw !== null) {
      fs.writeFileSync(CONFIG_FILE, prevConfigRaw, "utf-8");
    }
    setModuleEnabled("codegraph", prevModuleState ?? false);
  });

  it("module flag reads from dp-settings (set ON for this test)", () => {
    setModuleEnabled("codegraph", true);
    expect(isModuleEnabled("codegraph")).toBe(true);
  });

  it("BUILTIN_MCP_SERVERS has the codegraph entry", () => {
    const entry = BUILTIN_MCP_SERVERS.find((s) => s.name === "codegraph");
    expect(entry).toBeDefined();
    expect(entry?.command).toBe("codegraph");
    expect(entry?.args).toEqual(["serve", "--mcp"]);
  });

  it("resolveMcpConfigs returns the codegraph server enabled when module is on", () => {
    setModuleEnabled("codegraph", true);
    const resolved = resolveMcpConfigs(PROJECT_CWD);
    const codegraph = resolved.find((s) => s.name === "codegraph");
    expect(codegraph).toBeDefined();
    expect(codegraph?.enabled).toBe(true);
    expect(codegraph?.source).toBe("builtin");
  });

  it("resolveMcpConfigs disables codegraph when module is off", () => {
    setModuleEnabled("codegraph", false);
    const resolved = resolveMcpConfigs(PROJECT_CWD);
    const codegraph = resolved.find((s) => s.name === "codegraph");
    expect(codegraph).toBeDefined();
    expect(codegraph?.enabled).toBe(false);
  });

  it("slash command is not registered", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "../commands/dp-model.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/registerCommand\(\s*"codegraph"/);
    expect(src).not.toMatch(/setupCodegraphCommand\(/);
  });

  it("system prompt has ### CodeGraph section, injected conditionally", () => {
    // Guidance now lives in tools/mcp/builtin/codegraph.ts and is
    // pushed into the guidelines array in index.ts when codegraph is enabled.
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "../tools/mcp/builtin/codegraph.ts"),
      "utf-8",
    );
    expect(src).toMatch(/codegraph_[\`*]?\*?[\`*]? MCP tools are enabled/);
    expect(src).toMatch(/codegraph_explore/);
    expect(src).toMatch(/codegraph_impact/);
  });
});
