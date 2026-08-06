/**
 * Headless code-review runner and history renderer.
 *
 * /code-review starts the child process directly, then delivers the completed
 * report to the parent session through its ordinary prompt path.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  getMarkdownTheme,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { which } from "../../utils/which.js";

export const CODE_REVIEW_VIEW_MESSAGE = "code-review-view";
export const CODE_REVIEW_RESULT_MESSAGE = "code-review-result";
export const CODE_REVIEW_STATE_ENTRY = "decorated-pi.code-review-state";

const REVIEWER_SYSTEM_PROMPT = [
  "You are a senior code reviewer. Review the current changes or the scope described in the task.",
  "",
  "Guidelines:",
  "- This is a strictly read-only review. Use tools only to inspect the changes and surrounding code.",
  "- Inspect the current changes yourself with read-only SCM commands (git status/diff, svn status/diff) when a repository is present.",
  "- When there is no repository, review exactly the scope described in the task.",
  "- Do not modify files, SCM state, configuration, dependencies, or the environment.",
  "- Focus on correctness, bugs, security, performance, maintainability, and tests.",
  "- Cite file paths and relevant code context for each finding.",
  "- Classify findings by severity and explain concrete impact.",
  "- If the changes are clean, state that explicitly.",
  "- Finish with a complete final review report.",
  "- Be direct and specific. Do not add filler.",
].join("\n");

export interface ReviewUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface ReviewRunDetails {
  status: "running" | "done" | "error" | "aborted";
  scm?: "git" | "svn";
  model: string;
  changedFiles?: number;
  messages: AssistantMessage[];
  stderr?: string;
  error?: string;
  usage: ReviewUsage;
}

interface ReviewRunResult extends ReviewRunDetails {
  exitCode: number;
  stopReason?: string;
  errorMessage?: string;
}

interface ActiveCodeReview {
  runId: string;
  controller: AbortController;
  details: ReviewRunDetails;
  requestRender: () => void;
  unsubscribeInput?: () => void;
  suppressDelivery: boolean;
}

export function emptyUsage(): ReviewUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export class CodeReviewRuntime {
  active: ActiveCodeReview | null = null;
  private readonly runs = new Map<string, ReviewRunDetails>();

  begin(active: ActiveCodeReview): boolean {
    if (this.active) return false;
    this.active = active;
    this.runs.set(active.runId, active.details);
    active.requestRender();
    return true;
  }

  get(runId: string): ReviewRunDetails | undefined {
    return this.runs.get(runId);
  }

  restore(runId: string, details: ReviewRunDetails): void {
    this.runs.set(runId, details);
  }

  update(runId: string, details: ReviewRunDetails): boolean {
    if (this.active?.runId !== runId) return false;
    this.active.details = details;
    this.runs.set(runId, details);
    this.active.requestRender();
    return true;
  }

  attachInput(runId: string, unsubscribe: () => void): void {
    if (this.active?.runId === runId) this.active.unsubscribeInput = unsubscribe;
    else unsubscribe();
  }

  complete(runId: string, details: ReviewRunDetails): boolean {
    const active = this.active;
    if (!active || active.runId !== runId) return false;
    this.runs.set(runId, details);
    active.details = details;
    active.unsubscribeInput?.();
    active.requestRender();
    this.active = null;
    return !active.suppressDelivery;
  }

  abort(): boolean {
    if (!this.active) return false;
    this.active.details = {
      ...this.active.details,
      status: "aborted",
      error: "Code review was cancelled.",
    };
    this.runs.set(this.active.runId, this.active.details);
    this.active.requestRender();
    this.active.controller.abort();
    return true;
  }

  shutdown(): { runId: string; details: ReviewRunDetails } | undefined {
    if (!this.active) return undefined;
    this.active.suppressDelivery = true;
    this.active.unsubscribeInput?.();
    this.active.details = {
      ...this.active.details,
      status: "aborted",
      error: "Code review was cancelled because the session closed.",
    };
    this.runs.set(this.active.runId, this.active.details);
    this.active.controller.abort();
    return { runId: this.active.runId, details: this.active.details };
  }
}

export function detectScm(cwd: string): "git" | "svn" | null {
  let dir = cwd;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return "git";
    if (fs.existsSync(path.join(dir, ".svn"))) return "svn";
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const text = message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (text) return text;
  }
  return "";
}

export function getScmStatusArgs(scm: "git" | "svn"): string[] {
  return scm === "git" ? ["status", "--short", "--untracked-files=all"] : ["status"];
}

/**
 * True when status contains at least one tracked change. Any status row
 * other than untracked or ignored counts: A/M/D/R/C/U/T, svn missing (!),
 * replaced (R), etc. Pure untracked rows (git "??", svn "? ") and ignored
 * rows (git "!", svn "I") do not — they need an explicit prompt to scope
 * the review.
 */
