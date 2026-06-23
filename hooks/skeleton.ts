/**
 * Skeleton — the only place that calls pi.on(...) for hooks.
 *
 *   sk.register(module)         → installs module's hook handlers
 *   sk.declareDependency({...}) → check now, report on session_start
 *   sk.declareGuideline("...") → skeleton injects on before_agent_start
 *   sk.install(pi)              → call once, after all setup<X> calls
 *
 * Handlers receive (event, ctx, pi) so they can call pi.* APIs
 * (setSessionName, registerTool, appendEntry, etc.).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isDontBother } from "../settings.js";

// ─── Event union ───────────────────────────────────────────────────────────

export type HookEvent =
  | "session_start"
  | "session_shutdown"
  | "session_compact"
  | "session_before_compact"
  | "before_agent_start"
  | "agent_start"
  | "agent_end"
  | "input"
  | "tool_call"
  | "tool_result";

// ─── Handler modes ─────────────────────────────────────────────────────────

/** Parallel: all handlers run, return values ignored. */
export type ParallelHandler<E extends HookEvent> = (
  event: any,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
) => void | Promise<void>;

/** Compose: next handler receives previous return value. */
export type ComposeHandler<E extends HookEvent> = (
  event: any,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
) => any | Promise<any>;

/** Result: each handler sees the original event; the last non-undefined
 *  return value wins. Matches runner.emit()'s behavior for `session_before_*`
 *  events, where the runner collects a single `{ cancel?, compaction? }`
 *  result from all extensions. Use for events whose contract is "the
 *  extension either overrides or steps aside". */
export type ResultHandler<E extends HookEvent> = (
  event: any,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
) => any | Promise<any>;

export interface Module {
  readonly name: string;
  readonly hooks: {
    session_start?: ParallelHandler<"session_start">[];
    session_shutdown?: ParallelHandler<"session_shutdown">[];
    session_compact?: ParallelHandler<"session_compact">[];
    session_before_compact?: ResultHandler<"session_before_compact">[];
    before_agent_start?: ComposeHandler<"before_agent_start">[];
    agent_start?: ParallelHandler<"agent_start">[];
    agent_end?: ParallelHandler<"agent_end">[];
    input?: ParallelHandler<"input">[];
    tool_call?: ComposeHandler<"tool_call">[];
    tool_result?: ComposeHandler<"tool_result">[];
  };
}

// ─── Declarations ──────────────────────────────────────────────────────────

export interface Dependency {
  name: string;
  hint?: string;
  module?: string;
}

/** Collected result shape for a module's declared dependency. Modules
 *  expose a function that returns a list of these so the UI can show
 *  "what's currently broken" for the user. The skeleton's own
 *  `session_start` handler also walks declared dependencies, but it
 *  uses `Dependency.check` directly rather than collecting statuses. */
export interface DependencyStatus {
  module: string;
  /** Binary/config key, not necessarily the resolved absolute path. */
  label: string;
  state: "ok" | "missing";
  detail: string;
  /** Resolved executable path when state is ok. */
  path?: string;
}

// ─── Skeleton ──────────────────────────────────────────────────────────────

const COMPOSE_EVENTS = new Set<HookEvent>([
  "before_agent_start",
  "tool_call",
  "tool_result",
]);

/** Events whose handler return value is propagated to the extension runner
 *  (no chaining — each handler sees the original event, last non-undefined
 *  return wins). Required for `session_before_compact`, whose contract is
 *  `{ cancel?, compaction? }`; without this, hooks can't override pi's
 *  default compaction. */
const RESULT_EVENTS = new Set<HookEvent>([
  "session_before_compact",
]);

export interface Skeleton {
  register(module: Module): void;
  /** Returns whether the dependency check passed right now. */
  /** Declare that a binary dependency is missing. Module calls this
   *   after its own which() lookup failed. Skeleton dedupes by name,
   *   honors `dependencies[name].dontBother`, and shows a single
   *   "run /dp-settings" notification on session_start. */
  declareMissing(dep: Omit<Dependency, "module"> & { module?: string }): void;
  install(pi: ExtensionAPI): void;
  inspect(): Inspection;
}

export interface Inspection {
  modules: string[];
  events: Record<string, Array<{ module: string; order: number }>>;
  dependencies: Array<{ name: string; module?: string; hint?: string }>;
}

