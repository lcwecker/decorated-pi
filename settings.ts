/**
 * Settings — 配置读写（唯一写文件）
 *
 * 所有其他模块只通过此文件访问 decorated-pi.json
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Model } from "@earendil-works/pi-ai";

const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_FILE = path.join(CONFIG_DIR, "decorated-pi.json");

export interface ProviderModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image")[];
}

export interface ProviderCache {
  lastSynced?: string;
  models: ProviderModelEntry[];
}

export interface McpServerEntry {
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  description?: string;
}

export interface ModuleSettings {
  tools?: {
    /** Replace Pi native edit/write with the patch tool. */
    patchOverrideEdit?: boolean;
    /** Interactive ask tool for user clarification (blocks loop until answered). */
    ask?: boolean;
    /** Language server diagnostics, hover, definition, references, symbols, rename. */
    lsp?: boolean;
    /** MCP client with builtin servers (context7, exa, codegraph). */
    mcp?: boolean;
  };
  hooks?: {
    /** Redact secrets from read/bash output before model context. */
    secretRedaction?: boolean;
    /** Rewrite bash through system RTK when available. */
    "rtk"?: boolean;
    /** Send coding activity heartbeats to WakaTime. */
    wakatime?: boolean;
  };
  commands?: {
    /** Project-aware file search replacing default autocomplete. */
    atOverride?: boolean;
    /** /retry command to continue after interruption. */
    retry?: boolean;
    /** /usage command for token stats. */
    usage?: boolean;
  };
}

export interface UsageIndexEntry {
  inode: number;
  size: number;
  mtime: number;
}

export interface DecoratedPiConfig {
  imageModelKey?: string | null;
  compactModelKey?: string | null;
  providers?: Record<string, ProviderCache>;
  modules?: ModuleSettings;
  mcpServers?: Record<string, McpServerEntry>;
  usageIndex?: Record<string, UsageIndexEntry>;
}

export function loadConfig(): DecoratedPiConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as DecoratedPiConfig;
      if (migrateModuleSettings(config)) {
        saveConfig(config);
      }
      return config;
    }
  } catch {}
  return {};
}

export function saveConfig(config: Partial<DecoratedPiConfig>) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const current = loadConfig();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...current, ...config }, null, 2), "utf-8");
}

// ─── 辅助 ──────────────────────────────────────────────────────────────────

export function formatModelKey(m: Model<any>): string {
  return `${m.provider}/${m.id}`;
}

export function parseModelKey(key: string): { provider: string; modelId: string } | null {
  const i = key.indexOf("/");
  if (i === -1) return null;
  return { provider: key.slice(0, i), modelId: key.slice(i + 1) };
}

// ─── Provider ────────────────────────────────────────────────────────────────

export function loadProvider(name: string): ProviderCache | null {
  return loadConfig().providers?.[name] ?? null;
}

export function saveProvider(name: string, data: ProviderCache) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const current = loadConfig();
  if (!current.providers) current.providers = {};
  current.providers[name] = data;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2) + "\n", "utf-8");
}

export function removeProvider(name: string) {
  const current = loadConfig();
  if (current.providers?.[name]) {
    delete current.providers[name];
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2) + "\n", "utf-8");
  }
}

// ─── Project-level config ────────────────────────────────────────────────

function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "agent", "decorated-pi.json");
}

