/**
 * Settings — 配置读写（唯一写文件）
 *
 * 所有其他模块只通过此文件访问 decorated-pi.json
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Model } from "@earendil-works/pi-ai";
import { which } from "./utils/which.js";

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

/** Per-binary dependency override.
 *
 *  Keyed by binary name (e.g. "rtk", "wakatime-cli", "gopls",
 *  "codegraph"). `path` injects an extra search location into which();
 *  `dontBother` silences missing-dependency notifications for this binary. */
export interface DependencySettings {
  /** Absolute path to the binary (file) or a directory to search. Injected
   *  into which()'s extendPath, so it's tried before $PATH. */
  path?: string;
  /** When true, skeleton's missing-dependency notification skips this
   *  binary. Use for binaries the user doesn't care about. */
  dontBother?: boolean;
}

export interface DependencyView extends DependencySettings {
  /** Runtime-only shadow value: what the resolver actually found.
   *  Not persisted to decorated-pi.json and not written by /dp-settings. */
  resolvedPath?: string;
  /** Runtime-only shadow value: whether the resolver checked/found it. */
  resolvedState?: "ok" | "missing";
}

export interface DecoratedPiConfig {
  imageModelKey?: string | null;
  compactModelKey?: string | null;
  dependencies?: Record<string, DependencySettings>;
  providers?: Record<string, ProviderCache>;
  modules?: ModuleSettings;
  mcpServers?: Record<string, McpServerEntry>;
  usageIndex?: Record<string, UsageIndexEntry>;
}

/** Runtime view = real config plus in-memory shadow fields. The shadow has
 *  the same top-level shape as config, but may enrich selected leaves with
 *  runtime-only data. It is never persisted and /dp-settings writes only the
 *  real config through setter functions. */
export interface DecoratedPiConfigView extends Omit<DecoratedPiConfig, "dependencies"> {
  dependencies?: Record<string, DependencyView>;
}

export function loadConfig(): DecoratedPiConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as DecoratedPiConfig;
      // Mutate in place. Do NOT call saveConfig here — saveConfig calls
      // loadConfig first, which would re-trigger the migration (and the
      // file on disk hasn't been written yet), causing deep recursion.
      // The migrated shape is persisted on the next explicit saveConfig.
      migrateModuleSettings(config);
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

// Runtime-only shadow for the whole config. It mirrors DecoratedPiConfig's
// top-level shape but is never persisted; runtime modules update it, and
// /dp-settings reads the merged view for display only.
const configShadow: DecoratedPiConfigView = {};

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

/** Look up a binary's configured path override. Returns null when not set. */
export function getDependencyPath(name: string): string | null {
  return loadConfig().dependencies?.[name]?.path ?? null;
}

/** Whether missing-dependency notifications are silenced for this binary. */
export function isDontBother(name: string): boolean {
  return loadConfig().dependencies?.[name]?.dontBother === true;
}

export function getConfigView(): DecoratedPiConfigView {
  const real = loadConfig();
  const dependencyNames = new Set([
    ...Object.keys(real.dependencies ?? {}),
    ...Object.keys(configShadow.dependencies ?? {}),
  ]);
  const dependencies: Record<string, DependencyView> = {};
  for (const name of dependencyNames) {
    dependencies[name] = {
      ...(real.dependencies?.[name] ?? {}),
      ...(configShadow.dependencies?.[name] ?? {}),
    };
  }
  return {
    ...real,
    ...configShadow,
    dependencies: Object.keys(dependencies).length ? dependencies : undefined,
  };
}

export function getDependencyView(name: string): DependencyView {
  return getConfigView().dependencies?.[name] ?? {};
}

export function listDependencyViewNames(extraNames: string[] = []): string[] {
  return [...new Set([
    ...extraNames,
    ...Object.keys(getConfigView().dependencies ?? {}),
  ])].sort();
}

