/**
 * End-to-end integration smoke test for codegraph.
 * Validates the full chain: dp-settings → module flag → guidance → MCP broker.
 *
 * Uses `process.cwd()` so the test works regardless of where the
 * decorated-pi repo is checked out. Each test sets a deterministic
 * module state via `setModuleEnabled` and restores it in `afterEach`,
 * so the suite is independent of the user's actual `~/.pi/agent/`
 * config.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isModuleEnabled, setModuleEnabled, getAllModuleSettings } from "../extensions/settings.js";
import { resolveMcpConfigs, BUILTIN_MCP_SERVERS } from "../extensions/mcp/builtin.js";

const PROJECT_CWD = process.cwd();

describe.sequential("codegraph end-to-end integration", () => {
  let prevModuleState: boolean | undefined;

  beforeEach(() => {
    prevModuleState = getAllModuleSettings().codegraph;
  });
  afterEach(() => {
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
      path.join(import.meta.dirname, "../extensions/slash.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/registerCommand\(\s*"codegraph"/);
    expect(src).not.toMatch(/setupCodegraphCommand\(/);
  });

  it("system prompt has ### CodeGraph section, injected conditionally", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "../extensions/index.ts"),
      "utf-8",
    );
    expect(src).toMatch(/###\s+CodeGraph/);
    expect(src).toMatch(/isCodegraphActive\(\)/);
  });
});
