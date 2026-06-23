/**
 * /dp-settings — settings for decorated-pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { moduleSnapshotChanged } from "../settings.js";
import { ModuleSettingsComponent } from "../ui/module-settings.js";

export function registerDpSettingsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("dp-settings", {
    description: "Settings for decorated-pi",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        await ctx.ui.custom<void>(
          (tui, theme, _kb, done) =>
            new ModuleSettingsComponent(tui, theme, ctx.ui, () => done(undefined))
        );
        // Only prompt for reload when the effective settings differ from
        // the snapshot taken when pi loaded the extension.
        if (moduleSnapshotChanged()) {
          ctx.ui.notify("Module settings updated. /reload to apply.", "warning");
        }
        return;
      }
      ctx.ui.notify("dp-settings requires interactive mode.", "warning");
    },
  });
}
