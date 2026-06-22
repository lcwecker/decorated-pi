/**
 * rtk — rewrite bash commands through system-installed RTK.
 *
 * Uses `rtk rewrite` as a preflight against pi's built-in bash tool. If RTK is
 * not installed, this module is inactive. When a rewritten RTK command fails,
 * the original command is executed once as fallback.
 *
 * We do NOT register our own bash tool. We hook the existing one via
 * `tool_call` (rewrite the command before it runs) and `tool_result` (fall
 * back to the original on error). Overriding bash via `pi.registerTool` would
 * conflict with other extensions (e.g. pi-sandbox) that also override bash.
 */

import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { execFileSync, spawnSync } from "node:child_process";
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

// ─── Fallback execution ──────────────────────────────────────────────────

export function appendStatus(text: string, status: string): string {
  return text ? `${text}\n\n${status}` : status;
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

export function setupRtk(sk: Skeleton): void {
  rtkBinary = findSystemRtk();
  const ready = sk.declareDependency({
    label: "rtk",
    module: "rtk",
    check: () => findSystemRtk() !== null,
    hint: "Install RTK so bash rewrite can activate.",
  });
  if (!ready) return;

  // Hook pi's built-in bash tool via tool_call/tool_result. We deliberately do
  // not call pi.registerTool — that would shadow pi's bash and conflict with
  // any other extension that also overrides bash (e.g. pi-sandbox).
  sk.register(rtkModule);
}
