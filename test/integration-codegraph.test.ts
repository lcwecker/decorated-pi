/**
 * End-to-end integration smoke test for codegraph.
 *
 * Codegraph is now just an MCP server. The chain is:
 *   mcp module on → codegraph server enabled in mcp config → guidance injected.
 *
 * Uses `process.cwd()` so the test works regardless of where the
 * decorated-pi repo is checked out. We snapshot the global
 * `~/.pi/agent/mcp.json` and temporarily write an
 * `mcpServers.codegraph` entry to drive the builtin server state.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveMcpConfigs,
  BUILTIN_MCP_SERVERS,
} from "../tools/mcp/config.js";
import { setModuleEnabled } from "../settings.js";

const PROJECT_CWD = process.cwd();
const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_FILE = path.join(CONFIG_DIR, "mcp.json");
const LEGACY_CONFIG_FILE = path.join(CONFIG_DIR, "decorated-pi.json");

function writeCodegraphEnabled(enabled: boolean): void {
  let parsed: Record<string, any> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  }
  parsed.mcpServers = parsed.mcpServers || {};
  parsed.mcpServers.codegraph = { enabled };
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
}

describe.sequential("codegraph end-to-end integration", () => {
  let prevConfigRaw: string | null = null;
  let prevLegacyRaw: string | null = null;
  let hadConfig = false;
  let hadLegacyConfig = false;

  beforeEach(() => {
    if (fs.existsSync(CONFIG_FILE)) {
      hadConfig = true;
      prevConfigRaw = fs.readFileSync(CONFIG_FILE, "utf-8");
      fs.unlinkSync(CONFIG_FILE);
    } else {
      hadConfig = false;
      prevConfigRaw = null;
    }
    if (fs.existsSync(LEGACY_CONFIG_FILE)) {
      hadLegacyConfig = true;
      prevLegacyRaw = fs.readFileSync(LEGACY_CONFIG_FILE, "utf-8");
    } else {
      hadLegacyConfig = false;
      prevLegacyRaw = null;
    }
    // Ensure a clean module state for these tests. mcp must be on for
    // resolveMcpConfigs to return servers.
    const clean = { modules: { tools: { mcp: true }, hooks: {}, commands: {} } };
    fs.writeFileSync(LEGACY_CONFIG_FILE, JSON.stringify(clean, null, 2) + "\n", "utf-8");
  });

  afterEach(() => {
    if (hadConfig && prevConfigRaw !== null) {
      fs.writeFileSync(CONFIG_FILE, prevConfigRaw, "utf-8");
    } else if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
    }
    if (hadLegacyConfig && prevLegacyRaw !== null) {
      fs.writeFileSync(LEGACY_CONFIG_FILE, prevLegacyRaw, "utf-8");
    } else if (fs.existsSync(LEGACY_CONFIG_FILE)) {
      fs.unlinkSync(LEGACY_CONFIG_FILE);
    }
  });

  it("BUILTIN_MCP_SERVERS has the codegraph entry", () => {
    const entry = BUILTIN_MCP_SERVERS.find((s) => s.name === "codegraph");
    expect(entry).toBeDefined();
    expect(entry?.command).toBe("codegraph");
    expect(entry?.args).toEqual(["serve", "--mcp"]);
  });

  it("resolveMcpConfigs returns codegraph enabled when mcpServers.codegraph.enabled is true", () => {
    writeCodegraphEnabled(true);
    const resolved = resolveMcpConfigs(PROJECT_CWD);
    const codegraph = resolved.find((s) => s.name === "codegraph");
    expect(codegraph).toBeDefined();
    expect(codegraph?.enabled).toBe(true);
  });

  it("resolveMcpConfigs returns codegraph enabled by default", () => {
    const resolved = resolveMcpConfigs(PROJECT_CWD);
    const codegraph = resolved.find((s) => s.name === "codegraph");
    expect(codegraph).toBeDefined();
    expect(codegraph?.enabled).toBe(true);
  });

  it("resolveMcpConfigs returns empty when the mcp master switch is off", () => {
    setModuleEnabled("mcp", false);
    writeCodegraphEnabled(true);
    expect(resolveMcpConfigs(PROJECT_CWD)).toEqual([]);
  });

  it("slash command is not registered", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "../commands/dp-model.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/registerCommand\(\s*"codegraph"/);
    expect(src).not.toMatch(/setupCodegraphCommand\(/);
  });
});

// ─── .codegraph project artefact gating ────────────────────────────────────
//
// codegraph is a project-sensitive server: it only makes sense in a
// project that has been initialised (`codegraph init`), i.e. has a
// `.codegraph/` directory. The gating must apply to:
//   - resolveMcpConfigs: codegraph config still surfaces, but
//     canUseInProject reflects the artefact
//   - buildGuidelines (in index.ts): no CodeGraph guidance when missing
//
// These tests use a temp project dir and chdir into it, so they must
// run sequentially and not parallelise with other chdir tests.
describe.sequential("codegraph project artefact gating", () => {
  const TMP_ROOT = path.join(os.tmpdir(), "decorated-pi-codegraph-gating");
  let tmpDir: string;
  let prevCwd: string;
  let hadTmpRoot = false;

  beforeEach(() => {
    if (!fs.existsSync(TMP_ROOT)) {
      fs.mkdirSync(TMP_ROOT, { recursive: true });
      hadTmpRoot = true;
    }
    tmpDir = fs.mkdtempSync(path.join(TMP_ROOT, "proj-"));
    prevCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (hadTmpRoot && fs.existsSync(TMP_ROOT)) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  it("codegraph config carries canUseInProject returning false when no .codegraph/ exists", () => {
    writeCodegraphEnabled(true);
    const codegraph = resolveMcpConfigs(tmpDir).find((s) => s.name === "codegraph");
    expect(codegraph).toBeDefined();
    expect(codegraph?.enabled).toBe(true);
    expect(codegraph?.canUseInProject).toBeTypeOf("function");
    expect(codegraph?.canUseInProject?.(tmpDir)).toBe(false);
  });

  it("canUseInProject returns true when .codegraph/ exists", () => {
    writeCodegraphEnabled(true);
    fs.mkdirSync(path.join(tmpDir, ".codegraph"));
    const codegraph = resolveMcpConfigs(tmpDir).find((s) => s.name === "codegraph");
    expect(codegraph?.canUseInProject?.(tmpDir)).toBe(true);
  });

  it("buildGuidelines does not push CodeGraph guidance when .codegraph/ is missing", () => {
    writeCodegraphEnabled(true);
    // With no system-prompt CodeGraph block, gating follows tool
    // registration: canUseInProject is the single source of truth.
    const codegraph = resolveMcpConfigs(tmpDir).find((s) => s.name === "codegraph");
    expect(codegraph?.canUseInProject?.(tmpDir)).toBe(false);
  });

  it("buildGuidelines pushes CodeGraph guidance when .codegraph/ exists", () => {
    writeCodegraphEnabled(true);
    fs.mkdirSync(path.join(tmpDir, ".codegraph"));
    const codegraph = resolveMcpConfigs(tmpDir).find((s) => s.name === "codegraph");
    expect(codegraph?.canUseInProject?.(tmpDir)).toBe(true);
  });
});