function loadProjectConfig(cwd: string): DecoratedPiConfig {
  try {
    const p = projectConfigPath(cwd);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {}
  return {};
}

function saveProjectConfig(cwd: string, partial: Partial<DecoratedPiConfig>) {
  const p = projectConfigPath(cwd);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const current = loadProjectConfig(cwd);
  fs.writeFileSync(p, JSON.stringify({ ...current, ...partial }, null, 2), "utf-8");
}

// ─── Getter ─────────────────────────────────────────────────────────────────

export function getImageModelKey(): string | null {
  return loadConfig().imageModelKey ?? null;
}

export function getCompactModelKey(): string | null {
  return loadConfig().compactModelKey ?? null;
}

// ─── Setter ─────────────────────────────────────────────────────────────────

export function setImageModelKey(key: string | null) {
  saveConfig({ imageModelKey: key });
}

export function setCompactModelKey(key: string | null) {
  saveConfig({ compactModelKey: key });
}

// ─── Module Switches ──────────────────────────────────────────────────────────

const DEFAULT_MODULES: Required<ModuleSettings> = {
  tools: {
    patchOverrideEdit: true,
    ask: true,
    lsp: true,
    mcp: true,
  },
  hooks: {
    secretRedaction: true,
    "rtk": true,
    wakatime: true,
  },
  commands: {
    atOverride: true,
    retry: true,
    usage: true,
  },
};

/** Maps every module name to its category. Used by isModuleEnabled/setModuleEnabled. */
const MODULE_TO_CATEGORY: Record<string, keyof ModuleSettings> = {
  patchOverrideEdit: "tools",
  ask: "tools",
  lsp: "tools",
  mcp: "tools",
  secretRedaction: "hooks",
  "rtk": "hooks",
  wakatime: "hooks",
  atOverride: "commands",
  retry: "commands",
  usage: "commands",
};

/** Legacy flat module keys that were renamed. Applied before flat→nested migration. */
const LEGACY_MODULE_KEYS: Record<string, string> = {
  patch: "patchOverrideEdit",
  safety: "secretRedaction",
};

/**
 * Migrate module settings to the nested tools/hooks/commands layout.
 * Handles three legacy shapes:
 *   1. Flat config with current names (patchOverrideEdit, secretRedaction, ...)
 *   2. Flat config with old names (patch, safety)
 *   3. Nested config with old inner names (tools.patch, hooks.safety)
 * Already-correct nested configs are left untouched.
 */
function migrateModuleSettings(config: DecoratedPiConfig): boolean {
  if (!config.modules) return false;

  let migrated = false;
  const result: ModuleSettings = {};

  // Start from any already-nested values.
  if (config.modules.tools) result.tools = { ...config.modules.tools };
  if (config.modules.hooks) result.hooks = { ...config.modules.hooks };
  if (config.modules.commands) result.commands = { ...config.modules.commands };

  // Rename legacy keys inside already-nested categories.
  function renameInCategory(
    category: keyof ModuleSettings,
    oldKey: string,
    newKey: string,
  ) {
    const cat = result[category] as Record<string, boolean> | undefined;
    if (cat && oldKey in cat && !(newKey in cat)) {
      cat[newKey] = cat[oldKey];
      delete cat[oldKey];
      migrated = true;
    }
  }
  renameInCategory("tools", "patch", "patchOverrideEdit");
  renameInCategory("hooks", "safety", "secretRedaction");
  renameInCategory("commands", "smart-at", "atOverride");

  // Migrate flat keys into nested categories.
  const flatMapping: Record<string, [keyof ModuleSettings, string]> = {
    patchOverrideEdit: ["tools", "patchOverrideEdit"],
    ask: ["tools", "ask"],
    lsp: ["tools", "lsp"],
    mcp: ["tools", "mcp"],
    secretRedaction: ["hooks", "secretRedaction"],
    "rtk": ["hooks", "rtk"],
    wakatime: ["hooks", "wakatime"],
    atOverride: ["commands", "atOverride"],
    retry: ["commands", "retry"],
    usage: ["commands", "usage"],
    patch: ["tools", "patchOverrideEdit"],
    safety: ["hooks", "secretRedaction"],
    "smart-at": ["commands", "atOverride"],
  };

  for (const [key, value] of Object.entries(config.modules)) {
    if (key === "tools" || key === "hooks" || key === "commands") continue;
    const mapping = flatMapping[key];
    if (!mapping) continue;
    const [category, newKey] = mapping;
    if (!result[category]) result[category] = {} as any;
    const cat = result[category] as Record<string, boolean>;
    if (!(newKey in cat)) {
      cat[newKey] = value as boolean;
    }
    migrated = true;
  }

  if (!migrated) return false;
  config.modules = result;
  return true;
}

export function isModuleEnabled(name: string): boolean {
  const category = MODULE_TO_CATEGORY[name];
  if (!category) return true;
  const modules = loadConfig().modules ?? {};
  const cat = modules[category] as Record<string, boolean> | undefined;
  const defaults = DEFAULT_MODULES[category] as Record<string, boolean>;
  if (cat && name in cat) return cat[name];
  return defaults[name] ?? true;
}

export function setModuleEnabled(name: string, enabled: boolean) {
  const category = MODULE_TO_CATEGORY[name];
  if (!category) return;
  const modules: ModuleSettings = { ...loadConfig().modules };
  modules[category] = { ...(modules[category] ?? {}), [name]: enabled } as any;
  saveConfig({ modules });
}

export function getAllModuleSettings(): Required<ModuleSettings> {
  const modules = loadConfig().modules ?? {};
  return {
    tools: { ...DEFAULT_MODULES.tools, ...modules.tools },
    hooks: { ...DEFAULT_MODULES.hooks, ...modules.hooks },
    commands: { ...DEFAULT_MODULES.commands, ...modules.commands },
  };
}

/**
 * Snapshot of the module settings that pi is currently running with.
 * Captured once when the extension loads; /dp-settings compares the
 * current effective settings against this snapshot to decide whether a
 * reload is actually necessary.
 */
let loadedModuleSnapshot: Required<ModuleSettings> | null = null;

export function captureModuleSnapshot(): void {
  loadedModuleSnapshot = getAllModuleSettings();
}

export function moduleSnapshotChanged(): boolean {
  if (!loadedModuleSnapshot) return true;
  return JSON.stringify(loadedModuleSnapshot) !== JSON.stringify(getAllModuleSettings());
}

// ─── Usage index (增量同步元数据) ─────────────────────────────────────────────

/** 缓存的上次同步状态: { 文件路径 → { inode, size, mtime } } */
export function loadUsageIndex(): Record<string, UsageIndexEntry> {
  return loadConfig().usageIndex ?? {};
}

export function saveUsageIndex(index: Record<string, UsageIndexEntry>) {
  saveConfig({ usageIndex: index });
}
