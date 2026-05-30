/**
 * tool-compress — Bash output compression for token savings
 *
 * Strategy: integrate with RTK (Rust Token Killer) when available.
 * RTK rewrites commands before execution (e.g. `git status` → `rtk git status`),
 * producing optimized output. When RTK is unavailable, falls back to
 * lightweight post-execution compression (ANSI strip, blank line collapse,
 * deduplication).
 *
 * Does NOT compress read/write/edit/patch (affects LLM editing).
 * Does NOT compress MCP tools (needs smart compression, not truncation).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createLocalBashOperations, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── RTK integration ────────────────────────────────────────────────────────

let rtkBinary: string | null = null;

const RTK_PLATFORM_PACKAGES: Record<string, string> = {
  "darwin-arm64": "@pleaseai/rtk-darwin-arm64",
  "darwin-x64": "@pleaseai/rtk-darwin-x64",
  "linux-arm64": "@pleaseai/rtk-linux-arm64",
  "linux-x64": "@pleaseai/rtk-linux-x64",
  "win32-x64": "@pleaseai/rtk-win32-x64",
};

interface PiShellSettings {
  shellPath?: string;
  shellCommandPrefix?: string;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildRtkCommand(raw: string, rtkBinaryPath: string): string {
  const binDir = path.dirname(rtkBinaryPath);
  return `export PATH=${shellQuote(binDir)}:$PATH && ${raw}`;
}

export function shouldBypassRtkRewrite(command: string): boolean {
  const main = extractMainCommand(command);
  if (!main.startsWith("find ") && main !== "find") return false;

  // RTK find currently rejects compound predicates/actions.
  return /(^|\s)(-o|-or|-a|-and|-not|!|\(|\)|-exec|-ok|-delete|-prune|-printf|-print0)(\s|$)/.test(main);
}

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function loadPiShellSettings(cwd: string): PiShellSettings {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const globalSettings = readJsonObject(path.join(agentDir, "settings.json"));
  const projectSettings = readJsonObject(path.join(cwd, ".pi", "settings.json"));
  const merged = { ...globalSettings, ...projectSettings } as Record<string, unknown>;
  const result: PiShellSettings = {};
  if (typeof merged.shellPath === "string" && merged.shellPath.trim()) result.shellPath = merged.shellPath;
  if (typeof merged.shellCommandPrefix === "string" && merged.shellCommandPrefix.trim()) {
    result.shellCommandPrefix = merged.shellCommandPrefix;
  }
  return result;
}

function findRtkBinary(): string | null {
  const binaryName = process.platform === "win32" ? "rtk.exe" : "rtk";
  const key = `${process.platform}-${process.arch}`;
  const pkg = RTK_PLATFORM_PACKAGES[key];

  if (pkg) {
    const tryPaths = [
      path.join(process.cwd(), "node_modules", pkg, binaryName),
      path.join(__dirname, "..", "node_modules", pkg, binaryName),
    ];

    for (const p of tryPaths) {
      if (fs.existsSync(p)) return p;
    }
  }

  try {
    execFileSync("which", ["rtk"], { encoding: "utf-8" });
    return "rtk";
  } catch {
    return null;
  }
}

function rewriteWithRtk(command: string): string | null {
  if (!rtkBinary) return null;
  if (shouldBypassRtkRewrite(command)) return null;
  try {
    const raw = execFileSync(rtkBinary, ["rewrite", command], {
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    if (!raw) return null;
    return buildRtkCommand(raw, rtkBinary);
  } catch {
    return null;
  }
}

export function appendStatus(text: string, status: string): string {
  return text ? `${text}\n\n${status}` : status;
}

function formatBashCallWithTag(args: { command?: unknown; timeout?: unknown }, theme: any, showTag: boolean): string {
  const command = typeof args?.command === "string" ? args.command : null;
  const timeout = typeof args?.timeout === "number" ? args.timeout : undefined;
  const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
  const commandDisplay = command === null ? theme.fg("error", "<invalid command>") : command || theme.fg("toolOutput", "...");
  const tag = showTag ? theme.fg("borderAccent", " [RTK]") : "";
  return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix + tag;
}

export async function executeOriginalBash(command: string, cwd: string, timeout: number | undefined, signal?: AbortSignal) {
  const ops = createLocalBashOperations();
  const chunks: Buffer[] = [];
  const onData = (data: Buffer) => chunks.push(Buffer.from(data));
  const getOutput = () => Buffer.concat(chunks).toString("utf-8");

  try {
    const result = await ops.exec(command, cwd, { onData, signal, timeout });
    const output = getOutput() || "(no output)";
    if (result.exitCode !== 0 && result.exitCode !== null) {
      return {
        content: [{ type: "text" as const, text: appendStatus(output, `Command exited with code ${result.exitCode}`) }],
        details: undefined,
        isError: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: output }],
      details: undefined,
      isError: false,
    };
  } catch (err) {
    const output = getOutput();
    if (err instanceof Error && err.message === "aborted") {
      return {
        content: [{ type: "text" as const, text: appendStatus(output, "Command aborted") }],
        details: undefined,
        isError: true,
      };
    }
    if (err instanceof Error && err.message.startsWith("timeout:")) {
      const timeoutSecs = err.message.split(":")[1];
      return {
        content: [{ type: "text" as const, text: appendStatus(output, `Command timed out after ${timeoutSecs} seconds`) }],
        details: undefined,
        isError: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: appendStatus(output, err instanceof Error ? err.message : "Command failed") }],
      details: undefined,
      isError: true,
    };
  }
}

// ── Fallback: output compression ───────────────────────────────────────────
// Used when RTK is not available.

type CompressStep = (text: string) => string;

const COMPRESS_STEPS: CompressStep[] = [
  (text) => text,
  (text) => {
    text = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    text = text.replace(/\n{4,}/g, "\n\n\n");
    return text;
  },
  (text) => deduplicateLines(text),
];

function compressByLevel(text: string, level: number): string {
  for (let i = 1; i <= level && i < COMPRESS_STEPS.length; i++) {
    text = COMPRESS_STEPS[i](text);
  }
  return text;
}

export function deduplicateLines(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let prev = "";
  let count = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed !== "" && trimmed === prev) {
      count++;
    } else {
      if (count > 2) {
        result.push(`<<< REPEAT ${count}x >>>`);
        result.push(prev);
        result.push("<<< END REPEAT >>>");
      } else if (count === 2) {
        result.push(prev);
      }
      result.push(line);
      prev = trimmed;
      count = trimmed === "" ? 0 : 1;
    }
  }

  if (count > 2) {
    result.push(`<<< REPEAT ${count}x >>>`);
    result.push(prev);
    result.push("<<< END REPEAT >>>");
  } else if (count === 2) {
    result.push(prev);
  }

  return result.join("\n");
}

// ── Command whitelist (fallback mode only) ─────────────────────────────────

const COMMAND_LEVELS: Record<string, number> = {
  ls: 1,
  tree: 1,
  dir: 1,
  "docker ps": 1,
  "docker images": 1,
  "git status": 2,
  "git log": 2,
  "git diff": 2,
  "git show": 2,
  "git branch": 2,
  "git stash": 2,
  "npm install": 2,
  "pnpm install": 2,
  "yarn install": 2,
  "bun install": 2,
  "pip install": 2,
  "cargo install": 2,
  "cargo test": 2,
  "cargo build": 2,
  "cargo clippy": 2,
  "go test": 2,
  "go build": 2,
  "go install": 2,
  pytest: 2,
  jest: 2,
  vitest: 2,
  mocha: 2,
  "npm test": 2,
  "pnpm test": 2,
  "npm run build": 2,
  "pnpm build": 2,
  "npm run lint": 2,
  "pnpm lint": 2,
  make: 2,
  cmake: 2,
  gradle: 2,
  mvn: 2,
  "docker build": 2,
  "docker compose": 2,
  kubectl: 2,
  podman: 2,
};

export function extractMainCommand(command: string): string {
  let cmd = command.trim().toLowerCase();
  cmd = cmd.replace(/^cd\s+\S+\s*(&&|;|\n)\s*/, "");
  cmd = cmd.replace(/^(?:[a-z_][a-z0-9_]*=\S*\s+)+/, "");
  const prefixes = ["sudo ", "time ", "nohup ", "nice ", "env "];
  for (const prefix of prefixes) {
    if (cmd.startsWith(prefix)) {
      cmd = cmd.slice(prefix.length);
    }
  }
  return cmd;
}

