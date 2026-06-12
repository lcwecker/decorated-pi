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
  safety?: boolean;
  lsp?: boolean;
  "smart-at"?: boolean;
  patch?: boolean;
  mcp?: boolean;
  wakatime?: boolean;
  "rtk"?: boolean;
  codegraph?: boolean;
  ask?: boolean;
  todo?: boolean;
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
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
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
  safety: true,
  lsp: true,
  "smart-at": true,
  patch: true,
  mcp: true,
  wakatime: true,
  "rtk": true,
  codegraph: false,  // opt-in: heavy binary, not everyone wants it
  ask: false,        // opt-in: blocks agent loop waiting for user input
  todo: false,       // opt-in: session management tool
};

export function isModuleEnabled(name: keyof ModuleSettings): boolean {
  const modules = loadConfig().modules ?? {};
  return modules[name] ?? DEFAULT_MODULES[name] ?? true;
}

export function setModuleEnabled(name: keyof ModuleSettings, enabled: boolean) {
  const modules = { ...loadConfig().modules };
  modules[name] = enabled;
  saveConfig({ modules });
}

export function getAllModuleSettings(): Required<ModuleSettings> {
  const modules = loadConfig().modules ?? {};
  return { ...DEFAULT_MODULES, ...modules };
}

// ─── Codegraph (drives the builtin MCP server's auto-enable) ───────────────

/**
 * True when the user has enabled the codegraph module via /dp-settings.
 * Default is OFF (opt-in) — `modules.codegraph` defaults to `false`.
 * When true, the builtin MCP server is enabled and the CodeGraph
 * guidance section is injected into the system prompt.
 */
export function isCodegraphModuleEnabled(): boolean {
  return isModuleEnabled("codegraph");
}

// ─── Usage index (增量同步元数据) ─────────────────────────────────────────────

/** 缓存的上次同步状态: { 文件路径 → { inode, size, mtime } } */
export function loadUsageIndex(): Record<string, UsageIndexEntry> {
  return loadConfig().usageIndex ?? {};
}

export function saveUsageIndex(index: Record<string, UsageIndexEntry>) {
  saveConfig({ usageIndex: index });
}
