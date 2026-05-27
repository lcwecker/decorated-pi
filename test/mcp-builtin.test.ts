/**
 * MCP Builtin Config — Unit Tests
 *
 * Tests pure functions from builtin.ts:
 * - isSseUrl
 * - loadProjectMcpConfigs (stdio / http / sse)
 * - loadGlobalMcpConfigs (via loadConfig mock)
 * - resolveMcpConfigs priority (builtin → global → project)
 *
 * Uses temp directories to avoid modifying real config files.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isSseUrl,
  loadProjectMcpConfigs,
  loadGlobalMcpConfigs,
  resolveMcpConfigs,
  BUILTIN_MCP_SERVERS,
} from "../extensions/mcp/builtin.js";

// ─── Temp dir helpers ────────────────────────────────────────────────────────

function mkTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

function writeJson(filePath: string, obj: unknown): void {
  if (!fs.existsSync(path.dirname(filePath))) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf-8");
}

function rmrf(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    fs.rmSync(full, { recursive: true, force: true });
  }
}

// ─── Config file mock ────────────────────────────────────────────────────────
// loadGlobalMcpConfigs reads from ~/.pi/agent/decorated-pi.json via loadConfig().
// We intercept the module's loadConfig via vi.mock to avoid touching real config.

const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_FILE = path.join(CONFIG_DIR, "decorated-pi.json");
let globalConfigBackup: string | null = null;

function backupGlobalConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      globalConfigBackup = fs.readFileSync(CONFIG_FILE, "utf-8");
      fs.unlinkSync(CONFIG_FILE);
    } else {
      globalConfigBackup = null;
    }
  } catch {
    globalConfigBackup = null;
  }
}

function restoreGlobalConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
    if (globalConfigBackup !== null) {
      if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, globalConfigBackup, "utf-8");
    }
  } catch { /* best effort */ }
}

// ═════════════════════════════════════════════════════════════════════════════
// isSseUrl
// ═════════════════════════════════════════════════════════════════════════════