export function hasTrackedChanges(scm: "git" | "svn", status: string): boolean {
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    const x = line[0];
    const y = line[1];
    if (x === "?" || y === "?") continue; // untracked (git "??", svn "? ")
    if (scm === "git" && (x === "!" || y === "!")) continue; // git ignored
    if (scm === "svn" && x === "I") continue; // svn ignored
    return true;
  }
  return false;
}

export function buildReviewTask(scm: "git" | "svn" | null, prompt: string): string {
  const context = scm
    ? [
        `The current project's SCM is ${scm}.`,
        "Inspect the current changes yourself with read-only SCM commands:",
        scm === "git"
          ? "  git status --short --untracked-files=all, git diff, git diff --cached"
          : "  svn status, svn diff",
        "Review the changes you find and the relevant surrounding code.",
      ]
    : [
        "There is no version control in the current directory.",
        "Review exactly the scope described below using the available tools.",
      ];
  return [
    ...context,
    "",
    prompt.trim(),
    "Report actionable findings when the review is complete.",
  ].filter(Boolean).join("\n");
}

export function buildReviewerArgs(model: string): string[] {
  return [
    "--mode", "json", "-p", "--no-session",
    "--model", model,
    "--append-system-prompt", REVIEWER_SYSTEM_PROMPT,
  ];
}

function getPiInvocation(args: string[], cwd = process.cwd()): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }
  const piCommand = which("pi", {
    extendPath: [path.join(cwd, "node_modules", ".bin")],
  });
  if (!piCommand) {
    throw new Error("Unable to locate the Pi CLI. Start Pi from its installed executable or add 'pi' to PATH.");
  }
  return { command: piCommand, args };
}

