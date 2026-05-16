/**
 * Safety — 安全防护模块
 *
 * - Command Guard:   拦截危险 bash 命令与 shell 覆盖写入（枚举式）
 * - Protected Paths: 禁止写入敏感路径
 * - Write Guard:     覆盖非空文件前确认
 * - Secret Redact:   API Key / Token 自动掩码
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { resolve } from "node:path";

// ─── 危险命令枚举 ──────────────────────────────────────────────────────────

const DANGEROUS_COMMANDS: [string, string[]][] = [
  ["rm", []],
  ["sudo", []],
  ["npm", ["publish"]],
  ["svn", ["commit", "revert"]],
  ["git", ["reset", "restore", "clean", "push", "revert"]],
];

const SAFE_REDIRECT_TARGETS = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
]);

const SHELL_SEGMENT_BREAKS = new Set(["|", "&&", "||", ";"]);
const SHELL_REDIRECT_OPERATORS = new Set([">", ">>", "1>", "1>>", "2>", "2>>", "&>", "&>>"]);

function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += command[i + 1]!;
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    if (ch === ";") {
      pushCurrent();
      tokens.push(";");
      continue;
    }

    if (ch === "|" || ch === "&") {
      if (i + 1 < command.length && command[i + 1] === ch) {
        pushCurrent();
        tokens.push(ch + ch);
        i += 1;
        continue;
      }
      if (ch === "|") {
        pushCurrent();
        tokens.push("|");
        continue;
      }
    }

    if (ch === ">") {
      let op = ">";
      if (i + 1 < command.length && command[i + 1] === ">") {
        op = ">>";
        i += 1;
      }
      if (current === "&" || /^\d+$/.test(current)) {
        op = current + op;
        current = "";
      } else {
        pushCurrent();
      }
      tokens.push(op);
      continue;
    }

    current += ch;
  }

  pushCurrent();
  return tokens;
}

function isExistingRegularFile(target: string, cwd: string): boolean {
  if (!target || SAFE_REDIRECT_TARGETS.has(target)) return false;
  try {
    return fs.statSync(resolve(cwd, target)).isFile();
  } catch {
    return false;
  }
}

function collectDangerousReasons(command: string, cwd: string): string[] {
  const tokens = tokenizeShell(command);
  const reasons: string[] = [];
  const seen = new Set<string>();

  const addReason = (reason: string) => {
    if (seen.has(reason)) return;
    seen.add(reason);
    reasons.push(reason);
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (SHELL_SEGMENT_BREAKS.has(token)) continue;

    for (const [cmd, subs] of DANGEROUS_COMMANDS) {
      const name = token.split("/").pop() ?? token;
      if (name !== cmd && name !== `${cmd}.exe`) continue;
      if (subs.length === 0) {
        addReason(`"${cmd}" is a dangerous command`);
        break;
      }
      const next = tokens[i + 1];
      if (next && subs.includes(next)) {
        addReason(`"${cmd} ${next}" is a dangerous command`);
        break;
      }
    }

    if (SHELL_REDIRECT_OPERATORS.has(token)) {
      const target = tokens[i + 1];
      if (target && isExistingRegularFile(target, cwd)) {
        addReason(`shell redirection would write to existing file "${target}"`);
      }
      continue;
    }

    const name = token.split("/").pop() ?? token;
    if (name !== "tee" && name !== "tee.exe") continue;

    for (let j = i + 1; j < tokens.length; j++) {
      const next = tokens[j]!;
      if (SHELL_SEGMENT_BREAKS.has(next)) break;
      if (next === "-a" || next === "--append") continue;
      if (next.startsWith("-")) continue;
      if (isExistingRegularFile(next, cwd)) {
        addReason(`"tee" would write to existing file "${next}"`);
      }
    }
  }

  return reasons;
}

function formatDangerousReasons(reasons: string[]): string | null {
  if (reasons.length === 0) return null;
  if (reasons.length === 1) return reasons[0]!;
  return `dangerous operations detected:\n- ${reasons.join("\n- ")}`;
}

function checkDangerous(command: string, cwd: string): string | null {
  return formatDangerousReasons(collectDangerousReasons(command, cwd));
}

// ─── Protected Paths ────────────────────────────────────────────────────────

const PROTECTED_PATH_SEGMENTS = [
  ".env", ".git/", "node_modules/", ".ssh/",
  ".gnupg/", ".aws/", "secrets/", ".docker/",
];
const PROTECTED_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".keystore"];
const PROTECTED_FILENAMES = [
  "id_rsa", "id_ed25519", "id_ecdsa",
  "authorized_keys", "known_hosts",
  ".env.local", ".env.production",
];

function checkProtectedPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const filename = normalized.split("/").pop() ?? "";
  for (const seg of PROTECTED_PATH_SEGMENTS) {
    if (normalized.includes(seg)) return `path contains "${seg}"`;
  }
  for (const ext of PROTECTED_EXTENSIONS) {
    if (normalized.endsWith(ext)) return `file extension "${ext}"`;
  }
  for (const name of PROTECTED_FILENAMES) {
    if (filename === name) return `protected file "${name}"`;
  }
  return null;
}

// ─── Secret Redact ──────────────────────────────────────────────────────────

import { createEngine } from "@secretlint/node";

type SecretLintEngine = Awaited<ReturnType<typeof createEngine>>;
type ToolTextContent = Extract<NonNullable<ToolResultEvent["content"]>[number], { type: "text" }>;

let engine: SecretLintEngine | null = null;

function maskSecret(text: string): string {
  if (text.length <= 8) return "********";
  return text.slice(0, 4) + "********" + text.slice(-4);
}

async function ensureEngine(): Promise<SecretLintEngine> {
  if (!engine) {
    engine = await createEngine({
      formatter: "json",
      color: false,
      maskSecrets: false,
      configFileJSON: {
        rules: [
          { id: "@secretlint/secretlint-rule-preset-recommend" },
          { id: "@secretlint/secretlint-rule-azure" },
          { id: "@secretlint/secretlint-rule-secp256k1-privatekey" },
        ],
      },
    });
  }
  return engine;
}

function extractRanges(jsonOutput: string): Array<{ start: number; end: number }> {
  try {
    const reports = JSON.parse(jsonOutput) as Array<{
      messages: Array<{ range: [number, number]; ruleId: string }>;
    }>;
    const ranges: Array<{ start: number; end: number }> = [];
    for (const report of reports) {
      for (const msg of report.messages) {
        ranges.push({ start: msg.range[0], end: msg.range[1] });
      }
    }
    const unique = new Map<string, { start: number; end: number }>();
    for (const r of ranges) unique.set(`${r.start}-${r.end}`, r);
    return [...unique.values()].sort((a, b) => b.start - a.start);
  } catch { return []; }
}

// ─── Setup ──────────────────────────────────────────────────────────────────

export function setupSafety(pi: ExtensionAPI) {
  // ── Command Guard + Protected Paths + Write Guard (tool_call) ─────────

  pi.on("tool_call", async (event, ctx) => {
    
    // Gate 1: 危险命令
    if (event.toolName === "bash") {
      const command = (event.input as { command?: string }).command;
      if (command) {
        const danger = checkDangerous(command, ctx.cwd);
        if (danger) {
          if (!ctx.hasUI) {
            return { block: true, reason: `⛔ ${danger} (non-interactive)` };
          }
          const choice = await ctx.ui.select(
            `⚠️  ${danger}\n\nAllow execution?`,
            ["Block", "Allow once"],
          );
          if (!choice || choice === "Block") {
            return { block: true, reason: `⛔ ${danger}` };
          }
        }
      }
    }

    // Gate 2: 保护路径
    if (event.toolName === "write" || event.toolName === "edit") {
      const filePath = (event.input as any).path ?? (event.input as any).file ?? (event.input as any).file_path;
      if (filePath) {
        const danger = checkProtectedPath(filePath);
        if (danger) {
          if (!ctx.hasUI) {
            return { block: true, reason: `🔐 ${danger}` };
          }
          const choice = await ctx.ui.select(
            `🔐 ${danger}\n\nProceed?`,
            ["Block", "Allow once"],
          );
          if (!choice || choice === "Block") {
            return { block: true, reason: `🔐 ${danger}` };
          }
        }
      }
    }

    // Gate 3: 写保护（已有内容的文件禁止 write，直接返回信息给 agent）
    if (event.toolName === "write") {
      const filePath = (event.input as any).path ?? (event.input as any).file ?? (event.input as any).file_path;
      if (filePath) {
        try {
          const abs = resolve(ctx.cwd, filePath);
          if (fs.existsSync(abs) && fs.readFileSync(abs, "utf8").length > 0) {
            return { block: true, reason: "Overwriting a non-empty file is dangerous, use the edit tool instead!" };
          }
        } catch { /* file doesn't exist */ }
      }
    }
  });

  // ── Secret Redact (tool_result) ────────────────────────────────────────

  const handleToolResult = async (
    event: ToolResultEvent,
    ctx: ExtensionContext,
  ): Promise<{ content?: NonNullable<ToolResultEvent["content"]> } | void> => {
    if (!event.content || !Array.isArray(event.content)) return;

    const textParts: Array<{ index: number; text: string; item: ToolTextContent }> = [];
    for (let i = 0; i < event.content.length; i++) {
      const item = event.content[i];
      if (item.type === "text" && typeof item.text === "string" && item.text.length > 0) {
        textParts.push({ index: i, text: item.text, item });
      }
    }
    if (textParts.length === 0) return;

    const eng = await ensureEngine();
    let totalCount = 0;
    const newContent = [...event.content];

    for (const { index, text, item } of textParts) {
      const result = await eng.executeOnContent({ content: text, filePath: "tool-output.txt" });
      const ranges = extractRanges(result.output);
      if (ranges.length === 0) continue;

      totalCount += ranges.length;
      let redacted = text;
      for (const { start, end } of ranges) {
        const original = redacted.slice(start, end);
        redacted = redacted.slice(0, start) + maskSecret(original) + redacted.slice(end);
      }
      const updatedItem: ToolTextContent = { ...item, text: redacted };
      newContent[index] = updatedItem;
    }

    if (totalCount === 0) return;
    const label = totalCount === 1 ? "1 secret" : `${totalCount} secrets`;
    ctx.ui.notify(`🔐 Redacted ${label} in ${event.toolName} output`, "warning");
    return { content: newContent };
  };

  pi.on("tool_result", handleToolResult);
}
