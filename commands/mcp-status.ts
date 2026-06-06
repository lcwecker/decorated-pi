/**
 * /mcp — show MCP servers, toggle, refresh.
 *
 * Wires the pure UI component (ui/mcp-status.ts) to the hook layer
 * (hooks/mcp.ts) by injecting callbacks. The UI itself knows nothing
 * about hooks/config persistence.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { McpStatusComponent, type McpServerView } from "../ui/mcp-status.js";
import { getMcpStatus, refreshServerCache, updateConfigEnabled } from "../hooks/mcp.js";
import { toggleMcpServerEnabled } from "../tools/mcp/config.js";

export function registerMcpStatusCommand(pi: ExtensionAPI): void {
  pi.registerCommand("mcp", {
    description: "Show active MCP servers and their tools",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        await ctx.ui.custom<void>(
          (tui, theme, _kb, done) =>
            new McpStatusComponent(tui, theme, {
              read: () => getMcpStatus() as McpServerView[],
              toggle: async (name, enabled) => {
                const scope: "global" | "project" = "global";
                const ok = toggleMcpServerEnabled(name, enabled, scope, ctx.cwd || undefined);
                if (ok) {
                  // Await so the connection (if disabling) is fully torn down
                  // before /reload. Otherwise teardownMcp() may hang on a
                  // zombie conn and stall session_shutdown.
                  await updateConfigEnabled(name, enabled);
                }
                return ok;
              },
              refresh: (name) => refreshServerCache(name, ctx.modelRegistry),
            }, done)
        );
        return;
      }
      const servers = getMcpStatus();
      if (servers.length === 0) {
        ctx.ui.notify("No MCP servers configured.", "info");
        return;
      }
      const lines: string[] = [`MCP servers (${servers.length}):`, ""];
      for (const s of servers) {
        lines.push(`• ${s.name} (${s.source})`);
        lines.push(`  URL: ${s.url}`);
        if (s.state === "connecting") lines.push(`  Status: connecting...`);
        else if (s.state === "failed") lines.push(`  Status: failed — ${s.error ?? "unknown error"}`);
        else {
          lines.push(`  Tools: ${s.toolCount}`);
          for (const tool of s.tools) {
            const desc = tool.description ? ` — ${tool.description.slice(0, 60)}` : "";
            lines.push(`    - ${tool.name}${desc}`);
          }
        }
        lines.push("");
      }
      pi.sendMessage({ customType: "mcp-status", content: lines.join("\n"), display: true }, { triggerTurn: false });
    },
  });
}