export async function runReviewSubprocess(
  args: string[],
  task: string,
  cwd: string,
  signal: AbortSignal | undefined,
  onProgress: (result: ReviewRunResult) => void,
  model: string,
): Promise<ReviewRunResult> {
  const result: ReviewRunResult = {
    status: "running",
    exitCode: 0,
    model,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
  };
  let aborted = false;

  result.exitCode = await new Promise<number>((resolve) => {
    const invocation = getPiInvocation(args, cwd);
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdin.on("error", (error) => { result.stderr += error.message; });
    proc.stdin.end(task);
    let buffer = "";
    let settled = false;
    let protocolEnded = false;
    let cleanupRequested = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let partialAssistant: AssistantMessage | undefined;

    const progress = (messages = result.messages) => {
      onProgress({ ...result, messages: [...messages], usage: { ...result.usage } });
    };
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (settleTimer) clearTimeout(settleTimer);
      if (forceKill) clearTimeout(forceKill);
      signal?.removeEventListener("abort", killForAbort);
      resolve(code);
    };
    const terminate = (graceMs = 5000) => {
      if (settled || proc.exitCode !== null) return;
      proc.kill("SIGTERM");
      if (forceKill) clearTimeout(forceKill);
      forceKill = setTimeout(() => {
        if (!settled && proc.exitCode === null) proc.kill("SIGKILL");
      }, graceMs);
      forceKill.unref();
    };
    const requestProtocolCleanup = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        cleanupRequested = true;
        terminate(1000);
      }, 1000);
      settleTimer.unref();
    };
    const cancelProtocolCleanup = () => {
      protocolEnded = false;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = undefined;
    };
    const killForAbort = () => {
      aborted = true;
      terminate();
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }

      if (event.type === "message_update" && event.message?.role === "assistant") {
        partialAssistant = event.message as AssistantMessage;
        const updateType = event.assistantMessageEvent?.type;
        if (updateType === "thinking_end" || updateType === "text_end" || updateType === "toolcall_end") {
          progress([...result.messages, partialAssistant]);
        }
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const completed = event.message as AssistantMessage;
        const message = completed.content.length || !partialAssistant?.content.length
          ? completed
          : { ...completed, content: partialAssistant.content };
        partialAssistant = undefined;
        result.messages.push(message);
        result.usage.turns++;
        const usage = message.usage;
        if (usage) {
          result.usage.input += usage.input || 0;
          result.usage.output += usage.output || 0;
          result.usage.cacheRead += usage.cacheRead || 0;
          result.usage.cacheWrite += usage.cacheWrite || 0;
          result.usage.cost += usage.cost?.total || 0;
        }
        if (message.model) result.model = message.model;
        if (message.stopReason) result.stopReason = message.stopReason;
        result.errorMessage = message.errorMessage;
        progress();
      }
      if (event.type === "tool_execution_start") {
        const lastIndex = result.messages.length - 1;
        const last = result.messages[lastIndex];
        const alreadyRecorded = last?.content.some(
          (part) => part.type === "toolCall" && part.id === event.toolCallId,
        );
        if (last && !alreadyRecorded) {
          result.messages[lastIndex] = {
            ...last,
            content: [
              ...last.content,
              {
                type: "toolCall",
                id: event.toolCallId,
                name: event.toolName,
                arguments: event.args,
              },
            ],
          };
          progress();
        }
      }
      if (event.type === "agent_start" || event.type === "auto_retry_start" || event.type === "compaction_start") {
        cancelProtocolCleanup();
      }
      if (event.type === "agent_end") {
        protocolEnded = true;
        requestProtocolCleanup();
      }
      if (event.type === "compaction_end" || (event.type === "auto_retry_end" && event.success === false)) {
        protocolEnded = true;
        requestProtocolCleanup();
      }
    };

    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
    proc.stderr.on("data", (chunk) => { result.stderr += chunk.toString(); });
    proc.on("close", (code, childSignal) => {
      if (buffer.trim()) processLine(buffer);
      const endedByProtocolCleanup = cleanupRequested && protocolEnded &&
        (code === 143 || childSignal === "SIGTERM" || childSignal === "SIGKILL");
      finish(endedByProtocolCleanup ? 0 : code ?? 1);
    });
    proc.on("error", (error) => {
      result.stderr += error instanceof Error ? error.message : String(error);
      finish(1);
    });

    if (signal?.aborted) killForAbort();
    else signal?.addEventListener("abort", killForAbort, { once: true });
  });

  if (aborted) throw new Error("Code review was aborted.");
  return result;
}

export function getReviewFailure(result: ReviewRunResult): string | undefined {
  if (
    result.exitCode === 0 &&
    result.stopReason !== "error" &&
    result.stopReason !== "aborted" &&
    !result.errorMessage
  ) return undefined;
  return result.errorMessage || result.stderr?.trim() ||
    (result.stopReason === "error" || result.stopReason === "aborted"
      ? `Reviewer stopped with reason: ${result.stopReason}.`
      : `Reviewer exited with ${result.exitCode}.`);
}

type ReviewDisplayItem =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; args: any };

export function displayItems(messages: Message[]): ReviewDisplayItem[] {
  const items: ReviewDisplayItem[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "thinking" && part.thinking.trim()) {
        items.push({ type: "thinking", text: part.thinking });
      }
      if (part.type === "text" && part.text.trim()) items.push({ type: "text", text: part.text });
      if (part.type === "toolCall") items.push({ type: "tool", name: part.name, args: part.arguments });
    }
  }
  return items;
}

