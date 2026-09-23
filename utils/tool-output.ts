/**
 * Shared rendering for tools whose model-facing result is a block of text.
 *
 * Long tool output floods the transcript, so the default view folds to
 * TOOL_RESULT_FOLD_LINES lines and offers the expand key hint; the expanded
 * view shows everything. Transport-agnostic: the MCP tool passthrough and the
 * native web tools all render through here.
 */

import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const TOOL_RESULT_FOLD_LINES = 30;

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return lines.slice(0, end);
}

/** Split into display lines, dropping trailing blanks. */
export function collapseToolText(text: string, maxLines = TOOL_RESULT_FOLD_LINES) {
  const lines = trimTrailingEmptyLines(text.split("\n"));
  return {
    totalLines: lines.length,
    displayLines: lines.slice(0, maxLines),
    remainingLines: Math.max(0, lines.length - maxLines),
  };
}

/** Join the text parts of a tool result's content array. */
export function textResultContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((c): c is { type: "text"; text?: string } => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

/**
 * Render folded text. A trailing `[Truncated: ...]` line that the producer
 * added is pulled out of the fold and shown in the warning color, so it stays
 * visible even when the body is collapsed.
 */
export function formatToolResultText(
  text: string,
  expanded: boolean,
  theme: any,
  maxLines = TOOL_RESULT_FOLD_LINES,
): string {
  const { totalLines, displayLines, remainingLines } = collapseToolText(
    text,
    expanded ? Number.MAX_SAFE_INTEGER : maxLines,
  );
  const lastLine = displayLines[displayLines.length - 1] || "";
  let outputLines = [...displayLines];
  let truncationMsg = "";
  if (lastLine.startsWith("[Truncated: ") && lastLine.endsWith("]")) {
    truncationMsg = lastLine;
    outputLines = outputLines.slice(0, -1);
  }
  const outputText = outputLines.join("\n");
  let rendered = outputText ? theme.fg("toolOutput", outputText) : "";
  if (truncationMsg) rendered += (rendered ? "\n" : "") + theme.fg("warning", truncationMsg);
  if (!expanded && remainingLines > 0) {
    rendered += `${theme.fg("muted", `\n... (${remainingLines} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")})`;
  }
  return rendered;
}

/** `renderResult` implementation for text-only tools. */
export function renderToolTextResult(
  result: any,
  options: { expanded: boolean },
  theme: any,
  context: any,
  maxLines = TOOL_RESULT_FOLD_LINES,
): any {
  const component = context.lastComponent ?? new Text("", 0, 0);
  component.setText(formatToolResultText(textResultContent(result), options.expanded, theme, maxLines));
  return component;
}
