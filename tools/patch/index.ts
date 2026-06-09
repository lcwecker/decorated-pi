/**
 * patch — exact string replacement tool.
 *
 * Replaces pi's native edit/write. Stale-read protection and mtime tracking
 * are in hooks/track-mtime.ts (this tool does not register hooks itself).
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderDiff } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  applyPatch,
  generatePatchDiff,
  type PatchPreview,
} from "./core.js";

const EditSchema = Type.Object({
  anchor: Type.Optional(Type.String({
    description: "Optional unique string that appears BEFORE old_str in the file. Narrows the search range.",
  })),
  old_str: Type.String({
    description: "Exact text to find. Must be unique within the search range. String, not regex.",
  }),
  new_str: Type.String({
    description: "Replacement text. String. Use empty string to delete.",
  }),
});

const PatchSchema = Type.Object({
  path: Type.String({
    description: "Path to the file to edit (relative or absolute).",
  }),
  edits: Type.Array(EditSchema, {
    description: "Targeted replacements applied sequentially. Each edit does exact string replacement with optional anchor.",
  }),
});

function fixJsonNewlines(str: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === '\\') { result += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; result += ch; continue; }
    if (inString && (ch === '\n' || ch === '\r')) {
      result += ch === '\n' ? '\\n' : '\\r';
      continue;
    }
    result += ch;
  }
  return result;
}

function jsonParseWithNewlineFix(str: string): any {
  try { return JSON.parse(str); }
  catch { try { return JSON.parse(fixJsonNewlines(str)); } catch { return undefined; } }
}

export function preparePatchArguments(input: any): any {
  if (!input || typeof input !== "object") return input;
  const args = input as Record<string, any>;
  if (typeof args.edits === "string") {
    try {
      const parsed = jsonParseWithNewlineFix(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch { /* keep original */ }
  }
  if (typeof args.old_str === "string" && typeof args.new_str === "string") {
    const edit: any = { old_str: args.old_str, new_str: args.new_str };
    if (typeof args.anchor === "string") edit.anchor = args.anchor;
    args.edits = args.edits ? [...args.edits, edit] : [edit];
    delete args.old_str;
    delete args.new_str;
    delete args.anchor;
  }
  return args;
}

interface PatchCallComponent extends Box {
  preview?: PatchPreview;
  previewArgsKey?: string;
  previewPending?: boolean;
  settledError: boolean;
}

export function createPatchCallComponent(): PatchCallComponent {
  return Object.assign(new Box(1, 1, (text: string) => text), {
    preview: undefined,
    previewArgsKey: undefined,
    previewPending: false,
    settledError: false,
  });
}

function getPatchCallComponent(state: any, lastComponent: any): PatchCallComponent {
  if (lastComponent instanceof Box) {
    const comp = lastComponent as PatchCallComponent;
    state.callComponent = comp;
    return comp;
  }
  if (state.callComponent) return state.callComponent;
  const comp = createPatchCallComponent();
  state.callComponent = comp;
  return comp;
}

function replaceTabs(text: string): string {
  return text.replace(/\t/g, "    ");
}

function getPatchHeaderBg(component: PatchCallComponent, theme: any) {
  if (component.settledError) return (text: string) => theme.bg("toolErrorBg", text);
  if (component.preview) {
    if ("error" in component.preview && component.preview.error) return (text: string) => theme.bg("toolErrorBg", text);
    return (text: string) => theme.bg("toolSuccessBg", text);
  }
  return (text: string) => theme.bg("toolPendingBg", text);
}

function createSingleLineComponent(text: string) {
  return {
    render(width: number) { return [truncateToWidth(text, width)]; },
    invalidate() {},
  };
}

function formatPatchMetaLine(line: string, theme: any): string {
  const missingSuffix = " (missing)";
  if (line.endsWith(missingSuffix)) {
    return theme.fg("accent", line.slice(0, -missingSuffix.length)) + theme.fg("warning", missingSuffix);
  }
  return theme.fg("accent", line);
}

function appendPatchDiffChildren(parent: Box, body: string, theme: any): void {
  const rawLines = body.split("\n");
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    parent.addChild(new Text(renderDiff(replaceTabs(buffer.join("\n"))), 0, 0));
    buffer = [];
  };
  for (const line of rawLines) {
    if (line.startsWith("@@ lines ")) { flush(); parent.addChild(createSingleLineComponent(formatPatchMetaLine(line, theme)) as any); continue; }
    if (line === "anchors:") { flush(); parent.addChild(createSingleLineComponent(formatPatchMetaLine(line, theme)) as any); continue; }
    if (line.startsWith("  - ")) { flush(); parent.addChild(createSingleLineComponent(formatPatchMetaLine(line, theme)) as any); continue; }
    buffer.push(line);
  }
  flush();
}

