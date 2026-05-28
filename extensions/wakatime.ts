/**
 * WakaTime — coding activity heartbeats for Pi sessions
 *
 * Reads API key from ~/.wakatime.cfg and sends heartbeats to WakaTime using a
 * small runtime state machine:
 *   - before_agent_start → mark app activity
 *   - tool_result        → switch active entity/category based on real work
 *   - agent_end          → stop immediate activity, keepalive handles continuity
 *   - keepalive timer    → extend continuous activity while not idle
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const MACHINE_NAME = os.hostname();
const PACKAGE_VERSION = readPackageVersion();

// ─── Config ────────────────────────────────────────────────────────────────

const WAKATIME_CFG = path.join(os.homedir(), ".wakatime.cfg");
const API_URL = "https://api.wakatime.com/api/v1";
const KEEPALIVE_MS = 90 * 1000;
const IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const TIMER_TICK_MS = 15 * 1000;

function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version?.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export function readWakatimeCfgApiKey(configPath = WAKATIME_CFG): string | undefined {
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const match = content.match(/^api_key\s*=\s*(.+)$/m);
    return match?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  } catch {
    return undefined;
  }
}

function getApiKey(): string | undefined {
  return readWakatimeCfgApiKey();
}

// ─── Heartbeat types ───────────────────────────────────────────────────────

interface Heartbeat {
  entity: string;
  time: number;
  type: "file" | "app";
  category: "ai coding" | "building" | "running tests";
  project?: string;
  project_root_count?: number;
  language?: string;
  lines?: number;
  is_write?: boolean;
}

interface ActiveState {
  heartbeat: Omit<Heartbeat, "time">;
  lastActivityAt: number;
  lastHeartbeatAt: number;
}

let active: ActiveState | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

// ─── Helpers ───────────────────────────────────────────────────────────────

function extToLanguage(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript",
    ".jsx": "JavaScript", ".py": "Python", ".rs": "Rust",
    ".go": "Go", ".rb": "Ruby", ".java": "Java", ".c": "C",
    ".cpp": "C++", ".cc": "C++", ".cxx": "C++", ".h": "C", ".hpp": "C++",
    ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML",
    ".md": "Markdown", ".css": "CSS", ".html": "HTML", ".svelte": "Svelte",
    ".lua": "Lua", ".sh": "Bash", ".sql": "SQL", ".xml": "XML",
  };
  return map[ext];
}

function countPathParts(p: string): number {
  return p.split(/[\\/]+/).filter(Boolean).length;
}

function buildProjectMeta(absPath: string, cwd: string): Pick<Heartbeat, "project" | "project_root_count"> {
  const root = path.resolve(cwd);
  const inProject = absPath.startsWith(root + path.sep) || absPath === root;
  return {
    project: inProject ? (path.basename(root) || undefined) : undefined,
    project_root_count: inProject ? countPathParts(root) : undefined,
  };
}

function countLines(absPath: string): number | undefined {
  try {
    const text = fs.readFileSync(absPath, "utf-8");
    return text.split(/\r?\n/).length;
  } catch {
    return undefined;
  }
}

export function classifyBash(command: string | undefined): Heartbeat["category"] {
  const cmd = String(command ?? "").trim();
  if (!cmd) return "ai coding";
  if (/\b(make|cmake|ninja|npm run build|pnpm build|yarn build|cargo build|go build)\b/i.test(cmd)) {
    return "building";
  }
  if (/\b(pytest|vitest|jest|npm test|pnpm test|yarn test|go test|ctest|cargo test)\b/i.test(cmd)) {
    return "running tests";
  }
  return "ai coding";
}

function sendHeartbeat(hb: Heartbeat, apiKey: string): void {
  const plugin = `pi/${PACKAGE_VERSION} pi-wakatime/${PACKAGE_VERSION}`;
  const body = JSON.stringify([{ ...hb, plugin }]);
  fetch(`${API_URL}/users/current/heartbeats.bulk?api_key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "pi",
      "X-Machine-Name": MACHINE_NAME,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    // Silent: activity tracking must never interrupt the agent.
  });
}

export function heartbeatChanged(a: Omit<Heartbeat, "time">, b: Omit<Heartbeat, "time">): boolean {
  return (
    a.entity !== b.entity ||
    a.type !== b.type ||
    a.category !== b.category ||
    a.project !== b.project ||
    a.project_root_count !== b.project_root_count ||
    a.language !== b.language
  );
}

function switchActive(next: Omit<Heartbeat, "time">, apiKey: string, options: { immediate?: boolean; isWrite?: boolean } = {}): void {
  const now = Date.now();
  const changed = !active || heartbeatChanged(active.heartbeat, next);

  active = {
    heartbeat: next,
    lastActivityAt: now,
    lastHeartbeatAt: active?.lastHeartbeatAt ?? 0,
  };

  if (changed || options.immediate || options.isWrite) {
    sendHeartbeat({ ...next, time: now / 1000, is_write: options.isWrite }, apiKey);
    active.lastHeartbeatAt = now;
  }
}

function touchActivity(): void {
  if (active) active.lastActivityAt = Date.now();
}

function ensureTimer(apiKey: string): void {
  if (timer) return;
  timer = setInterval(() => {
    if (!active) return;
    const now = Date.now();
    if (now - active.lastActivityAt > IDLE_TIMEOUT_MS) return;
    if (now - active.lastHeartbeatAt < KEEPALIVE_MS) return;
    sendHeartbeat({ ...active.heartbeat, time: now / 1000 }, apiKey);
    active.lastHeartbeatAt = now;
  }, TIMER_TICK_MS);
}

function clearTimer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function buildAppHeartbeat(cwd: string, category: Heartbeat["category"] = "ai coding"): Omit<Heartbeat, "time"> {
  const root = path.resolve(cwd);
  return {
    entity: "pi",
    type: "app",
    category,
    project: path.basename(root) || undefined,
    project_root_count: countPathParts(root),
  };
}

export function buildFileHeartbeat(absPath: string, cwd: string, category: Heartbeat["category"] = "ai coding"): Omit<Heartbeat, "time"> {
  const meta = buildProjectMeta(absPath, cwd);
  return {
    entity: absPath,
    type: "file",
    category,
    project: meta.project,
    project_root_count: meta.project_root_count,
    language: extToLanguage(absPath),
    lines: countLines(absPath),
  };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

export function setupWakatime(pi: ExtensionAPI) {
  const apiKey = getApiKey();
  if (!apiKey) return;

  pi.on("session_start", (_event, _ctx) => {
    active = null;
    ensureTimer(apiKey);
  });

  pi.on("session_shutdown", () => {
    active = null;
    clearTimer();
  });

  pi.on("before_agent_start", (_event, ctx) => {
    const cwd = ctx.cwd ?? process.cwd();
    // If we already have a recent active file/app heartbeat, just mark activity.
    if (active && (Date.now() - active.lastActivityAt) <= IDLE_TIMEOUT_MS) {
      touchActivity();
      return;
    }
    // App heartbeat covers prompt/thinking time before touching files.
    switchActive(buildAppHeartbeat(cwd), apiKey, { immediate: true });
  });

  pi.on("tool_result", (event, ctx) => {
    const cwd = ctx.cwd ?? process.cwd();
    const toolName = event.toolName;
    const input = (event as any).input;

    if (toolName === "read") {
      const filePath = input?.path ?? input?.file ?? input?.file_path;
      if (typeof filePath !== "string" || !filePath.trim()) return;
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      switchActive(buildFileHeartbeat(absPath, cwd), apiKey);
      return;
    }

    if (toolName === "patch") {
      const filePath = input?.path;
      if (typeof filePath !== "string" || !filePath.trim()) return;
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      switchActive(buildFileHeartbeat(absPath, cwd), apiKey, { immediate: true, isWrite: true });
      return;
    }

    if (toolName === "lsp_document_symbols") {
      const filePath = input?.path;
      if (typeof filePath !== "string" || !filePath.trim()) return;
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      switchActive(buildFileHeartbeat(absPath, cwd), apiKey);
      return;
    }

    if (toolName === "lsp_diagnostics") {
      const filePath = Array.isArray(input?.paths) ? input.paths[0] : undefined;
      if (typeof filePath === "string" && filePath.trim()) {
        const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
        switchActive(buildFileHeartbeat(absPath, cwd), apiKey);
      } else {
        touchActivity();
      }
      return;
    }

    if (toolName === "bash") {
      const category = classifyBash(input?.command);
      switchActive(buildAppHeartbeat(cwd, category), apiKey, { immediate: false });
      return;
    }
  });

  pi.on("agent_end", (_event, _ctx) => {
    // Do not clear immediately; keepalive continues briefly until idle timeout.
    touchActivity();
  });
}
