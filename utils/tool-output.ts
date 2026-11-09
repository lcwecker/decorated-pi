/**
 * Shared rendering for tools whose model-facing result is a block of text.
 *
 * Long tool output floods the transcript, so the default view folds to
 * TOOL_RESULT_FOLD_LINES lines and offers the expand key hint; the expanded
 * view shows everything. Transport-agnostic: the MCP tool passthrough and the
 * native web tools all render through here.
 */

import { keyHint as importedKeyHint } from "@earendil-works/pi-coding-agent";
import { Text, type Keybinding } from "@earendil-works/pi-tui";

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
 * Formats a keybinding hint. Pi 1.5+ injects this into the render context, so it
 * always reads the host's keybindings rather than those of whichever copy of
 * pi-coding-agent the extension resolved.
 */
export type KeyHint = (keybinding: Keybinding, description: string) => string;

/**
 * Render folded text. A `[Truncated: ...]` line that the producer appended and
 * that survives the fold is pulled out of the body and shown in the warning
 * color; when the fold cuts before it, the `... (N more lines)` hint takes its
 * place.
 */
export function formatToolResultText(
  text: string,
  expanded: boolean,
  theme: any,
  keyHint: KeyHint,
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
    rendered += foldFooter(remainingLines, totalLines, theme, keyHint);
  }
  return rendered;
}

/**
 * The folded-view footer: how many lines are hidden and the expand key.
 * Shared by every folding renderer so the wording stays identical.
 */
export function foldFooter(
  remainingLines: number,
  totalLines: number,
  theme: any,
  keyHint: KeyHint,
): string {
  if (remainingLines <= 0) return "";
  return `${theme.fg("muted", `\n... (${remainingLines} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")})`;
}

/**
 * Fold text the caller already styled. `formatToolResultText` paints the whole
 * block in one color, which ends at the first inner reset — renderers that
 * color their own rows fold through this instead.
 */
export function foldToolText(
  styled: string,
  expanded: boolean,
  theme: any,
  keyHint: KeyHint,
  maxLines = TOOL_RESULT_FOLD_LINES,
): string {
  const { totalLines, displayLines, remainingLines } = collapseToolText(
    styled,
    expanded ? Number.MAX_SAFE_INTEGER : maxLines,
  );
  return displayLines.join("\n") + foldFooter(remainingLines, totalLines, theme, keyHint);
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
  component.setText(
    formatToolResultText(
      textResultContent(result),
      options.expanded,
      theme,
      renderKeyHint(context),
      maxLines,
    ),
  );
  return component;
}

/** The host's hint formatter when the render context carries one. */
export function renderKeyHint(context: any): KeyHint {
  if (typeof context?.keyHint === "function") {
    return (keybinding: Keybinding, description: string) => context.keyHint(keybinding, description);
  }
  return importedKeyHint;
}