function buildPatchCallComponent(component: PatchCallComponent, args: any, theme: any, expanded = false) {
  component.setBgFn(getPatchHeaderBg(component, theme));
  component.clear();
  let label = "";
  if (args?.path) {
    label = theme.fg("accent", args.path);
    if (Array.isArray(args.edits) && args.edits.length > 0) {
      label += theme.fg("dim", ` (${args.edits.length} edit${args.edits.length > 1 ? "s" : ""})`);
    }
  }
  const headerText = theme.fg("toolTitle", theme.bold("patch")) + (label ? " " + label : "");
  component.addChild(new Text(headerText, 0, 0));
  if (component.settledError || !component.preview) return component;
  const preview = component.preview;
  let body = "";
  if ("diff" in preview && preview.diff) body = preview.diff;
  else if ("error" in preview && preview.error) {
    component.addChild(new Spacer(1));
    component.addChild(new Text(theme.fg("error", `  Error: ${preview.error}`), 0, 0));
    return component;
  }
  if (!body) {
    component.addChild(new Spacer(1));
    component.addChild(new Text(theme.fg("dim", `  (no changes)`), 0, 0));
    return component;
  }
  const lines = body.split("\n");
  const FOLD_THRESHOLD = 45;
  component.addChild(new Spacer(1));
  if (lines.length > FOLD_THRESHOLD && !expanded) {
    const shown = lines.slice(0, 10).join("\n");
    appendPatchDiffChildren(component, shown, theme);
    component.addChild(new Text(
      theme.fg("dim", `  ... ${lines.length - 10} more lines (`) + "(expand)" + theme.fg("dim", ")"),
      0, 0,
    ));
  } else {
    appendPatchDiffChildren(component, body, theme);
  }
  return component;
}

export function registerPatchTool(pi: ExtensionAPI): void {
  pi.registerTool(defineTool({
    name: "patch",
    label: "Patch",
    description: [
      "Edits a file using exact string replacement, with anchor support.",
      "When old_str is not unique, add more surrounding context or use anchor to narrow search.",
      "",
      "Examples:",
      '  { path: "src/foo.ts", edits: [{ old_str: "return 1", new_str: "return 42" }] }',
      '  { path: "src/foo.ts", edits: [{ anchor: "function bar() {", old_str: "return x", new_str: "return x + 1" }] }',
      '  { path: "src/foo.ts", edits: [{ anchor: "function init() {", old_str: "const DEBUG = true;", new_str: "const DEBUG = false;" }, { old_str: "log(\\"debug\\");", new_str: "// debug disabled" }] }',
      "",
      "Anchor (optional): narrows old_str search to lines after a unique marker.",
      "  Code: use the enclosing definition — function/class/struct/method signature.",
      '  e.g. "function handleClick() {" or "class UserService {" or "struct Config {".',
      "  Non-code (markdown, config, etc.): use section headings, key names, or distinctive lines.",
      '  e.g. "## API Reference" in .md or "[dependencies]" in .toml files.',
    ].join("\n"),
    promptSnippet: "Edits a file using exact string replacement, with anchor support.",
    promptGuidelines: [
      "Always prefer modifying files with patch tool over bash commands or python scripts.",
      "To prevent hallucinations: 1. Keep each edit batch ≤ 5 changes; 2. Process remaining revisions in sequential steps",
      "On repeated failures: read the file first to confirm information accuracy.",
    ],
    parameters: PatchSchema,
    renderShell: "self",
    prepareArguments: preparePatchArguments,
    execute: async (_toolCallId: string, input: { path: string; edits: any[] }, _signal: any, _onUpdate: any, ctx: any) => {
      const cwd: string = ctx.cwd ?? process.cwd();
      // Stale-read check is in hooks/track-mtime.ts (tool_call phase).
      // Just apply the patch here.
      const result = await applyPatch(input as any, cwd);
      const diff = generatePatchDiff(result);
      // Return "Success" on the LLM-facing channel — the model already knows
      // what it asked to change (it sent the edits). The full diff stays in
      // `details` for the TUI renderer. This keeps the prompt-cache segment
      // stable: success always costs 1 token regardless of N hunks edited.
      return { content: [{ type: "text", text: "Success" }], details: { diff } };
    },
    renderCall(args: any, theme: any, context: any) {
      const state = context.state;
      const component = getPatchCallComponent(state, context.lastComponent);
      const argsKey = args ? JSON.stringify(args) : undefined;
      if (component.previewArgsKey !== argsKey) {
        component.preview = undefined;
        component.previewArgsKey = argsKey;
        component.previewPending = false;
        component.settledError = false;
      }
      return buildPatchCallComponent(component, args, theme, context.expanded);
    },
    renderResult(result: any, options: any, theme: any, context: any) {
      const callComponent: PatchCallComponent | undefined = context.state.callComponent;
      let changed = false;
      if (callComponent) {
        const resultDiff = !context.isError && result.details?.diff;
        if (typeof resultDiff === "string") {
          const newPreview = { diff: resultDiff };
          if (callComponent.preview?.diff !== resultDiff) {
            callComponent.preview = newPreview;
            changed = true;
          }
        }
        if (callComponent.settledError !== context.isError) {
          callComponent.settledError = context.isError;
          changed = true;
        }
        if (changed) {
          buildPatchCallComponent(callComponent, context.args, theme, options.expanded);
          if (context.isError) {
            const errorText = result.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text || "")
              .join("\n");
            if (errorText) {
              callComponent.addChild(new Spacer(1));
              callComponent.addChild(new Text(theme.fg("error", errorText), 0, 0));
            }
          }
        }
      }
      const component = context.lastComponent ?? new Container();
      component.clear();
      return component;
    },
  }));
}