export function recordDependencyResolution(name: string, resolvedPath: string | null): void {
  if (!configShadow.dependencies) configShadow.dependencies = {};
  configShadow.dependencies[name] = {
    ...(configShadow.dependencies[name] ?? {}),
    ...(resolvedPath
      ? { resolvedState: "ok" as const, resolvedPath }
      : { resolvedState: "missing" as const, resolvedPath: undefined }),
  };
}

/** Resolve a binary using dependency config plus caller-specific search
 *  locations. Modules call this at startup/runtime; it records a shadow
 *  view for /dp-settings but does not persist anything.
 *
 *  Order:
 *    1. dependencies[name].path (file or directory)
 *    2. opts.extendPath entries (file or directory)
 *    3. $PATH
 */
export function resolveDependency(name: string, opts?: { extendPath?: string[] }): string | null {
  const override = getDependencyPath(name);
  const extendPath = [
    ...(override ? [override] : []),
    ...(opts?.extendPath ?? []),
  ];
  const resolved = which(name, { extendPath });
  recordDependencyResolution(name, resolved);
  return resolved;
}

// ─── Setter ─────────────────────────────────────────────────────────────────

export function setImageModelKey(key: string | null) {
  saveConfig({ imageModelKey: key });
}

export function setCompactModelKey(key: string | null) {
  saveConfig({ compactModelKey: key });
}

/** Set or clear a binary's path override. Pass null to remove the path.
 *  Preserves any dontBother flag on the same entry (精准修改不覆盖). */
export function setDependencyPath(name: string, path: string | null) {
  const current = loadConfig();
  const deps = { ...(current.dependencies ?? {}) };
  const existing = deps[name] ?? {};
  if (path === null) {
    const { path: _drop, ...rest } = existing;
    if (Object.keys(rest).length === 0) {
      delete deps[name];
    } else {
      deps[name] = rest;
    }
  } else {
    deps[name] = { ...existing, path };
  }
  // Path edits are config writes; invalidate runtime-only resolution for
  // this binary so /dp-settings never shows a stale pre-edit shadow path.
  if (configShadow.dependencies?.[name]) delete configShadow.dependencies[name];
  saveConfig({ dependencies: deps });
}

/** Set or clear a binary's dontBother flag. Pass false to re-enable
 *  missing-dependency notifications. Preserves any path override. */
export function setDontBother(name: string, dontBother: boolean) {
  const current = loadConfig();
  const deps = { ...(current.dependencies ?? {}) };
  const existing = deps[name] ?? {};
  if (dontBother) {
    deps[name] = { ...existing, dontBother: true };
  } else {
    const { dontBother: _drop, ...rest } = existing;
    if (Object.keys(rest).length === 0) {
      delete deps[name];
    } else {
      deps[name] = rest;
    }
  }
  saveConfig({ dependencies: deps });
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
let loadedDependenciesSnapshot: Record<string, DependencySettings> | null = null;

export function captureModuleSnapshot(): void {
  loadedModuleSnapshot = getAllModuleSettings();
  loadedDependenciesSnapshot = loadConfig().dependencies ?? {};
}

export function moduleSnapshotChanged(): boolean {
  if (!loadedModuleSnapshot) return true;
  if (JSON.stringify(loadedModuleSnapshot) !== JSON.stringify(getAllModuleSettings())) return true;
  // Dependencies changes don't strictly require reload (which() reads the
  // config file on every call), but prompt for consistency — the user
  // might be mid-session and expect the new path to be picked up by hooks
  // that captured the binary path at startup (rtk/wakatime).
  const currentDeps = loadConfig().dependencies ?? {};
  if (JSON.stringify(loadedDependenciesSnapshot) !== JSON.stringify(currentDeps)) return true;
  return false;
}

// ─── Usage index (增量同步元数据) ─────────────────────────────────────────────

/** 缓存的上次同步状态: { 文件路径 → { inode, size, mtime } } */
export function loadUsageIndex(): Record<string, UsageIndexEntry> {
  return loadConfig().usageIndex ?? {};
}

export function saveUsageIndex(index: Record<string, UsageIndexEntry>) {
  saveConfig({ usageIndex: index });
}
