/**
 * rtk — rewrite bash commands through system-installed RTK.
 *
 * Uses `rtk rewrite` as a preflight. If RTK is not installed, this module is inactive.
 * When a rewritten RTK command fails, the original command is executed once as fallback.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Module, Skeleton } from "./skeleton.js";

// ─── Locating RTK ─────────────────────────────────────────────────────────

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

export function rewriteWithRtk(command: string, rtkPath: string): string | null {
  const result = spawnSync(rtkPath, ["rewrite", command], { encoding: "utf-8", timeout: 2000 });
  const raw = (result.stdout ?? "").trim();
  if (!raw) return null;
  return buildRtkCommand(raw, rtkPath);
}

// ─── Bash tool registration ──────────────────────────────────────────────

interface PiShellSettings {
  shellPath?: string;
  shellCommandPrefix?: string;
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

export function appendStatus(text: string, status: string): string {
  return text ? `${text}\n\n${status}` : status;
}

export function formatBashCallWithTag(args: { command?: unknown; timeout?: unknown }, theme: any, showTag: boolean): string {
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
        content: [{ type: "text" as const, text: output ? `${output}\n\nCommand exited with code ${result.exitCode}` : `Command exited with code ${result.exitCode}` }],
        details: undefined,
        isError: true,
      };
    }
    return { content: [{ type: "text" as const, text: output }], details: undefined, isError: false };
  } catch (err) {
    const output = getOutput();
    if (err instanceof Error && err.message === "aborted") {
      return { content: [{ type: "text" as const, text: output ? `${output}\n\nCommand aborted` : "Command aborted" }], details: undefined, isError: true };
    }
    if (err instanceof Error && err.message.startsWith("timeout:")) {
      const timeoutSecs = err.message.split(":")[1];
      return { content: [{ type: "text" as const, text: output ? `${output}\n\nCommand timed out after ${timeoutSecs} seconds` : `Command timed out after ${timeoutSecs} seconds` }], details: undefined, isError: true };
    }
    return { content: [{ type: "text" as const, text: output ? `${output}\n\n${err instanceof Error ? err.message : "Command failed"}` : (err instanceof Error ? err.message : "Command failed") }], details: undefined, isError: true };
  }
}

// ─── Module + setup ──────────────────────────────────────────────────────

let rtkBinary: string | null = null;
const rewrittenCommands = new Map<string, { originalCommand: string; timeout?: number }>();
const rewriteabilityCache = new Map<string, boolean>();

export const rtkModule: Module = {
  name: "rtk",
  hooks: {
    tool_call: [
      (event) => {
        if (event.toolName !== "bash") return;
        const command = event.input?.command;
        if (!command || typeof command !== "string" || !command.trim()) return;
        const rewritten = rewriteWithRtk(command, rtkBinary!);
        rewriteabilityCache.set(command, rewritten !== null);
        if (!rewritten) return;
        rewrittenCommands.set(event.toolCallId, { originalCommand: command, timeout: event.input?.timeout });
        event.input.command = rewritten;
      },
    ],
    tool_result: [
      async (event, ctx) => {
        if (event.toolName !== "bash") return;
        const pending = rewrittenCommands.get(event.toolCallId);
        if (!pending) return;
        rewrittenCommands.delete(event.toolCallId);
        if (!event.isError) return;
        return executeOriginalBash(pending.originalCommand, ctx.cwd, pending.timeout, ctx.signal);
      },
    ],
    session_shutdown: [
      () => {
        rewrittenCommands.clear();
        rewriteabilityCache.clear();
      },
    ],
  },
};

export function setupRtk(sk: Skeleton, pi: ExtensionAPI): void {
  rtkBinary = findSystemRtk();
  sk.declareDependency({
    label: "rtk",
    check: () => findSystemRtk() !== null,
    hint: "Install RTK so bash rewrite/tagging can activate.",
  });
  if (!rtkBinary) return;

  // Register a wrapped bash tool that shows [RTK] tag in TUI.
  const shellSettings = loadPiShellSettings(process.cwd());
  const bashTool = createBashToolDefinition(process.cwd(), {
    shellPath: shellSettings.shellPath,
    commandPrefix: shellSettings.shellCommandPrefix,
  });
  const baseRenderCall = bashTool.renderCall?.bind(bashTool);

  if (baseRenderCall) {
    bashTool.renderCall = (args: any, theme: any, context: any) => {
      const command = typeof args?.command === "string" ? args.command : "";
      if (!command) {
        const text = context.lastComponent ?? new Text("", 0, 0);
        const placeholder = theme.fg("toolOutput", "...");
        text.setText(theme.fg("toolTitle", theme.bold(`$ ${placeholder}`)));
        return text;
      }
      const component = baseRenderCall(args, theme, context);
      const predicted = command
        ? (rewriteabilityCache.get(command) ?? (() => {
            const value = rewriteWithRtk(command, rtkBinary!) !== null;
            rewriteabilityCache.set(command, value);
            return value;
          })())
        : false;
      const rewritten = rewrittenCommands.has(context.toolCallId) || predicted;
      if (component instanceof Text) {
        component.setText(formatBashCallWithTag(args, theme, rewritten));
      }
      return component;
    };
  }

  pi.registerTool(bashTool);
  sk.register(rtkModule);
}
