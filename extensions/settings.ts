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

export interface ModuleSettings {
  safety?: boolean;
  lsp?: boolean;
  "smart-at"?: boolean;
}

export interface DecoratedPiConfig {
  imageModelKey?: string | null;
  compactModelKey?: string | null;
  providers?: Record<string, ProviderCache>;
  modules?: ModuleSettings;
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