export function createSkeleton(): Skeleton {
  const modules: Module[] = [];
  const registry = new Map<HookEvent, Array<{ module: string; handler: (event: any, ctx: ExtensionContext, pi: ExtensionAPI) => any }>>();
  const dependencies: Dependency[] = [];
  let dependencyNotifyTimer: ReturnType<typeof setTimeout> | undefined;

  function collect(mod: Module) {
    for (const [event, handlers] of Object.entries(mod.hooks)) {
      if (!handlers?.length) continue;
      const list = registry.get(event as HookEvent) ?? [];
      for (const handler of handlers) {
        list.push({ module: mod.name, handler: handler as any });
      }
      registry.set(event as HookEvent, list);
    }
  }

  return {
    register(mod) {
      modules.push(mod);
      collect(mod);
    },

    declareMissing(dep) {
      // Dedupe by name — multiple modules may depend on the same binary.
      if (dependencies.some((d) => d.name === dep.name)) return;
      dependencies.push(dep as Dependency);
    },

    install(pi) {
      // Install one pi.on per event, walking registered handlers in order.
      for (const [event, handlers] of registry) {
        if (handlers.length === 0) continue;
        if (COMPOSE_EVENTS.has(event)) {
          pi.on(event as any, async (event: any, ctx: ExtensionContext) => {
            let current = event;
            for (const { handler } of handlers) {
              const result = await handler(current, ctx, pi);
              if (result !== undefined) current = result;
            }
            return current === event ? undefined : current;
          });
        } else if (RESULT_EVENTS.has(event)) {
          pi.on(event as any, async (event: any, ctx: ExtensionContext) => {
            let result;
            for (const { handler } of handlers) {
              const r = await handler(event, ctx, pi);
              if (r !== undefined) result = r;
            }
            return result;
          });
        } else {
          pi.on(event as any, async (event: any, ctx: ExtensionContext) => {
            for (const { handler } of handlers) await handler(event, ctx, pi);
          });
        }
      }

      // Skeleton-owned: dependency check on session_start.
      // Defer with setTimeout(0) so the notification fires AFTER pi's
      // startup/reload UI rebuild (rebuildChatFromMessages); otherwise it
      // is appended to the chat and immediately wiped.
      const runDependencyCheck = (ctx: ExtensionContext) => {
        if (!ctx.hasUI) return;
        if (dependencyNotifyTimer) clearTimeout(dependencyNotifyTimer);
        dependencyNotifyTimer = setTimeout(() => {
          dependencyNotifyTimer = undefined;
          const missing: string[] = [];
          for (const dep of dependencies) {
            // dontBother flag silences the notification per-binary.
            if (isDontBother(dep.name)) continue;
            missing.push(dep.name);
          }
          if (missing.length) {
            try {
              ctx.ui.notify(
                `[decorated-pi] Some dependencies are missing (${missing.length}). Run /dp-settings → Dependencies to configure.`,
                "info",
              );
            } catch {
              // Extension context may be stale if another reload/session switch happened.
            }
          }
        }, 0);
      };
      pi.on("session_start", async (event: any, ctx: ExtensionContext) => {
        // Only check on cold startup and explicit reload — other reasons
        // (new/resume/fork) inherit the existing session's tool/runtime
        // and don't need a fresh check.
        if (event.reason !== "startup" && event.reason !== "reload") return;
        runDependencyCheck(ctx);
      });
      pi.on("session_shutdown", async () => {
        if (!dependencyNotifyTimer) return;
        clearTimeout(dependencyNotifyTimer);
        dependencyNotifyTimer = undefined;
      });

      // Skeleton-owned: system-prompt options sort for cache stability.
      // Guideline injection is owned by `index.ts`.
      pi.on("before_agent_start", async (event: any) => {
        if (event.systemPromptOptions) sortSystemPromptOptions(event.systemPromptOptions);
        return undefined;
      });
    },

    inspect() {
      const events: Inspection["events"] = {};
      for (const [event, handlers] of registry) {
        events[event] = handlers.map((h, i) => ({ module: h.module, order: i }));
      }
      return {
        modules: modules.map((m) => m.name),
        events,
        dependencies: dependencies.map((d) => ({ name: d.name, module: d.module, hint: d.hint })),
      };
    },
  };
}

// ─── System-prompt option sorting ─────────────────────────────────────────

/** Sort all fields in systemPromptOptions alphabetically for stable system prompt. */
export function sortSystemPromptOptions(opts: {
  toolSnippets?: Record<string, string>;
  selectedTools?: string[];
  promptGuidelines?: string[];
  skills?: Array<{ name: string; description: string; filePath: string }>;
}) {
  const sortedToolNames = Object.keys(opts.toolSnippets ?? {}).sort((a, b) => a.localeCompare(b));
  const sortedToolSnippets: Record<string, string> = {};
  for (const name of sortedToolNames) {
    sortedToolSnippets[name] = opts.toolSnippets![name];
  }
  opts.toolSnippets = sortedToolSnippets;
  if (opts.selectedTools) {
    opts.selectedTools = sortedToolNames;
  }
  if (opts.promptGuidelines) {
    opts.promptGuidelines = [...opts.promptGuidelines].sort((a, b) => a.localeCompare(b));
  }
  if (opts.skills) {
    opts.skills = [...opts.skills].sort((a, b) => a.name.localeCompare(b.name));
  }
}
