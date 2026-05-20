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
 *   5. Error text must go INSIDE the Box, not in the result Container
 *   6. prepareArguments must handle literal newlines in JSON strings
 */

import { defineTool, isReadToolResult, keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderDiff } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  applyPatch,
  formatPatchResult,
  generatePatchDiff,
  computePatchPreview,
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
  edits: Type.Optional(Type.Array(EditSchema, {
    description: "Targeted replacements applied sequentially.",
  })),
  overwrite: Type.Optional(Type.Boolean({
    description: "If true, replace the entire file atomically (write temp → mv).",
  })),
  new_str: Type.Optional(Type.String({
    description: "Entire new file content when overwrite is true.",
  })),
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

  // Legacy multi-file format: { patches: [{ path, edits }] } → extract first
  if (Array.isArray(args.patches) && !args.path) {
    const first = args.patches[0];
    if (first && typeof first === "object" && first.path) {
      Object.assign(args, first);
      delete args.patches;
    }
  } else if (typeof args.patches === "string" && !args.path) {
    try {
      const parsed = jsonParseWithNewlineFix(args.patches);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.path) {
        Object.assign(args, parsed[0]);
        delete args.patches;
      } else if (parsed && typeof parsed === "object" && parsed.path) {
        Object.assign(args, parsed);
        delete args.patches;
      }
    } catch { /* keep original */ }
  }

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

function createPatchCallComponent(): PatchCallComponent {
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

function appendPatchDiffChildren(parent: Box, body: string, theme: any): void {
  const rawLines = body.split("\n");
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    parent.addChild(new Text(renderDiff(buffer.join("\n")), 0, 0));
    buffer = [];
  };

  for (const line of rawLines) {
    if (line.startsWith("@@ lines ")) {
      flush();
      parent.addChild(createSingleLineComponent(theme.fg("accent", line)) as any);
      continue;
    }
    if (line === "anchors:") {
      flush();
      parent.addChild(createSingleLineComponent(theme.fg("accent", line)) as any);
      continue;
    }
    if (line.startsWith("  - ")) {
      flush();
      parent.addChild(createSingleLineComponent(theme.fg("accent", line)) as any);
      continue;
    }
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
    if (args.overwrite) {
      label += theme.fg("warning", " [overwrite]");
    } else if (args.edits?.length > 0) {
      label += theme.fg("dim", ` (${args.edits.length} edit${args.edits.length > 1 ? "s" : ""})`);
    }
  }
  const headerText = theme.fg("toolTitle", theme.bold("patch")) + (label ? " " + label : "");
  component.addChild(new Text(headerText, 0, 0));

  if (component.settledError || !component.preview) return component;

  const preview = component.preview;
  let body = "";
  if ("isOverwrite" in preview && preview.isOverwrite && preview.preview) {
    body = preview.preview;
  } else if ("diff" in preview && preview.diff) {
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
    const isOverwrite = "isOverwrite" in preview && preview.isOverwrite;
    if (isOverwrite) {
      component.addChild(new Text(theme.fg("toolDiffAdded", shown), 0, 0));
    } else {
      appendPatchDiffChildren(component, shown, theme);
    }
    component.addChild(new Text(
      theme.fg("dim", `  ... ${lines.length - 10} more lines (`) + keyHint("app.tools.expand", "expand") + theme.fg("dim", ")"),
      0, 0,
    ));
  } else {
    // 展开态: 完整显示
    const isOverwrite = "isOverwrite" in preview && preview.isOverwrite;
    if (isOverwrite) {
      component.addChild(new Text(theme.fg("toolDiffAdded", body), 0, 0));
    } else {
      appendPatchDiffChildren(component, body, theme);
    }
  }

  return component;
}

// ─── Setup ──────────────────────────────────────────────────────────────────────────

export function setupIO(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    restoreReadMarkersFromBranch(ctx.sessionManager.getBranch() as any[], ctx.cwd);
    const active = pi.getActiveTools();
    pi.setActiveTools(active.filter(t => !["edit", "write", "grep", "find", "ls"].includes(t)));
  });

  pi.on("session_compact", () => {
    clearReadMarkers();
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

  pi.registerTool(defineTool({
    name: "patch",
    label: "Patch",
    description: [
      "Edits a file using exact string replacement, with optional anchor to narrow search.",
      "When old_str is not unique, add more surrounding context or use anchor to narrow search.",
      "If possible, prefer anchor for more robust edits. Anchor must be a unique string that appears BEFORE old_str in the file.",
      "",
      "Examples:",
      '  { path: "src/foo.ts", edits: [{ anchor: "function bar() {", old_str: "return x", new_str: "return y" }] }',
      '  { path: "src/foo.ts", edits: [{ old_str: "return 1", new_str: "return 42" }] }',
      '  { path: "src/bar.ts", overwrite: true, new_str: "entire file content" }',
      "Anchor examples (provide enough context to make it unique):",
      '  prefer "function foo()" over "foo".',
      '  prefer "class Foo" over "Foo".',
      '  prefer "## Section Title" in md file edits.',
    ].join("\n"),
    promptSnippet: "Edits a file using exact string replacement, with anchor support and overwrite mode.",
    promptGuidelines: [
      "Always prefer modifying files with PATCH tool over bash commands or python scripts.",
      "For full-file replacement, always use patch tool to prevent unintended edits or data loss.",
    ],
    parameters: PatchSchema,
    renderShell: "self",
    prepareArguments: preparePatchArguments,
    execute: async (_toolCallId: string, input: { path: string; edits?: any[]; overwrite?: boolean; new_str?: string }, _signal: any, _onUpdate: any, ctx: any) => {
      const cwd: string = ctx.cwd ?? process.cwd();

      // Stale-read protection (only for edits, not overwrite)
      if (!input.overwrite && input.path?.trim()) {
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

      if (context.argsComplete && !component.preview && !component.previewPending) {
        component.previewPending = true;
        void computePatchPreview(args, context.cwd).then((preview: any) => {
          component.preview = preview;
          context.invalidate();
        });
      }

      return buildPatchCallComponent(component, args, theme, context.expanded);
    },

    renderResult(result: any, options: any, theme: any, context: any) {
      const callComponent: PatchCallComponent | undefined = context.state.callComponent;
      let changed = false;

      if (callComponent) {
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