export function getCommandLevel(command: string): number {
  const stripped = extractMainCommand(command);
  let bestLevel = 0;
  let bestLen = 0;
  for (const [pattern, level] of Object.entries(COMMAND_LEVELS)) {
    if (stripped.startsWith(pattern) && pattern.length > bestLen) {
      bestLevel = level;
      bestLen = pattern.length;
    }
  }
  return bestLevel;
}

// ── Setup ──────────────────────────────────────────────────────────────────

export function setupToolCompress(pi: ExtensionAPI) {
  rtkBinary = findRtkBinary();
  const rewrittenCommands = new Map<string, { originalCommand: string; timeout?: number }>();
  const rewriteabilityCache = new Map<string, boolean>();

  if (rtkBinary) {
    const shellSettings = loadPiShellSettings(process.cwd());
    const bashTool = createBashToolDefinition(process.cwd(), {
      shellPath: shellSettings.shellPath,
      commandPrefix: shellSettings.shellCommandPrefix,
    });
    const baseRenderCall = bashTool.renderCall?.bind(bashTool);
    if (baseRenderCall) {
      bashTool.renderCall = (args, theme, context) => {
        const component = baseRenderCall(args, theme, context);
        const command = typeof args?.command === "string" ? args.command : "";
        const predicted = command
          ? (rewriteabilityCache.get(command) ?? (() => {
              const value = rewriteWithRtk(command) !== null;
              rewriteabilityCache.set(command, value);
              return value;
            })())
          : false;
        const rewritten = rewrittenCommands.has(context.toolCallId) || predicted;
        if (component instanceof Text) {
          component.setText(formatBashCallWithTag(args as any, theme, rewritten));
        }
        return component;
      };
    }
    pi.registerTool(bashTool);

    pi.on("tool_call", (event) => {
      if (!isToolCallEventType("bash", event)) return;
      const command = event.input.command;
      if (!command.trim()) return;
      const rewritten = rewriteWithRtk(command);
      rewriteabilityCache.set(command, rewritten !== null);
      if (!rewritten) return;
      rewrittenCommands.set(event.toolCallId, { originalCommand: command, timeout: event.input.timeout });
      event.input.command = rewritten;
    });

    pi.on("tool_result", async (event, ctx) => {
      if (event.toolName !== "bash") return;
      const pending = rewrittenCommands.get(event.toolCallId);
      if (!pending) return;
      rewrittenCommands.delete(event.toolCallId);
      if (!event.isError) return;
      return executeOriginalBash(pending.originalCommand, ctx.cwd, pending.timeout, ctx.signal);
    });

    pi.on("session_shutdown", () => {
      rewrittenCommands.clear();
      rewriteabilityCache.clear();
    });
    return;
  }

  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") return;

    const command = (event.input as any)?.command;
    if (typeof command !== "string" || !command.trim()) return;

    const level = getCommandLevel(command);
    if (level === 0) return;

    const content = event.content;
    if (!Array.isArray(content)) return;

    const newContent = content.map((item: any) => {
      if (item.type !== "text" || typeof item.text !== "string") return item;
      return { ...item, text: compressByLevel(item.text, level) };
    });

    return { content: newContent };
  });
}