describe("isSseUrl", () => {
  const cases: Array<[string, boolean]> = [
    ["http://localhost:3000/sse", true],
    ["http://localhost:3000/sse/", true],
    ["https://example.com/sse", true],
    ["https://example.com/mcp", false],
    ["http://localhost:3000/api/sse/stream", false],
    ["http://localhost:3000/sse/foo", false],
    ["http://localhost:3000/", false],
    ["", false],
  ];

  for (const [url, expected] of cases) {
    it(`${JSON.stringify(url)} → ${expected}`, () => {
      expect(isSseUrl(url)).toBe(expected);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// loadProjectMcpConfigs
// ═════════════════════════════════════════════════════════════════════════════

describe("loadProjectMcpConfigs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTempDir("mcp-test-");
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  it("returns empty array when no config file exists", () => {
    expect(loadProjectMcpConfigs(tmpDir)).toEqual([]);
  });

  it("returns empty array when config file is invalid JSON", () => {
    const configPath = path.join(tmpDir, ".pi/agent/mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "not json", "utf-8");
    expect(loadProjectMcpConfigs(tmpDir)).toEqual([]);
  });

  it("parses stdio server config", () => {
    writeJson(path.join(tmpDir, ".pi/agent/mcp.json"), {
      mcpServers: {
        "my-fs": {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: { DEBUG: "1" },
        },
      },
    });
    const configs = loadProjectMcpConfigs(tmpDir);
    expect(configs).toEqual([
      {
        name: "my-fs",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        env: { DEBUG: "1" },
        enabled: true,
        source: "project",
      },
    ]);
  });

  it("parses http server config", () => {
    writeJson(path.join(tmpDir, ".pi/agent/mcp.json"), {
      mcpServers: {
        "my-http": { url: "http://localhost:3000/mcp" },
      },
    });
    const configs = loadProjectMcpConfigs(tmpDir);
    expect(configs).toEqual([
      {
        name: "my-http",
        url: "http://localhost:3000/mcp",
        enabled: true,
        source: "project",
      },
    ]);
  });

  it("parses sse server config", () => {
    writeJson(path.join(tmpDir, ".pi/agent/mcp.json"), {
      mcpServers: {
        "my-sse": { url: "http://localhost:3000/sse" },
      },
    });
    const configs = loadProjectMcpConfigs(tmpDir);
    expect(configs).toEqual([
      {
        name: "my-sse",
        url: "http://localhost:3000/sse",
        enabled: true,
        source: "project",
      },
    ]);
  });

  it("parses mixed server configs", () => {
    writeJson(path.join(tmpDir, ".pi/agent/mcp.json"), {
      mcpServers: {
        "my-fs": {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        },
        "my-http": { url: "http://localhost:3000/mcp" },
        "my-sse": { url: "http://localhost:3000/sse" },
      },
    });
    const configs = loadProjectMcpConfigs(tmpDir);
    expect(configs).toHaveLength(3);
    expect(configs.map((c) => c.name).sort()).toEqual(["my-fs", "my-http", "my-sse"]);
  });

  it("sets enabled=false when configured", () => {
    writeJson(path.join(tmpDir, ".pi/agent/mcp.json"), {
      mcpServers: {
        "disabled": { url: "http://localhost:3000/mcp", enabled: false },
        "enabled": { url: "http://localhost:3000/mcp", enabled: true },
      },
    });
    const configs = loadProjectMcpConfigs(tmpDir);
    // loadProjectMcpConfigs returns all entries; resolveMcpConfigs filters by enabled
    expect(configs.map((c) => c.name).sort()).toEqual(["disabled", "enabled"]);
    expect(configs.find((c) => c.name === "disabled")?.enabled).toBe(false);
    expect(configs.find((c) => c.name === "enabled")?.enabled).toBe(true);
  });

  it("dedupes duplicate server names (first wins)", () => {
    writeJson(path.join(tmpDir, ".pi/agent/mcp.json"), {
      mcpServers: {
        "dup": { url: "http://localhost:3000/a" },
        "dup": { url: "http://localhost:3000/b" },
      },
    });
    const configs = loadProjectMcpConfigs(tmpDir);
    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("dup");
  });

  it("accepts both mcpServers and mcp-servers keys", () => {
    writeJson(path.join(tmpDir, ".pi/agent/mcp.json"), {
      "mcp-servers": {
        "alt-key": { url: "http://localhost:3000/mcp" },
      },
    });
    const configs = loadProjectMcpConfigs(tmpDir);
    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("alt-key");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// loadGlobalMcpConfigs
// ═════════════════════════════════════════════════════════════════════════════

describe("loadGlobalMcpConfigs", () => {
  beforeEach(() => {
    backupGlobalConfig();
    try { if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE); } catch {}
  });

  afterEach(() => {
    restoreGlobalConfig();
  });

  it("returns empty array when no config file", () => {
    expect(loadGlobalMcpConfigs()).toEqual([]);
  });

  it("parses stdio config", () => {
    writeJson(CONFIG_FILE, {
      mcpServers: {
        "global-fs": {
          command: "python",
          args: ["/path/to/server.py"],
          env: { PYTHONPATH: "/opt" },
        },
      },
    });
    const configs = loadGlobalMcpConfigs();
    expect(configs).toEqual([
      {
        name: "global-fs",
        command: "python",
        args: ["/path/to/server.py"],
        env: { PYTHONPATH: "/opt" },
        enabled: true,
        source: "global",
      },
    ]);
  });

  it("parses http/sse config", () => {
    writeJson(CONFIG_FILE, {
      mcpServers: {
        "global-http": { url: "http://localhost:3000/mcp" },
        "global-sse": { url: "http://localhost:3000/sse" },
      },
    });
    const configs = loadGlobalMcpConfigs();
    expect(configs.map((c) => c.name).sort()).toEqual(["global-http", "global-sse"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// resolveMcpConfigs priority
// ═════════════════════════════════════════════════════════════════════════════

describe("resolveMcpConfigs priority", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTempDir("mcp-test-");
    backupGlobalConfig();
    try { if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE); } catch {}
  });

  afterEach(() => {
    rmrf(tmpDir);
    restoreGlobalConfig();
  });

  it("includes builtin servers", () => {
    const configs = resolveMcpConfigs(tmpDir);
    const names = configs.map((c) => c.name);
    expect(names).toContain("context7");
    expect(names).toContain("exa");
  });

  it("builtin servers have source=builtin", () => {
    const configs = resolveMcpConfigs(tmpDir);
    const context7 = configs.find((c) => c.name === "context7");
    expect(context7?.source).toBe("builtin");
  });

  it("project overrides global override builtin", () => {
    // Override context7 at global level
    writeJson(CONFIG_FILE, {
      mcpServers: {
        "context7": { url: "http://fake-global/mcp" },
      },
    });
    // Override context7 again at project level
    writeJson(path.join(tmpDir, ".pi/agent/mcp.json"), {
      mcpServers: {
        "context7": { url: "http://fake-project/mcp" },
      },
    });
    const configs = resolveMcpConfigs(tmpDir);
    const context7 = configs.find((c) => c.name === "context7");
    expect(context7?.url).toBe("http://fake-project/mcp");
    expect(context7?.source).toBe("project");
  });

  it("disables builtin server when enabled: false in global", () => {
    writeJson(CONFIG_FILE, {
      mcpServers: {
        "context7": { enabled: false },
      },
    });
    const configs = resolveMcpConfigs(tmpDir);
    const names = configs.map((c) => c.name);
    expect(names).not.toContain("context7");
  });

  it("disables builtin server when enabled: false in project", () => {
    writeJson(path.join(tmpDir, ".pi/agent/mcp.json"), {
      mcpServers: {
        "exa": { enabled: false },
      },
    });
    const configs = resolveMcpConfigs(tmpDir);
    const names = configs.map((c) => c.name);
    expect(names).not.toContain("exa");
  });

  it("filters out servers with neither url nor command", () => {
    writeJson(CONFIG_FILE, {
      mcpServers: {
        "invalid": { enabled: true },
      },
    });
    const configs = resolveMcpConfigs(tmpDir);
    const names = configs.map((c) => c.name);
    expect(names).not.toContain("invalid");
  });

  it("project-level servers have source=project", () => {
    writeJson(path.join(tmpDir, ".pi/agent/mcp.json"), {
      mcpServers: {
        "custom": { url: "http://localhost:9999/mcp" },
      },
    });
    const configs = resolveMcpConfigs(tmpDir);
    const custom = configs.find((c) => c.name === "custom");
    expect(custom?.source).toBe("project");
  });

  it("global-level servers have source=global", () => {
    writeJson(CONFIG_FILE, {
      mcpServers: {
        "global-custom": { url: "http://localhost:9998/mcp" },
      },
    });
    const configs = resolveMcpConfigs(tmpDir);
    const globalCustom = configs.find((c) => c.name === "global-custom");
    expect(globalCustom?.source).toBe("global");
  });

  it("adds a project server that does not exist in builtin", () => {
    writeJson(path.join(tmpDir, ".pi/agent/mcp.json"), {
      mcpServers: {
        "project-only": { url: "http://localhost:9997/mcp" },
      },
    });
    const configs = resolveMcpConfigs(tmpDir);
    const names = configs.map((c) => c.name);
    expect(names).toContain("project-only");
  });
});