export function reviewStatusLabel(status: ReviewRunDetails["status"]): string {
  if (status === "running") return "reviewing";
  if (status === "done") return "reviewed";
  if (status === "aborted") return "review cancelled";
  return "review failed";
}

export function formatUsage(usage: ReviewUsage): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.input) parts.push(`↑${usage.input}`);
  if (usage.output) parts.push(`↓${usage.output}`);
  if (usage.cacheRead) parts.push(`R${usage.cacheRead}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join("  ");
}

export function renderReviewDetails(
  details: ReviewRunDetails,
  expanded: boolean,
  theme: any,
): Container {
  const component = new Container();
  const icon = details.status === "done" ? theme.fg("success", "✓")
    : details.status === "running" ? theme.fg("warning", "⏳")
    : theme.fg("error", "✗");
  component.addChild(new Text(
    `${icon} ${theme.fg("accent", reviewStatusLabel(details.status))}` +
    (details.scm ? theme.fg("muted", ` [${details.scm}]`) : ""),
    0,
    0,
  ));
  if (!expanded) return component;

  const finalOutput = getFinalOutput(details.messages);
  const items = displayItems(details.messages);
  const lastItem = items.at(-1);
  if (details.status === "done" && finalOutput && lastItem?.type === "text" && lastItem.text === finalOutput) {
    items.pop();
  }
  for (const item of items) {
    component.addChild(new Spacer(1));
    if (item.type === "tool") {
      component.addChild(new Text(theme.fg("muted", `→ ${item.name} ${JSON.stringify(item.args)}`), 0, 0));
    } else if (item.type === "thinking") {
      component.addChild(new Text(theme.fg("dim", `Thinking: ${item.text}`), 0, 0));
    } else {
      component.addChild(new Text(theme.fg("toolOutput", item.text), 0, 0));
    }
  }
  if (details.status === "done" && finalOutput) {
    component.addChild(new Spacer(1));
    component.addChild(new Markdown(finalOutput, 0, 0, getMarkdownTheme()));
  }
  if (details.error) {
    component.addChild(new Spacer(1));
    component.addChild(new Text(theme.fg("error", details.error), 0, 0));
  }
  const usage = formatUsage(details.usage);
  if (usage) {
    component.addChild(new Spacer(1));
    component.addChild(new Text(theme.fg("dim", usage), 0, 0));
  }
  return component;
}

class LiveReviewComponent extends Container {
  constructor(
    private readonly runtime: CodeReviewRuntime,
    private readonly runId: string,
    private readonly expanded: boolean,
    private readonly theme: any,
  ) {
    super();
  }

  render(width: number): string[] {
    this.clear();
    const details = this.runtime.get(this.runId) ?? {
      status: "error" as const,
      model: "unknown",
      messages: [],
      error: "Code review state is unavailable.",
      usage: emptyUsage(),
    };
    // Mirror Pi's ToolExecutionComponent shell: one padded Box whose background
    // changes from pending to success/error, with renderCall then renderResult.
    const bg = details.status === "running" ? "toolPendingBg"
      : details.status === "done" ? "toolSuccessBg"
      : "toolErrorBg";
    const box = new Box(1, 1, (text) => this.theme.bg(bg, text));
    box.addChild(new Text(
      this.theme.fg("toolTitle", this.theme.bold("code-review")) +
      this.theme.fg("muted", ` ${details.model}`),
      0,
      0,
    ));
    box.addChild(renderReviewDetails(details, this.expanded, this.theme));
    this.addChild(box);
    return super.render(width);
  }
}

export function registerCodeReviewRenderer(pi: ExtensionAPI, runtime: CodeReviewRuntime): void {
  pi.registerMessageRenderer<{ runId: string }>(
    CODE_REVIEW_VIEW_MESSAGE,
    (message, { expanded }, theme) => new LiveReviewComponent(
      runtime,
      String((message.details as any)?.runId ?? ""),
      expanded,
      theme,
    ),
  );
}

export const __codeReviewTest = {
  reviewerSystemPrompt: REVIEWER_SYSTEM_PROMPT,
  getPiInvocation,
};
