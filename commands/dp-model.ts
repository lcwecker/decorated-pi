/**
 * /dp-model — pick image / compact model.
 * UI lives in extensions/ui/model-picker.ts (shared with /mcp status etc).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ModelPickerComponent } from "../ui/model-picker.js";

export function registerDpModelCommand(pi: ExtensionAPI): void {
  pi.registerCommand("dp-model", {
    description: "Configure image and compact models",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        await ctx.ui.custom<void>(
          (tui, theme, _kb, done) =>
            new ModelPickerComponent(tui, theme, ctx.modelRegistry, () => done(undefined))
        );
        return;
      }
      ctx.ui.notify("dp-model requires interactive mode.", "warning");
    },
  });
}
