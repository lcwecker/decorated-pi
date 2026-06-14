/**
 * smart-at — high-speed file search autocomplete.
 *
 * Uses @ff-labs/fff-node (FFF) for cross-platform fuzzy file search.
 * FFF maintains an in-memory index, scores files by fuzzy match +
 * frecency + git status, and returns ranked results. We create one
 * FileFinder per session and query it directly for every @ prefix.
 */

import { FileFinder, type MixedItem } from "@ff-labs/fff-node";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Module, Skeleton } from "./skeleton.js";

// Characters that, when preceding an "@", allow us to start a smart-at
// completion.
const AT_BOUNDARY = new Set<string>([" ", "\t", "(", "["]);

const AUTOCOMPLETE_LIMIT = 20;
const FFF_SUPERSET = 100;
const WIDGET_FOOTER = "\x1b[2mpowered by fff\x1b[0m";

interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

function atPrefix(text: string): string | null {
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== "@") continue;
    const b = text[i - 1];
    if (i === 0 || AT_BOUNDARY.has(b)) {
      return text.slice(i);
    }
    return null;
  }
  return null;
}

function isGitIgnored(item: MixedItem): boolean {
  return item.type === "file" && item.item.gitStatus === "ignored";
}

function toAutocompleteItem(item: MixedItem): AutocompleteItem {
  const path = item.item.relativePath;
  const label = item.type === "file"
    ? item.item.fileName
    : path.replace(/\/+$/, "").split("/").pop() || path;
  return {
    value: "@" + path,
    label,
    description: path,
  };
}

interface BuiltResult {
  items: AutocompleteItem[];
}

/** Take FFF's ranked results, drop git-ignored files, and for non-empty
 *  queries keep only paths that contain the query as a substring. This
 *  stops FFF's loose fuzzy matching from ranking every file in a directory
 *  that happens to share a few letters (e.g. "mm/" for query "mmc"). */
function buildResult(items: MixedItem[], lowerQuery: string): BuiltResult | null {
  const filtered = items
    .filter((it) => !isGitIgnored(it))
    .filter(
      (it) =>
        !lowerQuery || it.item.relativePath.toLowerCase().includes(lowerQuery),
    )
    .slice(0, AUTOCOMPLETE_LIMIT)
    .map(toAutocompleteItem);
  return filtered.length ? { items: filtered } : null;
}

export const __smartAtTest = { atPrefix };

/** Active FileFinder for the current session; freed in session_shutdown
 *  to avoid leaking FFF's native handle + LMDB mmap regions. */
let currentFinder: FileFinder | null = null;

export const smartAtModule: Module = {
  name: "smart-at",
  hooks: {
    session_start: [
      async (_event: any, ctx: ExtensionContext) => {
        const cwd = String(ctx.cwd || "").trim();
        const created = FileFinder.create({ basePath: cwd || "." });
        if (!created.ok) {
          // FFF not available on this platform; silently skip.
          return;
        }

        const finder = created.value;
        currentFinder = finder;

        // Start the scan in the background. We don't wait for it here so
        // session_start returns immediately; the provider queries the
        // (possibly partial) index and FFF returns whatever it has indexed
        // so far. Full results appear as the scan progresses.
        void finder.waitForScan(60_000);

        ctx.ui.addAutocompleteProvider((orig: any) => ({
          getSuggestions: (
            lines: string[],
            cl: number,
            cc: number,
            opts?: { signal?: AbortSignal },
          ) => {
            const prefix = atPrefix((lines[cl] || "").slice(0, cc));
            if (!prefix) {
              ctx.ui.setWidget("smart-at", undefined);
              return orig.getSuggestions(lines, cl, cc, opts);
            }

            if (currentFinder !== finder || finder.isDestroyed) {
              ctx.ui.setWidget("smart-at", undefined);
              return orig.getSuggestions(lines, cl, cc, opts);
            }

            // Respect upstream cancellation so fast typing doesn't pile up
            // expensive FFF queries.
            if (opts?.signal?.aborted) {
              return orig.getSuggestions(lines, cl, cc, opts);
            }

            const query = prefix.slice(1);
            const lowerQuery = query.toLowerCase();
            const r = finder.mixedSearch(lowerQuery, {
              pageSize: lowerQuery ? FFF_SUPERSET : AUTOCOMPLETE_LIMIT,
            });
            if (!r.ok) {
              ctx.ui.setWidget("smart-at", undefined);
              return null;
            }

            const result = buildResult(r.value.items, lowerQuery);
            if (!result) {
              ctx.ui.setWidget("smart-at", undefined);
              return null;
            }

            ctx.ui.setWidget("smart-at", [WIDGET_FOOTER]);
            return Promise.resolve({ ...result, prefix });
          },
          applyCompletion: (...args: any[]) => {
            ctx.ui.setWidget("smart-at", undefined);
            return orig.applyCompletion.apply(orig, args);
          },
          shouldTriggerFileCompletion:
            orig.shouldTriggerFileCompletion?.bind(orig),
        }));
      },
    ],
    session_shutdown: [
      (_event: any, _ctx: ExtensionContext) => {
        if (currentFinder && !currentFinder.isDestroyed) {
          currentFinder.destroy();
        }
        currentFinder = null;
      },
    ],
  },
};

export function setupSmartAt(sk: Skeleton): void {
  sk.register(smartAtModule);
}
