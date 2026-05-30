/**
 * RTK integration — Rewrite bash commands through system-installed RTK
 *
 * Uses `rtk rewrite` as a preflight step. If RTK is not installed on PATH,
 * this module stays inactive. When a rewritten RTK command fails, the original
 * command is executed once as a fallback.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createLocalBashOperations, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let rtkBinary: string | null = null;

interface PiShellSettings {
  shellPath?: string;
  shellCommandPrefix?: string;
}

export interface DependencyStatus {
  module: string;
  label: string;
  state: "ok" | "missing" | "n/a";
  detail?: string;
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

export function findSystemRtk(): string | null {
  try {
    if (process.platform === "win32") {
      const output = execFileSync("where", ["rtk"], { encoding: "utf-8" }).trim();
      return output.split(/\r?\n/)[0] || null;
    }
    const shell = process.env.SHELL || "sh";
    return execFileSync(shell, ["-lc", "command -v rtk"], { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildRtkCommand(raw: string, rtkBinaryPath: string): string {
  const binDir = path.dirname(rtkBinaryPath);
  return `export PATH=${shellQuote(binDir)}:$PATH && ${raw}`;
}

export function extractMainCommand(command: string): string {
  let cmd = command.trim().toLowerCase();
  cmd = cmd.replace(/^cd\s+\S+\s*(&&|;|\n)\s*/, "");
  cmd = cmd.replace(/^(?:[a-z_][a-z0-9_]*=\S*\s+)+/, "");
  const prefixes = ["sudo ", "time ", "nohup ", "nice ", "env "];
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of prefixes) {
      if (cmd.startsWith(prefix)) {
        cmd = cmd.slice(prefix.length);
        changed = true;
      }
    }
  }
  return cmd;
}

export function shouldBypassRtkRewrite(command: string): boolean {
  const main = extractMainCommand(command);
  if (!main.startsWith("find ") && main !== "find") return false;
  return /(^|\s)(-o|-or|-a|-and|-not|!|\(|\)|-exec|-ok|-delete|-prune|-printf|-print0)(\s|$)/.test(main);
}

export function rewriteWithRtk(command: string, rtkPath: string): string | null {
  if (shouldBypassRtkRewrite(command)) return null;

  // NOTE:
  // Some RTK versions return a non-zero exit code even when `rtk rewrite`
  // successfully prints a rewritten command to stdout (observed locally with
  // RTK 0.42.0 returning exit code 3 on success). Because of that, we treat
  // non-empty stdout as the source of truth and ignore the process exit code
  // here. Empty stdout still means “no rewrite available”.
  const result = spawnSync(rtkPath, ["rewrite", command], {
    encoding: "utf-8",
    timeout: 2000,
  });
  const raw = (result.stdout ?? "").trim();
  if (!raw) return null;
  return buildRtkCommand(raw, rtkPath);
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

export function getRtkDependencyStatuses(): DependencyStatus[] {
  return [{
    module: "rtk-integration",
    label: "rtk",
    state: findSystemRtk() ? "ok" : "missing",
    detail: "Install RTK so bash rewrite/tagging can activate.",
  }];
}

export function setupRtkIntegration(pi: ExtensionAPI) {
  rtkBinary = findSystemRtk();
  if (!rtkBinary) return;

  const rewrittenCommands = new Map<string, { originalCommand: string; timeout?: number }>();
  const rewriteabilityCache = new Map<string, boolean>();
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
            const value = rewriteWithRtk(command, rtkBinary!) !== null;
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
    const rewritten = rewriteWithRtk(command, rtkBinary!);
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
}
