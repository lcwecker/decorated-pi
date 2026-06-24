/**
 * smart-at — high-speed file search autocomplete.
 *
 * Uses @ff-labs/fff-node (FFF) for cross-platform fuzzy file search.
 * FFF maintains an in-memory index, scores files by fuzzy match +
 * frecency + git status, and returns ranked results. We create one
 * FileFinder per session and query it directly for every @ prefix.
 *
 * Result handling trusts FFF's native score: re-sort by score
 * descending (shorter path breaks ties), no substring or git-ignore
 * post-filtering.
 *
 * KNOWN FFF LIMITATION (v0.9.4):
 * FFF only returns directories that directly contain files. Intermediate
 * folders that only hold subdirectories (e.g. product/module/apmanage/ where
 * all files live in product/module/apmanage/deep/) will not appear in
 * mixedSearch/directorySearch results, even though the files underneath do.
 * We intentionally do NOT synthesize these directories on the TypeScript side
 * to avoid extra complexity/cost; the fix belongs upstream.
 */

import { FileFinder, type MixedItem } from "@ff-labs/fff-node";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Module, Skeleton } from "./skeleton.js";

// Characters that, when preceding an "@", allow us to start a smart-at
// completion.
const AT_BOUNDARY = new Set<string>([" ", "\t", "(", "["]);

const AUTOCOMPLETE_LIMIT = 20;
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

/** Take FFF's mixed-search results and re-sort by native score descending
 *  (score ties broken by shorter path first), then map to autocomplete
 *  items. Trust FFF's fuzzy+frecency score; no substring or git-ignore
 *  post-filtering. */
function buildResult(items: MixedItem[], scores: { total: number }[]): BuiltResult | null {
  const ranked = items
    .map((item, index) => ({ item, score: scores[index]?.total ?? 0 }))
    .sort((a, b) => b.score - a.score || a.item.item.relativePath.length - b.item.item.relativePath.length)
    .slice(0, AUTOCOMPLETE_LIMIT)
    .map((entry) => toAutocompleteItem(entry.item));
  return ranked.length ? { items: ranked } : null;
}

export const __smartAtTest = { atPrefix, buildResult };

/** Active FileFinder for the current session; freed in session_shutdown
 *  to avoid leaking FFF's native handle + LMDB mmap regions. */
let currentFinder: FileFinder | null = null;

export const smartAtModule: Module = {
  name: "smart-at",
  hooks: {
    session_start: [
      async (_event: any, ctx: ExtensionContext) => {
        const cwd = String(ctx.cwd || "").trim();
        // Always opt in to home/root scanning. These flags are opt-in guards
        // in FFF — when cwd is a normal project, they're no-ops; when cwd
        // IS $HOME or /, they let FFF index it. Without them, create() fails
        // outright when cwd is a home/root, leaving the user without @-search.
        const created = FileFinder.create({
          basePath: cwd || ".",
          enableHomeDirScanning: true,
          enableFsRootScanning: true,
        });
        if (!created.ok) {
          // FFF not available on this platform; silently skip.
          return;
        }

        const finder = created.value;
        currentFinder = finder;

        let scanWidgetVisible = false;

        // Start the scan in the background. We don't wait for it here so
        // session_start returns immediately. If a scanning status was shown,
        // clear it when the scan finishes even if no new autocomplete request
        // is triggered afterwards.
        void finder.waitForScan(60_000).then(() => {
          if (currentFinder === finder && !finder.isDestroyed && scanWidgetVisible) {
            scanWidgetVisible = false;
            ctx.ui.setWidget("smart-at", undefined);
          }
        });

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
            const r = finder.mixedSearch(query.toLowerCase(), {
              pageSize: AUTOCOMPLETE_LIMIT,
            });
            if (!r.ok) {
              ctx.ui.setWidget("smart-at", undefined);
              return null;
            }

            // 0 items during the initial scan means FFF is not ready yet.
            // Autocomplete has no non-selectable dropdown state: returning an
            // item would force SelectList to render a selectable "→ ..." row.
            // So use a static below-editor widget while scanning, and clear it
            // once the scan completes (see waitForScan above). After scanning,
            // 0 items just means "no match".
            if (r.value.items.length === 0) {
              if (finder.isScanning()) {
                scanWidgetVisible = true;
                ctx.ui.setWidget(
                  "smart-at",
                  ["⏳ scanning…  (indexing files, please wait)"],
                  { placement: "belowEditor" },
                );
              } else {
                scanWidgetVisible = false;
                ctx.ui.setWidget("smart-at", undefined);
              }
              return null;
            }

            const result = buildResult(r.value.items, r.value.scores);
            if (!result) {
              ctx.ui.setWidget("smart-at", undefined);
              return null;
            }

            scanWidgetVisible = false;
            ctx.ui.setWidget("smart-at", [WIDGET_FOOTER]);
            return Promise.resolve({ ...result, prefix });
          },
          applyCompletion: (
            lines: string[],
            cl: number,
            cc: number,
            item: { value: string; label: string },
            prefix: string,
          ) => {
            scanWidgetVisible = false;
            ctx.ui.setWidget("smart-at", undefined);
            return orig.applyCompletion(lines, cl, cc, item, prefix);
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
