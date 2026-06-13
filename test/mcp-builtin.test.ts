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
  toggleMcpServerEnabled,
  migrateLegacyGlobalMcpConfig,
  BUILTIN_MCP_SERVERS,
} from "../tools/mcp/config.js";
import {
  loadMcpCache,
  saveMcpCache,
  updateServerCache,
  cleanupStaleCache,
  type McpCache,
} from "../tools/mcp/cache.js";

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
// loadGlobalMcpConfigs reads from ~/.pi/agent/mcp.json.
// We backup/restore the real file around each test.

const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_FILE = path.join(CONFIG_DIR, "mcp.json");
const LEGACY_CONFIG_FILE = path.join(CONFIG_DIR, "decorated-pi.json");
let globalConfigBackup: string | null = null;
let legacyConfigBackup: string | null = null;

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
  try {
    if (fs.existsSync(LEGACY_CONFIG_FILE)) {
      legacyConfigBackup = fs.readFileSync(LEGACY_CONFIG_FILE, "utf-8");
      fs.unlinkSync(LEGACY_CONFIG_FILE);
    } else {
      legacyConfigBackup = null;
    }
  } catch {
    legacyConfigBackup = null;
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
  try {
    if (fs.existsSync(LEGACY_CONFIG_FILE)) fs.unlinkSync(LEGACY_CONFIG_FILE);
    if (legacyConfigBackup !== null) {
      if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(LEGACY_CONFIG_FILE, legacyConfigBackup, "utf-8");
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

  it("dedupes duplicate server names (last JSON key wins before load)", () => {
    fs.mkdirSync(path.join(tmpDir, ".pi/agent"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".pi/agent/mcp.json"),
      '{"mcpServers":{"dup":{"url":"http://localhost:3000/a"},"dup":{"url":"http://localhost:3000/b"}}}',
      "utf-8",
    );
    const configs = loadProjectMcpConfigs(tmpDir);
    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("dup");
    expect(configs[0].url).toBe("http://localhost:3000/b");
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

  it("migrates legacy config from decorated-pi.json", () => {
    // Ensure the new file does not exist and the legacy file has mcpServers.
    if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
    const legacy = { modules: { mcp: true }, mcpServers: { "legacy-server": { url: "http://legacy/mcp" } } };
    writeJson(LEGACY_CONFIG_FILE, legacy);

    migrateLegacyGlobalMcpConfig();

    // New file created
    expect(fs.existsSync(CONFIG_FILE)).toBe(true);
    const migrated = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    expect(migrated.mcpServers["legacy-server"].url).toBe("http://legacy/mcp");

    // Legacy file cleaned
    const cleaned = JSON.parse(fs.readFileSync(LEGACY_CONFIG_FILE, "utf-8"));
    expect(cleaned.mcpServers).toBeUndefined();
    expect(cleaned.modules?.mcp).toBe(true);
  });

  it("does not overwrite existing same-named entries in mcp.json", () => {
    // Pre-populate mcp.json with a "shared" server.
    writeJson(CONFIG_FILE, {
      mcpServers: {
        shared: { url: "http://new-version/mcp", enabled: true },
      },
    });
    // Legacy has both "shared" and "new-from-legacy".
    const legacy = {
      mcpServers: {
        shared: { url: "http://old-version/mcp", enabled: false },
        "new-from-legacy": { url: "http://legacy/mcp" },
      },
    };
    writeJson(LEGACY_CONFIG_FILE, legacy);

    migrateLegacyGlobalMcpConfig();

    const migrated = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    // "shared" keeps the new file's version
    expect(migrated.mcpServers["shared"].url).toBe("http://new-version/mcp");
    expect(migrated.mcpServers["shared"].enabled).toBe(true);
    // "new-from-legacy" is added
    expect(migrated.mcpServers["new-from-legacy"].url).toBe("http://legacy/mcp");
  });

  it("is a no-op when legacy has no mcpServers", () => {
    if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
    writeJson(LEGACY_CONFIG_FILE, { modules: { mcp: true } });

    migrateLegacyGlobalMcpConfig();

    expect(fs.existsSync(CONFIG_FILE)).toBe(false);
    const legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG_FILE, "utf-8"));
    expect(legacy.modules?.mcp).toBe(true);
  });

  it("is a no-op when legacy mcpServers is empty", () => {
    if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
    writeJson(LEGACY_CONFIG_FILE, { mcpServers: {} });

    migrateLegacyGlobalMcpConfig();

    expect(fs.existsSync(CONFIG_FILE)).toBe(false);
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

  it("marks builtin server as disabled when enabled: false in global", () => {
    writeJson(CONFIG_FILE, {
      mcpServers: {
        "context7": { enabled: false },
      },
    });
    const configs = resolveMcpConfigs(tmpDir);
    const context7 = configs.find((c) => c.name === "context7");
    expect(context7).toBeDefined();
    expect(context7!.enabled).toBe(false);
  });

  it("marks builtin server as disabled when enabled: false in project", () => {
    writeJson(path.join(tmpDir, ".pi/agent/mcp.json"), {
      mcpServers: {
        "exa": { enabled: false },
      },
    });
    const configs = resolveMcpConfigs(tmpDir);
    const exa = configs.find((c) => c.name === "exa");
    expect(exa).toBeDefined();
    expect(exa!.enabled).toBe(false);
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

  it("preserves builtin url when global config only sets enabled", () => {
    writeJson(CONFIG_FILE, {
      mcpServers: {
        "context7": { enabled: true },
      },
    });
    const configs = resolveMcpConfigs(tmpDir);
    const context7 = configs.find((c) => c.name === "context7");
    expect(context7?.url).toBe("https://mcp.context7.com/mcp");
  });

  it("preserves builtin url when project config only sets enabled", () => {
    writeJson(path.join(tmpDir, ".pi/agent/mcp.json"), {
      mcpServers: {
        "exa": { enabled: true },
      },
    });
    const configs = resolveMcpConfigs(tmpDir);
    const exa = configs.find((c) => c.name === "exa");
    expect(exa?.url).toBe("https://mcp.exa.ai/mcp");
  });

  it("preserves builtin description when global config only sets url", () => {
    writeJson(CONFIG_FILE, {
      mcpServers: {
        "context7": { url: "http://custom/mcp" },
      },
    });
    const configs = resolveMcpConfigs(tmpDir);
    const context7 = configs.find((c) => c.name === "context7");
    expect(context7?.url).toBe("http://custom/mcp");
  });

  it("project config overrides global config for same server", () => {
    writeJson(CONFIG_FILE, {
      mcpServers: {
        "context7": { url: "http://global/mcp" },
      },
    });
    writeJson(path.join(tmpDir, ".pi/agent/mcp.json"), {
      mcpServers: {
        "context7": { url: "http://project/mcp" },
      },
    });
    const configs = resolveMcpConfigs(tmpDir);
    const context7 = configs.find((c) => c.name === "context7");
    expect(context7?.url).toBe("http://project/mcp");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// loadMcpCache
// ═════════════════════════════════════════════════════════════════════════════

describe("loadMcpCache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTempDir("mcp-cache-");
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  it("global cache overrides builtin for same server", () => {
    const globalCachePath = path.join(os.homedir(), ".pi/agent/mcp-cache.json");
    const backup = fs.existsSync(globalCachePath) ? fs.readFileSync(globalCachePath, "utf-8") : null;
    try {
      saveMcpCache({
        servers: {
          context7: {
            description: "overridden",
            tools: [{ name: "custom-tool", description: "custom", inputSchema: {} }],
            cachedAt: 12345,
          },
        },
      }, "global");

      const cache = loadMcpCache(tmpDir);
      expect(cache!.servers["context7"].description).toBe("overridden");
      expect(cache!.servers["context7"].tools).toHaveLength(1);
      expect(cache!.servers["context7"].tools[0].name).toBe("custom-tool");
    } finally {
      if (backup !== null) {
        fs.writeFileSync(globalCachePath, backup, "utf-8");
      } else if (fs.existsSync(globalCachePath)) {
        fs.unlinkSync(globalCachePath);
      }
    }
  });

  it("project cache overrides global cache", () => {
    const globalCachePath = path.join(os.homedir(), ".pi/agent/mcp-cache.json");
    const backup = fs.existsSync(globalCachePath) ? fs.readFileSync(globalCachePath, "utf-8") : null;
    try {
      saveMcpCache({
        servers: {
          exa: { description: "global-exa", tools: [], cachedAt: 1 },
        },
      }, "global");

      saveMcpCache({
        servers: {
          exa: { description: "project-exa", tools: [], cachedAt: 2 },
        },
      }, "project", tmpDir);

      const cache = loadMcpCache(tmpDir);
      expect(cache!.servers["exa"].description).toBe("project-exa");
    } finally {
      if (backup !== null) {
        fs.writeFileSync(globalCachePath, backup, "utf-8");
      } else if (fs.existsSync(globalCachePath)) {
        fs.unlinkSync(globalCachePath);
      }
    }
  });

  it("returns empty cache when no file cache", () => {
    const globalCachePath = path.join(os.homedir(), ".pi/agent/mcp-cache.json");
    const backup = fs.existsSync(globalCachePath) ? fs.readFileSync(globalCachePath, "utf-8") : null;
    try {
      // Ensure no global cache exists
      if (fs.existsSync(globalCachePath)) fs.unlinkSync(globalCachePath);
      const cache = loadMcpCache(tmpDir);
      expect(Object.keys(cache!.servers)).toHaveLength(0);
    } finally {
      if (backup !== null) {
        fs.writeFileSync(globalCachePath, backup, "utf-8");
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// saveMcpCache / updateServerCache
// ═════════════════════════════════════════════════════════════════════════════

describe("saveMcpCache / updateServerCache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTempDir("mcp-cache-");
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  it("saveMcpCache writes to project scope", () => {
    const cache: McpCache = {
      servers: {
        test: { description: "test", tools: [], cachedAt: 99 },
      },
    };
    saveMcpCache(cache, "project", tmpDir);
    const filePath = path.join(tmpDir, ".pi/agent/mcp-cache.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const loaded = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(loaded.servers["test"].description).toBe("test");
  });

  it("updateServerCache adds entry to existing cache", () => {
    const cachePath = path.join(tmpDir, ".pi/agent/mcp-cache.json");
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({
      servers: { existing: { description: "existing", tools: [], cachedAt: 1 } },
    }), "utf-8");

    updateServerCache("new-server", {
      description: "new server",
      tools: [{ name: "tool1", description: "a tool", inputSchema: {} }],
      cachedAt: 2,
    }, "project", tmpDir);

    const loaded = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    expect(Object.keys(loaded.servers)).toContain("existing");
    expect(Object.keys(loaded.servers)).toContain("new-server");
    expect(loaded.servers["new-server"].description).toBe("new server");
  });

  it("updateServerCache overwrites existing entry", () => {
    const cachePath = path.join(tmpDir, ".pi/agent/mcp-cache.json");
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({
      servers: { myserver: { description: "old", tools: [], cachedAt: 1 } },
    }), "utf-8");

    updateServerCache("myserver", {
      description: "updated",
      tools: [],
      cachedAt: 99,
    }, "project", tmpDir);

    const loaded = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    expect(loaded.servers["myserver"].description).toBe("updated");
    expect(loaded.servers["myserver"].cachedAt).toBe(99);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// cleanupStaleCache
// ═════════════════════════════════════════════════════════════════════════════

describe("cleanupStaleCache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTempDir("mcp-cache-");
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  it("removes servers not in configs from project cache", () => {
    const cachePath = path.join(tmpDir, ".pi/agent/mcp-cache.json");
    const mcpJsonPath = path.join(tmpDir, ".pi/agent/mcp.json");
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: {} }), "utf-8");
    fs.writeFileSync(cachePath, JSON.stringify({
      servers: {
        keep: { description: "keep", tools: [], cachedAt: 1 },
        remove: { description: "remove", tools: [], cachedAt: 2 },
      },
    }), "utf-8");

    cleanupStaleCache([
      { name: "keep", url: "http://test", enabled: true, source: "project" },
    ], tmpDir);

    const loaded = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    expect(Object.keys(loaded.servers)).toEqual(["keep"]);
  });

  it("preserves servers that are in configs", () => {
    const cachePath = path.join(tmpDir, ".pi/agent/mcp-cache.json");
    const mcpJsonPath = path.join(tmpDir, ".pi/agent/mcp.json");
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: {} }), "utf-8");
    fs.writeFileSync(cachePath, JSON.stringify({
      servers: {
        a: { description: "a", tools: [], cachedAt: 1 },
        b: { description: "b", tools: [], cachedAt: 2 },
      },
    }), "utf-8");

    cleanupStaleCache([
      { name: "a", url: "http://a", enabled: true, source: "project" },
      { name: "b", url: "http://b", enabled: true, source: "project" },
    ], tmpDir);

    const loaded = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    expect(Object.keys(loaded.servers).sort()).toEqual(["a", "b"]);
  });

  it("does nothing when cache file does not exist", () => {
    cleanupStaleCache([
      { name: "any", url: "http://any", enabled: true, source: "project" },
    ], tmpDir);
    // Should not throw
    expect(true).toBe(true);
  });

  it("removes project cache file when project mcp.json does not exist", () => {
    const cachePath = path.join(tmpDir, ".pi/agent/mcp-cache.json");
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({
      servers: {
        context7: { tools: [], cachedAt: 1 },
      },
    }), "utf-8");

    // No mcp.json exists in tmpDir
    cleanupStaleCache([
      { name: "context7", url: "http://test", enabled: true, source: "builtin" },
    ], tmpDir);

    // Project cache file should be deleted
    expect(fs.existsSync(cachePath)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// toggleMcpServerEnabled
// ═════════════════════════════════════════════════════════════════════════════

describe("toggleMcpServerEnabled", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTempDir("mcp-toggle-");
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  it("disables a project server", () => {
    const filePath = path.join(tmpDir, ".pi/agent/mcp.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      mcpServers: { myserver: { url: "http://test", enabled: true } },
    }), "utf-8");

    toggleMcpServerEnabled("myserver", false, "project", tmpDir);

    const loaded = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(loaded.mcpServers["myserver"].enabled).toBe(false);
  });

  it("enables a project server", () => {
    const filePath = path.join(tmpDir, ".pi/agent/mcp.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      mcpServers: { myserver: { url: "http://test", enabled: false } },
    }), "utf-8");

    toggleMcpServerEnabled("myserver", true, "project", tmpDir);

    const loaded = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(loaded.mcpServers["myserver"].enabled).toBe(true);
  });

  it("creates config entry for nonexistent server", () => {
    toggleMcpServerEnabled("newserver", false, "project", tmpDir);

    const filePath = path.join(tmpDir, ".pi/agent/mcp.json");
    const loaded = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(loaded.mcpServers["newserver"].enabled).toBe(false);
  });

  it("preserves existing config fields when toggling", () => {
    const filePath = path.join(tmpDir, ".pi/agent/mcp.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      mcpServers: { myserver: { url: "http://test", enabled: true, description: "my server" } },
    }), "utf-8");

    toggleMcpServerEnabled("myserver", false, "project", tmpDir);

    const loaded = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(loaded.mcpServers["myserver"].enabled).toBe(false);
    expect(loaded.mcpServers["myserver"].url).toBe("http://test");
    expect(loaded.mcpServers["myserver"].description).toBe("my server");
  });

  // Regression test for the `require("../settings.js")` ESM bug that
  // made global toggles fail silently (UI showed "Failed to toggle").
  it("toggles a global server (writes to ~/.pi/agent/mcp.json)", () => {
    const GLOBAL_MCP_FILE = path.join(os.homedir(), ".pi/agent/mcp.json");
    const original = fs.existsSync(GLOBAL_MCP_FILE)
      ? fs.readFileSync(GLOBAL_MCP_FILE, "utf-8")
      : null;
    try {
      const result = toggleMcpServerEnabled("context7", false, "global");
      expect(result).toBe(true);
      const loaded = JSON.parse(fs.readFileSync(GLOBAL_MCP_FILE, "utf-8"));
      expect(loaded.mcpServers?.["context7"]?.enabled).toBe(false);
    } finally {
      if (original === null) {
        try { fs.unlinkSync(GLOBAL_MCP_FILE); } catch {}
      } else {
        fs.writeFileSync(GLOBAL_MCP_FILE, original, "utf-8");
      }
    }
  });
});

// Regression test for the `require("./builtin.js")` ESM bug in
// tools/mcp/index.ts. Importing the module used to throw
// ReferenceError because ESM modules don't expose `require`.
describe("registerMcpTools (ESM module load)", () => {
  it("loads without ReferenceError in ESM", async () => {
    const mod = await import("../tools/mcp/index.js");
    expect(typeof mod.registerMcpTools).toBe("function");
  });
});