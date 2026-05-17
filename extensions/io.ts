/**
 * IO — Replace Pi native edit/write with `patch` tool
 *
 * Keeps:   read (for stale-read protection via mtime tracking)
 * Removes: edit, write
 * Adds:    patch (old_str/new_str exact replacement)
 *
 * Stale-read protection:
 *   - `read` tool records file mtime when LLM reads a file
 *   - `patch` tool checks: if file mtime > last-read mtime → reject
 *   - `patch` tool updates mtime after successful write
 *
 * ========================================================================
 * TUI Rendering Pitfalls (learned the hard way)
 * ========================================================================
 *
 * 1. execute() MUST throw errors, NOT return { isError: true }
 *    Pi's Agent framework only sets event.isError = true when the
 *    tool execute() throws/rejects. A resolved return value with
 *    { isError: true } has its isError field silently dropped.
 *    This means context.isError in renderResult is always false.
 *    → Always throw new Error(...) for failures in execute().
 *
 * 2. TUI rendering MUST mirror the edit tool pattern exactly
 *    The edit tool uses an extended Box (callComponent) with a
 *    `settledError` property. When renderResult runs, it sets
 *    settledError = context.isError and rebuilds the Box via
 *    buildEditCallComponent(). This is the only way the red
 *    error background is applied.
 *
 * 3. getPatchHeaderBg: settledError MUST be checked first
 *    If previews exist, a naive implementation returns green
 *    immediately. But settledError should take priority — the
 *    execution error trumps any preview state.
 *
 * 4. renderResult must NOT return the Box
 *    renderCall returns the Box (callComponent). If renderResult
 *    also returns it, pi's ToolExecutionComponent adds it twice
 *    to the container, causing duplicate boxes. renderResult
 *    must return context.lastComponent (a separate Container).
 *
 * 5. Error text must go INSIDE the Box, not in the result Container
 *    Returning a Container with error text renders it below the
 *    box as plain text. The error must be addChild'd directly
 *    to callComponent (the Box) so it appears within the red
 *    background frame.
 *
 * 6. prepareArguments must handle literal newlines in JSON strings
 *    When models send patches as a JSON-encoded string, nested string
 *    values (like new_str) may contain literal \n characters instead
 *    of escaped \n. JSON.parse fails on these. fixJsonNewlines() uses
 *    a simple state machine to escape literal newlines only inside
 *    string values before parsing.
 */

import { defineTool, isReadToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderDiff } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  applyPatches,
  ApplyError,
  ParseError,
  formatPatchResult,
  generatePatchDiff,
  computePatchPreview,
  type PatchPreview,
} from "./patch.js";
import { recordReadTime, checkStaleFile, clearReadMarkers, resolveAbsolutePath } from "./file-times.js";

// ─── Schemas ────────────────────────────────────────────────────────────────

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

