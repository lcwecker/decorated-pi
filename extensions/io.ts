/**
 * IO — Replace Pi native edit/write with `patch` tool (single-file)
 *
 * Keeps:   read (for stale-read protection via mtime tracking)
 * Removes: edit, write
 * Adds:    patch (old_str/new_str exact replacement, single file per call)
 *
 * Schema: { path, edits?, overwrite?, new_str? }
 * Pi’s native parallel tool calls handle multi-file scenarios.
 *
 * Stale-read protection:
 *   - `read` tool records file mtime when LLM reads a file
 *   - `patch` tool checks: if file mtime > last-read mtime → reject
 *   - `patch` tool updates mtime after successful write
 *
 * TUI Rendering Pitfalls (learned the hard way):
 *   1. execute() MUST throw errors, NOT return { isError: true }
 *   2. TUI rendering MUST mirror the edit tool pattern exactly
 *   3. getPatchHeaderBg: settledError MUST be checked first
 *   4. renderResult must NOT return the Box
 *      renderCall returns the Box (callComponent). If renderResult
 *      also returns it, pi's ToolExecutionComponent adds it twice
 *      to the container, causing duplicate boxes. renderResult
 *      must return context.lastComponent (a separate Container).
 *   5. Error text must go INSIDE the Box, not in the result Container
 *   6. prepareArguments must handle literal newlines in JSON strings
 */

