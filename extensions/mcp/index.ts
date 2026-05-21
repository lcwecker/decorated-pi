import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { McpConnection } from "./client.js";
import { resolveMcpConfigs } from "./builtin.js";

export interface McpServerStatus {
  name: string;
  url: string;
  source: string;
  state: "connecting" | "connected" | "failed";
  toolCount: number;
  tools: Array<{ name: string; description: string }>;
  error?: string;
}

let activeConnections: McpConnection[] = [];
let allServers = new Map<string, McpServerStatus>();
let connectPromise: Promise<void> | null = null;

export function setupMcp(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    void (async () => {
      await teardownMcp();

      const configs = resolveMcpConfigs(ctx.cwd);
      if (configs.length === 0) return;

      // Initialise every target server as "connecting"
      allServers = new Map(
        configs.map((s) => [
          s.name,
          {
            name: s.name,
            url: s.url,
            source: s.source,
            state: "connecting" as const,
            toolCount: 0,
            tools: [],
          },
        ]),
      );

      connectPromise = Promise.all(
        configs.map(async (server) => {
          const conn = new McpConnection(server.name, server.url);
          conn.source = server.source;

          try {
            await conn.connect();
            activeConnections.push(conn);

            for (const tool of conn.tools) {
              const prefixedName = `${server.name}_${tool.name}`;
              pi.registerTool({
                name: prefixedName,
                label: `MCP: ${tool.name}`,
                description: tool.description,
                promptSnippet: tool.description.slice(0, 120),
                parameters: Type.Unsafe(tool.inputSchema as never),
                execute: async (_toolCallId, params, _signal, _onUpdate, _ctx2) => {
                  const text = await conn.callTool(
                    tool.name,
                    params as Record<string, unknown>,
                  );
                  return {
                    content: [{ type: "text" as const, text }],
                    isError: false,
                    details: { server: server.name, tool: tool.name },
                  };
                },
              });
            }

            allServers.set(server.name, {
              name: server.name,
              url: server.url,
              source: server.source,
              state: "connected",
              toolCount: conn.tools.length,
              tools: conn.tools.map((t) => ({ name: t.name, description: t.description })),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            allServers.set(server.name, {
              name: server.name,
              url: server.url,
              source: server.source,
              state: "failed",
              toolCount: 0,
              tools: [],
              error: msg,
            });
          }
        }),
      ).then(() => undefined);

      await connectPromise;
      connectPromise = null;
    })();
  });

  pi.on("session_shutdown", () => {
    void teardownMcp();
  });
}

export function getMcpStatus(): McpServerStatus[] {
  return [...allServers.values()];
}

async function teardownMcp(): Promise<void> {
  await Promise.all(
    activeConnections.map(async (conn) => {
      try {
        await conn.disconnect();
      } catch {
        // Silently ignore disconnect errors.
      }
    }),
  );
  activeConnections = [];
  allServers = new Map();
}