const FilePatchSchema = Type.Object({
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

// ─── Argument repair (some models serialize nested JSON as strings) ───────────

// Escape literal newlines/carriage-returns ONLY inside JSON string values.
// Models sometimes send patches as a JSON string where nested string values
// contain unescaped newlines, causing JSON.parse to fail.
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

// Try JSON.parse with a fallback that fixes literal newlines inside strings.
function jsonParseWithNewlineFix(str: string): any {
  try { return JSON.parse(str); }
  catch { try { return JSON.parse(fixJsonNewlines(str)); } catch { return undefined; } }
}

export function preparePatchArguments(input: any): { patches: any[] } {
  if (!input || typeof input !== "object") return input;

  const args = input as Record<string, any>;

  // Some models send patches as a JSON string instead of an array
  if (typeof args.patches === "string") {
    try {
      const parsed = jsonParseWithNewlineFix(args.patches);
      if (Array.isArray(parsed)) {
        args.patches = parsed;
      } else if (parsed && typeof parsed === "object") {
        // Single patch object serialized as string ("{path:...}" instead of "[{}]")
        args.patches = [parsed];
      }
    } catch { /* keep original */ }
  }

  // Some models send each patch inside the array as a JSON string
  if (Array.isArray(args.patches)) {
    const repairedPatches: any[] = [];
    for (const patch of args.patches) {
      if (typeof patch === "string") {
        try {
          const parsed = jsonParseWithNewlineFix(patch);
          if (parsed && typeof parsed === "object") {
            repairedPatches.push(parsed);
            continue;
          }
        } catch { /* fall through */ }
      }
      if (patch && typeof patch === "object") {
        repairedPatches.push(patch);
      }
      // Primitives (null / numbers) are silently dropped
    }
    args.patches = repairedPatches;

    for (const patch of args.patches) {
      if (!patch || typeof patch !== "object") continue;

      // Some models send edits as a JSON string inside a patch
      if (typeof patch.edits === "string") {
        try {
          const parsed = jsonParseWithNewlineFix(patch.edits);
          if (Array.isArray(parsed)) patch.edits = parsed;
        } catch { /* keep original */ }
      }

      // Legacy format: patch top-level has old_str/new_str instead of edits array
      if (typeof patch.old_str === "string" && typeof patch.new_str === "string") {
        const edit: any = { old_str: patch.old_str, new_str: patch.new_str };
        if (typeof patch.anchor === "string") edit.anchor = patch.anchor;
        patch.edits = patch.edits ? [...patch.edits, edit] : [edit];
        delete patch.old_str;
        delete patch.new_str;
        delete patch.anchor;
      }
    }
  }

  return args as { patches: any[] };
}

// ─── Patch TUI rendering (mirrors edit tool pattern exactly) ──────────────────

interface PatchCallComponent extends Box {
  previews?: Map<string, PatchPreview>;
  previewArgsKey?: string;
  previewPending?: boolean;
  settledError: boolean;
}

function createPatchCallComponent(): PatchCallComponent {
  return Object.assign(new Box(1, 1, (text: string) => text), {
    previews: undefined,
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
  if (state.callComponent) {
    return state.callComponent;
  }
  const comp = createPatchCallComponent();
  state.callComponent = comp;
  return comp;
}

function getPatchHeaderBg(component: PatchCallComponent, theme: any) {
  if (component.settledError) {
    return (text: string) => theme.bg("toolErrorBg", text);
  }
  if (component.previews) {
    const hasError = [...component.previews.values()].some((p) => p && "error" in p);
    if (hasError) return (text: string) => theme.bg("toolErrorBg", text);
    return (text: string) => theme.bg("toolSuccessBg", text);
  }
  return (text: string) => theme.bg("toolPendingBg", text);
}

function buildPatchCallComponent(component: PatchCallComponent, args: any, theme: any) {
  component.setBgFn(getPatchHeaderBg(component, theme));
  component.clear();

  const patches = Array.isArray(args?.patches) ? args.patches : [];
  const headerParts: string[] = [];
  for (const p of patches) {
    if (!p?.path) continue;
    let label = theme.fg("accent", p.path);
    if (p.overwrite) {
      label += theme.fg("warning", " [overwrite]");
    } else if (p.edits?.length > 0) {
      const anchored = p.edits.filter((e: any) => e.anchor);
      if (anchored.length > 0) {
        const anchorTexts = anchored.map((e: any) => `anchor: "${e.anchor}"`);
        label += theme.fg("toolOutput", " " + anchorTexts.join(" "));
      }
    }
    headerParts.push(label);
  }
  const headerText = theme.fg("toolTitle", theme.bold("patch")) +
    (headerParts.length > 0 ? " " + headerParts.join(" ") : "");

  component.addChild(new Text(headerText, 0, 0));

  // Don't render preview body when settled as error
  if (component.settledError || !component.previews) {
    return component;
  }

  component.addChild(new Spacer(1));
  for (const [fp, preview] of component.previews) {
    if (fp === "_parse") continue;

    const patchInfo = patches.find((p: any) => p.path === fp);
    let fileLabel = theme.fg("accent", theme.bold(fp));
    if (patchInfo?.overwrite) {
      fileLabel += theme.fg("warning", " [overwrite]");
    }
    component.addChild(new Text(fileLabel, 0, 0));

    if (preview && "isOverwrite" in preview && preview.isOverwrite && preview.preview) {
      component.addChild(new Text(theme.fg("toolDiffAdded", preview.preview), 0, 0));
    } else if (preview && "diff" in preview && preview.diff) {
      component.addChild(new Text(renderDiff(preview.diff), 0, 0));
    } else if (preview && "error" in preview && preview.error) {
      component.addChild(new Text(theme.fg("error", `  Error: ${preview.error}`), 0, 0));
    }
    component.addChild(new Spacer(1));
  }

  return component;
}

function formatPatchResultForDisplay(_args: any, _previews: any, result: any, theme: any, isError: boolean) {
  if (isError) {
    const errorText = result.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text || "")
      .join("\n");
    if (!errorText) return undefined;
    return theme.fg("error", errorText);
  }
  const resultDiff = result.details?.diff;
  if (resultDiff) {
    return renderDiff(resultDiff);
  }
  return undefined;
}

// ─── Setup ──────────────────────────────────────────────────────────────────────────

export function setupIO(pi: ExtensionAPI) {
  pi.on("session_start", () => {
    clearReadMarkers();
    const active = pi.getActiveTools();
    pi.setActiveTools(active.filter(t => !["edit", "write"].includes(t)));
  });

  // Track file read times — when read tool completes, record file mtime
  pi.on("tool_result", (event, ctx) => {
    if (!isReadToolResult(event)) return;
    const filePath = event.input?.path;
    if (typeof filePath !== "string" || !filePath.trim()) return;
    const cwd: string = ctx.cwd ?? process.cwd();
    const absPath = resolveAbsolutePath(cwd, filePath);
    recordReadTime(absPath);
  });

  pi.registerTool(defineTool({
    name: "patch",
    label: "Patch",
    description: [
      "Edits one or more files using exact string replacement, support search based on anchor.",
      "When old_str is not unique, add more surrounding context or use anchor to narrow search.",
      "If possible, prefer anchor for more robust edits. Anchor must be a unique string that appears BEFORE old_str in the file.",
      "",
      "Examples (parameters only, not wrapped in patch()):",
      '  { patches: [{ path: "src/foo.ts", edits: [{ anchor: "function bar() {", old_str: "return x", new_str: "return y" }] }] },',
      '  { patches: [{ path: "src/foo.ts", edits: [{ old_str: "return 1", new_str: "return 42" }] }] },',
      '  { patches: [{ path: "src/bar.ts", overwrite: true, new_str: "entire file content" }] }',
      "Anchor examples(you should provide enough context to make it unique):",
      '  prefer "fuction foo()" over "foo".',
      '  prefer "class Foo" over "Foo".',
      '  prefer "## Section Title" in md file edits.',
      '  by parity of reasoning'
    ].join("\n"),
    promptSnippet: "Edits one or more files using exact string replacement, support search based on anchor, support overwrite.",
    promptGuidelines: [
      "Always prefer modifying files with PATCH tool over bash commands or python scripts.",
      "For full-file replacement, always use patch tool to prevent unintended edits or data loss.",
    ],
    parameters: Type.Object({
      patches: Type.Array(FilePatchSchema, {
        description: "Array of file patch operations. Each element is an object with path, edits (or overwrite+new_str).",
      }),
    }),
    renderShell: "self",
    prepareArguments: preparePatchArguments,
    execute: async (_toolCallId: string, input: { patches: any[] }, _signal: any, _onUpdate: any, ctx: any) => {
      const cwd: string = ctx.cwd ?? process.cwd();

      // Stale-read protection: check each file's mtime before editing
      for (const p of input.patches) {
        if (!p.path?.trim()) continue; // let applyPatches handle the error
        const absPath = resolveAbsolutePath(cwd, p.path);
        const staleError = checkStaleFile(absPath, p.path);
        if (staleError) {
          throw new Error(staleError);
        }
      }

      try {
        const result = await applyPatches(input.patches, cwd);

        // After successful patch, update read markers for all modified/created files
        for (const filePath of [...result.modified, ...result.created]) {
          const absPath = resolveAbsolutePath(cwd, filePath);
          recordReadTime(absPath);
        }

        const summary = formatPatchResult(result);
        const diff = generatePatchDiff(result);
        return {
          content: [{ type: "text", text: summary }],
          details: { diff },
        };
      } catch (err) {
        throw err;
      }
    },

    renderCall(args: any, theme: any, context: any) {
      const state = context.state;
      const component = getPatchCallComponent(state, context.lastComponent);

      // When args change, reset preview state
      const argsKey = args?.patches ? JSON.stringify(args.patches) : undefined;
      if (component.previewArgsKey !== argsKey) {
        component.previews = undefined;
        component.previewArgsKey = argsKey;
        component.previewPending = false;
        component.settledError = false;
      }

      // Start computing preview once args are complete
      if (context.argsComplete && !component.previews && !component.previewPending) {
        component.previewPending = true;
        const patches = Array.isArray(args?.patches) ? args.patches : [];
        void computePatchPreview(patches, context.cwd).then((previews: any) => {
          component.previews = previews;
          context.invalidate();
        });
      }

      return buildPatchCallComponent(component, args, theme);
    },

    renderResult(result: any, _options: any, theme: any, context: any) {
      const callComponent: PatchCallComponent | undefined = context.state.callComponent;
      let changed = false;

      if (callComponent) {
        if (callComponent.settledError !== context.isError) {
          callComponent.settledError = context.isError;
          changed = true;
        }
        if (changed) {
          buildPatchCallComponent(callComponent, context.args, theme);
          // On error, add error text inside the Box so it appears in the red box
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

      // Return empty Container — error text is already in the Box
      const component = context.lastComponent ?? new Container();
      component.clear();
      return component;
    },
  }));
}
