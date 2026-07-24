/**
 * wakatime — coding activity heartbeats.
 *
 * Reads API key from ~/.wakatime.cfg and sends heartbeats via wakatime-cli.
 * Owns its own timer state and the "active" entity.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveDependency } from "../settings.js";
import { fileURLToPath } from "node:url";
import type { Module, Skeleton } from "./skeleton.js";

const MACHINE_NAME = os.hostname();
const PACKAGE_VERSION = readPackageVersion();

const WAKATIME_CFG = path.join(os.homedir(), ".wakatime.cfg");
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

export type HeartbeatSender = (hb: Heartbeat, cwd?: string) => void;

interface WakatimeRuntime {
  active: ActiveState | null;
  timer: ReturnType<typeof setInterval> | null;
  terminalInputUnsub: (() => void) | null;
}

function createRuntime(): WakatimeRuntime {
  return { active: null, timer: null, terminalInputUnsub: null };
}

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

export function wakatimeDependencyExtendPath(): string[] {
  return [path.join(os.homedir(), ".wakatime")];
}

function findWakatimeCliOnPath(): string | null {
  return resolveDependency("wakatime-cli", { extendPath: wakatimeDependencyExtendPath() });
}

export function findWakatimeCli(options: {
  probePath?: () => string | null;
} = {}): string | null {
  if (cachedWakatimeCliPath !== undefined) return cachedWakatimeCliPath;
  const probePath = options.probePath ?? findWakatimeCliOnPath;
  const found = probePath();
  cachedWakatimeCliPath = found ? path.resolve(found) : null;
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

function switchActive(
  runtime: WakatimeRuntime,
  next: Omit<Heartbeat, "time">,
  sendHeartbeat: HeartbeatSender,
  options: { immediate?: boolean; isWrite?: boolean; cwd?: string } = {},
) {
  const now = Date.now();
  const changed = !runtime.active || heartbeatChanged(runtime.active.heartbeat, next);
  runtime.active = {
    heartbeat: next,
    cwd: options.cwd,
    lastActivityAt: now,
    lastHeartbeatAt: runtime.active?.lastHeartbeatAt ?? 0,
  };
  if (changed || options.immediate || options.isWrite) {
    sendHeartbeat({ ...next, time: now / 1000, is_write: options.isWrite }, options.cwd);
    runtime.active.lastHeartbeatAt = now;
  }
}

function sendOneShot(hb: Omit<Heartbeat, "time">, sendHeartbeat: HeartbeatSender, isWrite?: boolean, cwd?: string) {
  sendHeartbeat({ ...hb, time: Date.now() / 1000, is_write: isWrite }, cwd);
}

function touchActivity(runtime: WakatimeRuntime) {
  if (runtime.active) runtime.active.lastActivityAt = Date.now();
}

function ensureTimer(runtime: WakatimeRuntime, sendHeartbeat: HeartbeatSender) {
  if (runtime.timer) return;
  runtime.timer = setInterval(() => {
    if (!runtime.active) return;
    const now = Date.now();
    if (now - runtime.active.lastActivityAt > IDLE_TIMEOUT_MS) return;
    if (now - runtime.active.lastHeartbeatAt < KEEPALIVE_MS) return;
    sendHeartbeat({ ...runtime.active.heartbeat, time: now / 1000 }, runtime.active.cwd);
    runtime.active.lastHeartbeatAt = now;
  }, TIMER_TICK_MS);
}

function resetRuntime(runtime: WakatimeRuntime) {
  runtime.active = null;
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.timer = null;
  runtime.terminalInputUnsub?.();
  runtime.terminalInputUnsub = null;
}

export function buildAppHeartbeat(cwd: string, category: Heartbeat["category"] = "ai coding"): Omit<Heartbeat, "time"> {
  const root = path.resolve(cwd);
  return { entity: "pi", type: "app", category, project: path.basename(root) || undefined, project_root_count: countPathParts(root) };
}

export function buildFileHeartbeat(absPath: string, cwd: string, category: Heartbeat["category"] = "ai coding"): Omit<Heartbeat, "time"> {
  const meta = buildProjectMeta(absPath, cwd);
  return { entity: absPath, type: "file", category, project: meta.project, project_root_count: meta.project_root_count, language: extToLanguage(absPath), lines: countLines(absPath) };
}

// ─── Module + setup ──────────────────────────────────────────────────────

/** Build one isolated WakaTime module instance. Runtime state belongs to the
 *  module closure, so reloads and parallel sessions cannot share timers,
 *  active entities, or terminal-input subscriptions. */
export function createWakatimeModule(sendHeartbeat: HeartbeatSender): Module {
  const runtime = createRuntime();

  return {
    name: "wakatime",
    hooks: {
      session_start: [
        (_event, ctx) => {
          resetRuntime(runtime);
          ensureTimer(runtime, sendHeartbeat);
          if (!ctx.hasUI) return;
          runtime.terminalInputUnsub = ctx.ui.onTerminalInput(() => {
            const cwd = ctx.cwd ?? process.cwd();
            const recent = runtime.active && (Date.now() - runtime.active.lastActivityAt) <= IDLE_TIMEOUT_MS;
            const isAppHeartbeat = runtime.active?.heartbeat.type === "app" && runtime.active.heartbeat.entity === "pi";
            if (!recent || !isAppHeartbeat) {
              switchActive(runtime, buildAppHeartbeat(cwd), sendHeartbeat, { immediate: true, cwd });
            } else {
              touchActivity(runtime);
            }
            return undefined;
          });
        },
      ],
      session_shutdown: [
        () => resetRuntime(runtime),
      ],
      before_agent_start: [
        (_event, ctx) => {
          const cwd = ctx.cwd ?? process.cwd();
          switchActive(runtime, buildAppHeartbeat(cwd), sendHeartbeat, { immediate: true, cwd });
        },
      ],
      tool_result: [
        (event, ctx) => {
          const cwd = ctx.cwd ?? process.cwd();
          const input = event.input as any;
          const filePath = input?.path ?? input?.file ?? input?.file_path;
          if (typeof filePath === "string" && filePath.trim()) {
            const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
            sendOneShot(buildFileHeartbeat(absPath, cwd), sendHeartbeat, undefined, cwd);
            touchActivity(runtime);
            return;
          }
          if (event.toolName === "bash") {
            const category = classifyBash(input?.command);
            switchActive(runtime, buildAppHeartbeat(cwd, category), sendHeartbeat, { cwd });
          }
          touchActivity(runtime);
        },
      ],
      agent_end: [
        () => touchActivity(runtime),
      ],
    },
  };
}

export function setupWakatime(sk: Skeleton): void {
  const apiKey = readWakatimeCfgApiKey();
  const cliPath = findWakatimeCli();
  if (!cliPath) {
    sk.declareMissing({
      name: "wakatime-cli",
      module: "wakatime",
      hint: "Install wakatime-cli to track coding activity.",
    });
  }
  if (!apiKey || !cliPath) return;

  const sendHeartbeat: HeartbeatSender = (hb, cwd) => sendHeartbeatViaCli(hb, apiKey, cliPath, cwd);
  sk.register(createWakatimeModule(sendHeartbeat));
}

export const __wakatimeTest = {
  resetDependencyCache() {
    cachedWakatimeCliPath = undefined;
  },
};