import { defineTool, isEditToolResult, isReadToolResult, isWriteToolResult, keyHint, type ExtensionAPI, type ToolResultEvent, type ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { renderDiff } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { writeOutputToTemp } from "./io-tool-output.js";
import { Type } from "typebox";
import {
  applyPatch,
  formatPatchResult,
  generatePatchDiff,
  type PatchPreview,
} from "./patch.js";
import {
  recordReadTime,
  checkStaleFile,
  clearReadMarkers,
  resolveAbsolutePath,
  FILE_TIMES_CUSTOM_TYPE,
  createFileTimeMarkerData,
  restoreReadMarkersFromBranch,
} from "./file-times.js";

// ─── Schema ─────────────────────────────────────────────────────────────────────────

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

// ─── Argument repair ───────────────────────────────────────────────────────────────

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

  // Edits serialized as JSON string
  if (typeof args.edits === "string") {
    try {
      const parsed = jsonParseWithNewlineFix(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch { /* keep original */ }
  }

  // Legacy: top-level old_str/new_str instead of edits array
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

// ─── TUI rendering ─────────────────────────────────────────────────────────────────

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
  if (component.settledError) {
    return (text: string) => theme.bg("toolErrorBg", text);
  }
  if (component.preview) {
    if ("error" in component.preview && component.preview.error) {
      return (text: string) => theme.bg("toolErrorBg", text);
    }
    return (text: string) => theme.bg("toolSuccessBg", text);
  }
  return (text: string) => theme.bg("toolPendingBg", text);
}

function createSingleLineComponent(text: string) {
  return {
    render(width: number) {
      return [truncateToWidth(text, width)];
    },
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
    if (line.startsWith("@@ lines ")) {
      flush();
      parent.addChild(createSingleLineComponent(formatPatchMetaLine(line, theme)) as any);
      continue;
    }
    if (line === "anchors:") {
      flush();
      parent.addChild(createSingleLineComponent(formatPatchMetaLine(line, theme)) as any);
      continue;
    }
    if (line.startsWith("  - ")) {
      flush();
      parent.addChild(createSingleLineComponent(formatPatchMetaLine(line, theme)) as any);
      continue;
    }
    buffer.push(line);
  }

  flush();
}

export function buildPatchCallComponent(component: PatchCallComponent, args: any, theme: any, expanded = false) {
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
  if ("diff" in preview && preview.diff) {
    body = preview.diff;
  } else if ("error" in preview && preview.error) {
    component.addChild(new Spacer(1));
    component.addChild(new Text(theme.fg("error", `  Error: ${preview.error}`), 0, 0));
    return component;
  }

  if (!body) return component;

  const lines = body.split("\n");
  const FOLD_THRESHOLD = 45;

  component.addChild(new Spacer(1));

  if (lines.length > FOLD_THRESHOLD && !expanded) {
    // 折叠态: 显示前几行 + 摘要
    const shown = lines.slice(0, 10).join("\n");
    appendPatchDiffChildren(component, shown, theme);
    component.addChild(new Text(
      theme.fg("dim", `  ... ${lines.length - 10} more lines (`) + keyHint("app.tools.expand", "expand") + theme.fg("dim", ")"),
      0, 0,
    ));
  } else {
    // 展开态: 完整显示
    appendPatchDiffChildren(component, body, theme);
  }

  return component;
}

// ─── Setup ──────────────────────────────────────────────────────────────────────────

export const OUTPUT_EXTERNALIZE_THRESHOLD = 30_000; // 30KB — match Claude Code's bash truncation threshold

/** If the tool result content is a single text string longer than the
 *  threshold, replace it with a one-line placeholder pointing at the
 *  full output on disk. Returns the modified result, or undefined to
 *  leave the original content untouched. */
export function maybeExternalizeToolResult(event: ToolResultEvent): ToolResultEventResult | undefined {
  const content = event.content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = content[0];
  if (first?.type !== "text" || typeof first.text !== "string") return undefined;
  const text = first.text;
  if (text.length <= OUTPUT_EXTERNALIZE_THRESHOLD) return undefined;

  const filePath = writeOutputToTemp(event.toolName, event.toolCallId, text);
  if (!filePath) return undefined; // write failed — keep original content

  return {
    content: [{
      type: "text" as const,
      text: `[Output truncated: ${text.length.toLocaleString()} chars. Full output: ${filePath}]`,
    }],
  };
}

export function setupIO(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    restoreReadMarkersFromBranch(ctx.sessionManager.getBranch() as any[], ctx.cwd);
    const active = pi.getActiveTools();
    // Remove: edit (replaced by patch), grep/find/ls (replaced by bash)
    // Keep: write (full-file write)
    pi.setActiveTools(active.filter(t => !["edit", "grep", "find", "ls"].includes(t)));
  });

  pi.on("session_compact", () => {
    clearReadMarkers();
  });

  // Externalize large tool results (read / bash) to a temp file.
  // Keeps the messages segment small so prompt cache stays warm across turns.
  pi.on("tool_result", (event) => {
    if (event.toolName !== "read" && event.toolName !== "bash") return;
    return maybeExternalizeToolResult(event);
  });

  // Track file read times
  pi.on("tool_result", (event, ctx) => {
    if (!isReadToolResult(event)) return;
    const filePath = event.input?.path;
    if (typeof filePath !== "string" || !filePath.trim()) return;
    const cwd: string = ctx.cwd ?? process.cwd();
    const absPath = resolveAbsolutePath(cwd, filePath);
    recordReadTime(absPath);
    const marker = createFileTimeMarkerData(cwd, absPath);
    if (marker) pi.appendEntry(FILE_TIMES_CUSTOM_TYPE, marker);
  });

  // Track file write times (for write and edit, in case patch module is disabled)
  pi.on("tool_result", (event, ctx) => {
    if (!isWriteToolResult(event) && !isEditToolResult(event)) return;
    const filePath = event.input?.path;
    if (typeof filePath !== "string" || !filePath.trim()) return;
    const cwd: string = ctx.cwd ?? process.cwd();
    const absPath = resolveAbsolutePath(cwd, filePath);
    // Only record if the write succeeded (not an error result)
    if (event.isError) return;
    recordReadTime(absPath);
    const marker = createFileTimeMarkerData(cwd, absPath);
    if (marker) pi.appendEntry(FILE_TIMES_CUSTOM_TYPE, marker);
  });

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
      '  { path: "src/foo.ts", edits: [{ anchor: "function init() {", old_str: "const DEBUG = true;", new_str: "const DEBUG = false;" }, { old_str: "log(\"debug\");", new_str: "// debug disabled" }] }',
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

      // Stale-read protection
      if (input.path?.trim()) {
        const absPath = resolveAbsolutePath(cwd, input.path);
        const staleError = checkStaleFile(absPath, input.path);
        if (staleError) throw new Error(staleError);
      }

      const result = await applyPatch(input as any, cwd);

      // Update read markers after successful write
      for (const filePath of [...result.modified, ...result.created]) {
        const absPath = resolveAbsolutePath(cwd, filePath);
        recordReadTime(absPath);
        const marker = createFileTimeMarkerData(cwd, absPath);
        if (marker) pi.appendEntry(FILE_TIMES_CUSTOM_TYPE, marker);
      }

      const summary = formatPatchResult(result);
      const diff = generatePatchDiff(result);
      return {
        content: [{ type: "text", text: summary }],
        details: { diff },
      };
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

      // Preview diff is computed during execute and delivered via result.details.diff.
      // Skipping async preview here avoids a redundant file read — same design as
      // Pi's native edit tool where renderResult overwrites the preview with execute's diff.

      return buildPatchCallComponent(component, args, theme, context.expanded);
    },

    renderResult(result: any, options: any, theme: any, context: any) {
      const callComponent: PatchCallComponent | undefined = context.state.callComponent;
      let changed = false;

      if (callComponent) {
        // Use execute's returned diff (same design as Pi's native edit tool)
        const resultDiff = !context.isError && result.details?.diff;
        if (typeof resultDiff === "string") {
          const newPreview = { diff: resultDiff };
          if (callComponent.preview?.diff !== resultDiff) {
            callComponent.preview = newPreview;
            changed = true;
          }
        }

        // Update error state
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

      // Return empty Container — the Box (callComponent) already holds all content.
      // Per pitfall #4: returning the Box would cause ToolExecutionComponent to add
      // it twice to the container, producing duplicate rendering.
      const component = context.lastComponent ?? new Container();
      component.clear();
      return component;
    },
  }));
}
