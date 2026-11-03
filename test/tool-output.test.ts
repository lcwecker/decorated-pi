/**
 * Tests for the shared tool-result renderer — folding, the truncation line, and
 * the source of the expand key hint.
 *
 * Pi 1.5 injects `keyHint()` into the render context. The static import stays as
 * the fallback for older hosts, where the extension's own copy of
 * pi-coding-agent may format an `app.*` binding as an empty string.
 */

import { describe, it, expect } from "vitest";
import { keyHint } from "@earendil-works/pi-coding-agent";

import {
  formatToolResultText,
  renderKeyHint,
  renderToolTextResult,
  TOOL_RESULT_FOLD_LINES,
} from "../utils/tool-output.js";

/** Identity theme: the assertions read the raw text. */
const theme = { fg: (_color: string, text: string) => text };

function textResult(text: string) {
  return { content: [{ type: "text", text }] };
}

const HOST_HINT = (keybinding: string, description: string) => `<${keybinding}> ${description}`;

describe("renderKeyHint", () => {
  it("uses the hint formatter the render context carries", () => {
    expect(renderKeyHint({ keyHint: HOST_HINT })("app.tools.expand", "to expand")).toBe(
      "<app.tools.expand> to expand",
    );
  });

  it("keeps the host's formatting for a context method", () => {
    const context = {
      hostBindings: "ctrl+o",
      keyHint(keybinding: string, description: string) {
        return `${this.hostBindings} ${description}`;
      },
    };
    expect(renderKeyHint(context)("app.tools.expand", "to expand")).toBe("ctrl+o to expand");
  });

  it("falls back to the imported keyHint when the host injects none", () => {
    expect(renderKeyHint({})).toBe(keyHint);
    expect(renderKeyHint(undefined)).toBe(keyHint);
    expect(renderKeyHint({ keyHint: "not a function" })).toBe(keyHint);
  });
});

describe("formatToolResultText", () => {
  it("adds the expand hint through the formatter it is given", () => {
    const text = Array.from({ length: TOOL_RESULT_FOLD_LINES + 5 }, (_, i) => `line ${i}`).join("\n");
    const rendered = formatToolResultText(text, false, theme, HOST_HINT);
    expect(rendered).toContain(`(${5} more lines, ${TOOL_RESULT_FOLD_LINES + 5} total,`);
    expect(rendered).toContain("<app.tools.expand> to expand");
    expect(rendered).not.toContain("line 35");
  });

  it("shows every line and no hint when expanded", () => {
    const text = Array.from({ length: TOOL_RESULT_FOLD_LINES + 5 }, (_, i) => `line ${i}`).join("\n");
    const rendered = formatToolResultText(text, true, theme, HOST_HINT);
    expect(rendered).toContain("line 34");
    expect(rendered).not.toContain("more lines");
  });

  it("pulls a surviving truncation line out of the folded body", () => {
    const text = [...Array.from({ length: 3 }, (_, i) => `line ${i}`), "[Truncated: 5 more lines]"].join(
      "\n",
    );
    const rendered = formatToolResultText(text, false, theme, HOST_HINT);
    expect(rendered).toContain("[Truncated: 5 more lines]");
    expect(rendered).not.toContain("more lines, ");
  });
});

describe("renderToolTextResult", () => {
  it("renders through the context's hint formatter", () => {
    const text = Array.from({ length: TOOL_RESULT_FOLD_LINES + 2 }, (_, i) => `line ${i}`).join("\n");
    let painted = "";
    const context = {
      keyHint: HOST_HINT,
      lastComponent: { setText: (value: string) => { painted = value; } },
    };

    const component = renderToolTextResult(textResult(text), { expanded: false }, theme, context);

    expect(component).toBe(context.lastComponent);
    expect(painted).toContain("<app.tools.expand> to expand");
  });

  it("honours a custom fold depth", () => {
    let painted = "";
    const context = {
      keyHint: HOST_HINT,
      lastComponent: { setText: (value: string) => { painted = value; } },
    };

    renderToolTextResult(textResult("a\nb\nc\nd"), { expanded: false }, theme, context, 2);

    expect(painted).toContain("(2 more lines, 4 total,");
  });
});
