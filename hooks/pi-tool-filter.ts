/**
 * pi-tool-filter — unregister pi native tools that are replaced by our extensions.
 *
 *   edit  → replaced by patch
 */

import type { Module, Skeleton } from "./skeleton.js";

const TOOLS_TO_DROP = new Set(["edit"]);

export const piToolFilterModule: Module = {
  name: "pi-tool-filter",
  hooks: {
    session_start: [
      (_event, ctx, pi) => {
        const active = pi.getActiveTools();
        pi.setActiveTools(active.filter((t) => !TOOLS_TO_DROP.has(t)));
      },
    ],
  },
};

export function setupPiToolFilter(sk: Skeleton): void {
  sk.register(piToolFilterModule);
}
