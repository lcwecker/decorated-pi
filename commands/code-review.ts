/**
 * /code-review — run an isolated headless review as an extension-owned task.
 *
 * The task is never exposed as an LLM-callable tool. Its visible custom message
 * is filtered from model context; on success a hidden result message starts a
 * normal parent-model turn, using the same path as /retry.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { getCodeReviewModelKey, parseModelKey } from "../settings.js";
import {
  CODE_REVIEW_RESULT_MESSAGE,
  CODE_REVIEW_STATE_ENTRY,
  CODE_REVIEW_VIEW_MESSAGE,
  CodeReviewRuntime,
  buildReviewerArgs,
  buildReviewTask,
  detectScm,
  emptyUsage,
  getFinalOutput,
  getReviewFailure,
  getScmStatusArgs,
  hasTrackedChanges,
  runReviewSubprocess,
  type ReviewRunDetails,
} from "../tools/code-review/index.js";

function resolveConfiguredReviewModel(ctx: any): Model<any> | null {
  const configured = getCodeReviewModelKey();
  if (!configured) return ctx.model ?? null;
  const parsed = parseModelKey(configured);
  if (!parsed) return null;
  return ctx.modelRegistry.find(parsed.provider, parsed.modelId) ?? null;
}

function reviewResultPrompt(report: string): string {
  return [
    "The isolated code reviewer returned this report:",
    "",
    "<code-review-result>",
    report,
    "</code-review-result>",
    "",
    "Analyze the report and respond to the user.",
  ].join("\n");
}

export function registerCodeReviewCommand(pi: ExtensionAPI, runtime: CodeReviewRuntime): void {
  pi.registerCommand("code-review", {
    description: "Review current SCM changes or a specified file/directory with an isolated headless Pi process",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current agent turn to finish before starting code review.", "warning");
        return;
      }
      if (runtime.active) {
        ctx.ui.notify("A code review is already running. Press Esc to cancel it.", "warning");
        return;
      }
      const scm = detectScm(ctx.cwd);
      const prompt = args.trim();
      if (!scm && !prompt) {
        ctx.ui.notify(
          "No git/svn repository found. Describe what to review, e.g. /code-review <file-or-directory>.",
          "warning",
        );
        return;
      }
      const reviewModel = resolveConfiguredReviewModel(ctx);
      if (!reviewModel) {
        ctx.ui.notify("Configured review model was not found. Set it via /dp-model → Review.", "warning");
        return;
      }
      const reviewAuth = await ctx.modelRegistry.getApiKeyAndHeaders(reviewModel);
      if (!reviewAuth.ok) {
        ctx.ui.notify(`Review model auth failed: ${reviewAuth.error}`, "warning");
        return;
      }

      const controller = new AbortController();
      // Status preflight only without an explicit scope: a clean tree or
      // only untracked files would waste a review round. Prompted reviews
      // run regardless so a named file/directory can be reviewed even when
      // SCM is broken or the tree is clean (e.g. gitignored files).
      if (scm && !prompt) {
        let statusResult: { stdout: string; stderr: string; code: number };
        try {
          statusResult = await pi.exec(scm, getScmStatusArgs(scm), {
            cwd: ctx.cwd,
            signal: controller.signal,
          });
        } catch (error) {
          ctx.ui.notify(
            `${scm} status failed: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          return;
        }
        if (statusResult.code !== 0) {
          ctx.ui.notify(`${scm} status failed: ${statusResult.stderr.trim() || `exit ${statusResult.code}`}`, "error");
          return;
        }
        if (!statusResult.stdout.trim()) {
          ctx.ui.notify(
            `No changes detected in the ${scm} working tree. Describe what to review, e.g. /code-review <file-or-directory>.`,
            "warning",
          );
          return;
        }
        if (!hasTrackedChanges(scm, statusResult.stdout)) {
          ctx.ui.notify(
            `Only untracked files found in the ${scm} working tree. Describe what to review, e.g. /code-review <file-or-directory>.`,
            "warning",
          );
          return;
        }
      }

      const reviewModelKey = `${reviewModel.provider}/${reviewModel.id}`;
      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const initial: ReviewRunDetails = {
        status: "running",
        scm: scm ?? undefined,
        model: reviewModelKey,
        messages: [],
        usage: emptyUsage(),
      };
      const requestRender = () => {
        try {
          // Setting an absent status still invalidates the TUI, keeping the
          // live review card current without adding text to the footer.
          ctx.ui.setStatus("code-review", undefined);
        } catch {
          // The command context can become stale after session replacement.
        }
      };
      if (!runtime.begin({
        runId,
        controller,
        details: initial,
        requestRender,
        suppressDelivery: false,
      })) {
        ctx.ui.notify("A code review is already running.", "warning");
        return;
      }

      pi.sendMessage({
        customType: CODE_REVIEW_VIEW_MESSAGE,
        content: "Code review",
        display: true,
        details: { runId },
      });

      const unsubscribe = ctx.ui.onTerminalInput((data) => {
        if (!matchesKey(data, "escape")) return undefined;
        runtime.abort();
        return { consume: true };
      });
      runtime.attachInput(runId, unsubscribe);

      const finish = (details: ReviewRunDetails) => {
        const shouldDeliver = runtime.complete(runId, details);
        try { ctx.ui.setStatus("code-review", undefined); } catch { /* stale context */ }
        if (!shouldDeliver) return;
        pi.appendEntry(CODE_REVIEW_STATE_ENTRY, { runId, details });
        if (details.status === "done") {
          const report = getFinalOutput(details.messages);
          const resultMessage = {
            customType: CODE_REVIEW_RESULT_MESSAGE,
            content: reviewResultPrompt(report),
            display: false,
            details: { runId },
          };
          // deliverAs works in both states: it queues while streaming and is
          // ignored by the ordinary prompt path while idle. The empty user
          // message has no visible bubble but still runs before_agent_start.
          pi.sendMessage(resultMessage, { deliverAs: "followUp" });
          pi.sendUserMessage("", { deliverAs: "followUp" });
        } else if (details.status === "error") {
          ctx.ui.notify(details.error || "Code review failed.", "error");
        }
      };

      const task = buildReviewTask(scm, prompt);
      void runReviewSubprocess(
        buildReviewerArgs(reviewModelKey),
        task,
        ctx.cwd,
        controller.signal,
        (partial) => runtime.update(runId, {
          ...partial,
          status: "running",
          scm: scm ?? undefined,
        }),
        reviewModelKey,
      ).then((result) => {
        const review = getFinalOutput(result.messages);
        const failure = getReviewFailure(result) ||
          (!review ? "Reviewer completed without returning a report." : undefined);
        if (failure) {
          finish({
            ...result,
            status: "error",
            scm: scm ?? undefined,
            error: review ? `${failure}\n\nPartial reviewer output:\n${review}` : failure,
          });
          return;
        }
        finish({ ...result, status: "done", scm: scm ?? undefined });
      }).catch((error) => {
        const aborted = controller.signal.aborted;
        finish({
          ...runtime.get(runId) ?? initial,
          status: aborted ? "aborted" : "error",
          scm: scm ?? undefined,
          error: aborted ? "Code review was cancelled." : error instanceof Error ? error.message : String(error),
        });
      });
    },
  });
}

export const __codeReviewCommandTest = {
  resolveConfiguredReviewModel,
  reviewResultPrompt,
};
