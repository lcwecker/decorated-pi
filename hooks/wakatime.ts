/**
 * wakatime — coding activity heartbeats.
 *
 * Reads API key from ~/.wakatime.cfg and sends heartbeats via wakatime-cli.
 * Owns its own timer state and the "active" entity.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Module, Skeleton } from "./skeleton.js";

const MACHINE_NAME = os.hostname();
const PACKAGE_VERSION = readPackageVersion();

const WAKATIME_CFG = path.join(os.homedir(), ".wakatime.cfg");
const WAKATIME_CLI_FALLBACK = path.join(os.homedir(), ".wakatime", "wakatime-cli");
const API_URL = "https://api.wakatime.com/api/v1";
const KEEPALIVE_MS = 90 * 1000;
const IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const TIMER_TICK_MS = 15 * 1000;

function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, "package.json");
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

// ─── Heartbeat types ──────────────────────────────────────────────────────

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
  cwd?: string;
  lastActivityAt: number;
  lastHeartbeatAt: number;
}

type HeartbeatSender = (hb: Heartbeat, cwd?: string) => void;

let active: ActiveState | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let terminalInputUnsub: (() => void) | null = null;
let cachedWakatimeCliPath: string | null | undefined;

// ─── Helpers ──────────────────────────────────────────────────────────────

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
  if (/\b(make|cmake|ninja|npm run build|pnpm build|yarn build|cargo build|go build)\b/i.test(cmd)) return "building";
  if (/\b(pytest|vitest|jest|npm test|pnpm test|yarn test|go test|ctest|cargo test)\b/i.test(cmd)) return "running tests";
  return "ai coding";
}

export function buildPluginString(version = PACKAGE_VERSION): string {
  return `pi/${version} pi/${version}`;
}

function findWakatimeCliOnPath(): string | null {
  try {
    if (process.platform === "win32") {
      const output = execFileSync("where", ["wakatime-cli"], { encoding: "utf-8" }).trim();
      const first = output.split(/\r?\n/)[0]?.trim();
      return first ? path.resolve(first) : null;
    }
    const shell = process.env.SHELL || "sh";
    const output = execFileSync(shell, ["-lc", "command -v wakatime-cli"], { encoding: "utf-8" }).trim();
    return output ? path.resolve(output) : null;
  } catch {
    return null;
  }
}

export function findWakatimeCli(options: {
  probePath?: () => string | null;
  exists?: (candidate: string) => boolean;
  fallbackPath?: string;
} = {}): string | null {
  if (cachedWakatimeCliPath !== undefined) return cachedWakatimeCliPath;
  const probePath = options.probePath ?? findWakatimeCliOnPath;
  const exists = options.exists ?? fs.existsSync;
  const fromPath = probePath();
  if (fromPath) {
    cachedWakatimeCliPath = path.resolve(fromPath);
    return cachedWakatimeCliPath;
  }
  const fallback = path.resolve(options.fallbackPath ?? WAKATIME_CLI_FALLBACK);
  cachedWakatimeCliPath = exists(fallback) ? fallback : null;
  return cachedWakatimeCliPath;
}

export function buildCliArgs(hb: Heartbeat, apiKey: string, cwd?: string, plugin = buildPluginString()): string[] {
  const args = [
    "--entity", hb.entity, "--entity-type", hb.type, "--category", hb.category,
    "--plugin", plugin, "--key", apiKey, "--time", String(hb.time),
    "--hostname", MACHINE_NAME,
  ];
  const shouldSendProjectFolder = hb.type === "app" || !!hb.project || typeof hb.project_root_count === "number";
  if (cwd && shouldSendProjectFolder) args.push("--project-folder", cwd);
  if (hb.project) args.push("--project", hb.project);
  if (hb.language) args.push("--language", hb.language);
  if (typeof hb.lines === "number") args.push("--lines-in-file", String(hb.lines));
  if (hb.is_write) args.push("--write");
  return args;
}

function sendHeartbeatViaCli(hb: Heartbeat, apiKey: string, cliPath: string, cwd?: string): void {
  const args = buildCliArgs(hb, apiKey, cwd);
  execFile(cliPath, args, { timeout: 10_000, windowsHide: true }, () => {});
}

export function heartbeatChanged(a: Omit<Heartbeat, "time">, b: Omit<Heartbeat, "time">): boolean {
  return a.entity !== b.entity || a.type !== b.type || a.category !== b.category
    || a.project !== b.project || a.project_root_count !== b.project_root_count
    || a.language !== b.language;
}

function switchActive(next: Omit<Heartbeat, "time">, sendHeartbeat: HeartbeatSender, options: { immediate?: boolean; isWrite?: boolean; cwd?: string } = {}) {
  const now = Date.now();
  const changed = !active || heartbeatChanged(active.heartbeat, next);
  active = { heartbeat: next, cwd: options.cwd, lastActivityAt: now, lastHeartbeatAt: active?.lastHeartbeatAt ?? 0 };
  if (changed || options.immediate || options.isWrite) {
    sendHeartbeat({ ...next, time: now / 1000, is_write: options.isWrite }, options.cwd);
    active.lastHeartbeatAt = now;
  }
}

function sendOneShot(hb: Omit<Heartbeat, "time">, sendHeartbeat: HeartbeatSender, isWrite?: boolean, cwd?: string) {
  sendHeartbeat({ ...hb, time: Date.now() / 1000, is_write: isWrite }, cwd);
}

function touchActivity() { if (active) active.lastActivityAt = Date.now(); }

function ensureTimer(sendHeartbeat: HeartbeatSender) {
  if (timer) return;
  timer = setInterval(() => {
    if (!active) return;
    const now = Date.now();
    if (now - active.lastActivityAt > IDLE_TIMEOUT_MS) return;
    if (now - active.lastHeartbeatAt < KEEPALIVE_MS) return;
    sendHeartbeat({ ...active.heartbeat, time: now / 1000 }, active.cwd);
    active.lastHeartbeatAt = now;
  }, TIMER_TICK_MS);
}

function clearTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function buildAppHeartbeat(cwd: string, category: Heartbeat["category"] = "ai coding"): Omit<Heartbeat, "time"> {
  const root = path.resolve(cwd);
  return { entity: "pi", type: "app", category, project: path.basename(root) || undefined, project_root_count: countPathParts(root) };
}

export function buildFileHeartbeat(absPath: string, cwd: string, category: Heartbeat["category"] = "ai coding"): Omit<Heartbeat, "time"> {
  const meta = buildProjectMeta(absPath, cwd);
  return { entity: absPath, type: "file", category, project: meta.project, project_root_count: meta.project_root_count, language: extToLanguage(absPath), lines: countLines(absPath) };
}

export function resetWakatimeStateForTests() {
  active = null;
  clearTimer();
  if (terminalInputUnsub) terminalInputUnsub();
  terminalInputUnsub = null;
  cachedWakatimeCliPath = undefined;
}

// ─── Module + setup ──────────────────────────────────────────────────────

export const wakatimeModule: Module = {
  name: "wakatime",
  hooks: {
    session_start: [
      (_event, ctx) => {
        active = null;
        // Timer is set up in setupWakatime (needs API key + CLI).
      },
    ],
    session_shutdown: [
      () => {
        active = null;
        clearTimer();
        if (terminalInputUnsub) terminalInputUnsub();
        terminalInputUnsub = null;
      },
    ],
    before_agent_start: [
      (_event, ctx) => {
        const cwd = ctx.cwd ?? process.cwd();
        // Caller (setupWakatime) provides the actual sender; this module's
        // before_agent_start is a no-op when not configured.
        if (active && (Date.now() - active.lastActivityAt) <= IDLE_TIMEOUT_MS) {
          active.heartbeat = buildAppHeartbeat(cwd, active.heartbeat.category);
          active.lastActivityAt = Date.now();
        }
      },
    ],
    agent_end: [
      () => { touchActivity(); },
    ],
  },
};

export function setupWakatimeWithApiKey(
  pi: ExtensionAPI,
  apiKey: string | undefined,
  cliPath: string | null | undefined = findWakatimeCli(),
  sendHeartbeat: HeartbeatSender | undefined = cliPath && apiKey
    ? (hb, cwd) => sendHeartbeatViaCli(hb, apiKey, cliPath, cwd)
    : undefined,
): void {
  if (!apiKey || !cliPath || !sendHeartbeat) return;

  pi.on("session_start", (_event, ctx) => {
    active = null;
    ensureTimer(sendHeartbeat);
    if (terminalInputUnsub) terminalInputUnsub();
    terminalInputUnsub = null;
    if (!ctx.hasUI) return;
    terminalInputUnsub = ctx.ui.onTerminalInput(() => {
      const cwd = ctx.cwd ?? process.cwd();
      const recent = active && (Date.now() - active.lastActivityAt) <= IDLE_TIMEOUT_MS;
      const isAppHeartbeat = active?.heartbeat.type === "app" && active.heartbeat.entity === "pi";
      if (!recent || !isAppHeartbeat) {
        switchActive(buildAppHeartbeat(cwd), sendHeartbeat, { immediate: true, cwd });
      } else {
        touchActivity();
      }
      return undefined;
    });
  });

  pi.on("session_shutdown", () => {
    active = null;
    clearTimer();
    if (terminalInputUnsub) terminalInputUnsub();
    terminalInputUnsub = null;
  });

  pi.on("before_agent_start", (_event, ctx) => {
    const cwd = ctx.cwd ?? process.cwd();
    switchActive(buildAppHeartbeat(cwd), sendHeartbeat, { immediate: true, cwd });
  });

  // File-level heartbeats as one-shots in tool_result (don't replace the active keepalive).
  pi.on("tool_result", (event, ctx) => {
    const cwd = ctx.cwd ?? process.cwd();
    const input = (event as any).input;
    if (event.toolName === "read") {
      const filePath = input?.path ?? input?.file ?? input?.file_path;
      if (typeof filePath !== "string" || !filePath.trim()) return;
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      sendOneShot(buildFileHeartbeat(absPath, cwd), sendHeartbeat, undefined, cwd);
      touchActivity();
    } else if (event.toolName === "patch") {
      const filePath = input?.path;
      if (typeof filePath !== "string" || !filePath.trim()) return;
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      sendOneShot(buildFileHeartbeat(absPath, cwd), sendHeartbeat, true, cwd);
      touchActivity();
    } else if (event.toolName === "lsp_diagnostics") {
      touchActivity();
    } else if (event.toolName === "bash") {
      const category = classifyBash(input?.command);
      switchActive(buildAppHeartbeat(cwd, category), sendHeartbeat, { cwd });
      touchActivity();
    } else {
      touchActivity();
    }
  });

  pi.on("agent_end", (_event, _ctx) => { touchActivity(); });
}

export function setupWakatime(sk: Skeleton, pi: ExtensionAPI): void {
  const apiKey = readWakatimeCfgApiKey();
  const cliPath = findWakatimeCli();
  const ready = sk.declareDependency({
    label: "wakatime-cli",
    module: "wakatime",
    check: () => findWakatimeCli() !== null,
    hint: "Install wakatime-cli to track coding activity.",
  });
  if (!apiKey || !cliPath || !ready) return;

  const sendHeartbeat: HeartbeatSender = (hb, cwd) => sendHeartbeatViaCli(hb, apiKey, cliPath, cwd);

  // Hook into session_start to set up timer + terminal input.
  pi.on("session_start", (_event, ctx) => {
    active = null;
    ensureTimer(sendHeartbeat);
    if (terminalInputUnsub) terminalInputUnsub();
    terminalInputUnsub = null;
    if (!ctx.hasUI) return;
    terminalInputUnsub = ctx.ui.onTerminalInput(() => {
      const cwd = ctx.cwd ?? process.cwd();
      const recent = active && (Date.now() - active.lastActivityAt) <= IDLE_TIMEOUT_MS;
      const isAppHeartbeat = active?.heartbeat.type === "app" && active.heartbeat.entity === "pi";
      if (!recent || !isAppHeartbeat) {
        switchActive(buildAppHeartbeat(cwd), sendHeartbeat, { immediate: true, cwd });
      } else {
        touchActivity();
      }
      return undefined;
    });
  });

  // Tool result: auto-detect file operations, classify bash, touch activity
  pi.on("tool_result", (event, ctx) => {
    const cwd = ctx.cwd ?? process.cwd();
    const input = (event as any).input;

    // Auto-detect file operations from input shape
    const filePath = input?.path ?? input?.file ?? input?.file_path;
    if (typeof filePath === "string" && filePath.trim()) {
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      sendOneShot(buildFileHeartbeat(absPath, cwd), sendHeartbeat, undefined, cwd);
      touchActivity();
      return;
    }

    // Bash needs special classification
    if (event.toolName === "bash") {
      const category = classifyBash(input?.command);
      if (active) active.heartbeat = { ...active.heartbeat, category };
      touchActivity();
      return;
    }

    // Everything else: just touch activity
    touchActivity();
  });

  sk.register(wakatimeModule);
}
