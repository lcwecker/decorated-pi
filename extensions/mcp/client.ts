import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Per-server MCP client wrapper with fallback transport. */
export class McpConnection {
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport | undefined;
  tools: McpToolSpec[] = [];
  private connected = false;

  source: string = "unknown";

  constructor(
    public readonly serverName: string,
    public readonly url: string,
  ) {
    this.client = new Client({
      name: `decorated-pi-${serverName}`,
      version: "0.3.0",
    });
  }

  async connect(timeoutMs = 8000): Promise<void> {
    const connectWithFallback = async (): Promise<void> => {
      let lastErr: Error | undefined;
      try {
        const transport = new StreamableHTTPClientTransport(new URL(this.url));
        await this.client.connect(transport);
        this.transport = transport;
        this.connected = true;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        try {
          const transport = new SSEClientTransport(new URL(this.url));
          await this.client.connect(transport);
          this.transport = transport;
          this.connected = true;
        } catch (sseErr) {
          const sseMessage = sseErr instanceof Error ? sseErr.message : String(sseErr);
          throw new Error(
            `MCP ${this.serverName}: StreamableHTTP failed (${lastErr.message}); SSE fallback also failed (${sseMessage})`,
          );
        }
      }

      const result = (await this.client.listTools()) as unknown as {
        tools: Array<{
          name: string;
          description?: string;
          inputSchema?: Record<string, unknown>;
        }>;
      };

      this.tools = (result.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description || "",
        inputSchema: t.inputSchema || { type: "object", properties: {} },
      }));
    };

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`MCP ${this.serverName}: connection timed out after ${timeoutMs}ms`)), timeoutMs),
    );

    await Promise.race([connectWithFallback(), timeout]);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.connected) {
      throw new Error(`MCP ${this.serverName}: not connected`);
    }
    const result = (await this.client.callTool({
      name,
      arguments: args,
    })) as unknown as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };

    const text = (result.content ?? [])
      .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");

    if (result.isError) {
      throw new Error(text || `MCP tool "${name}" returned an error`);
    }

    return text || "(empty result)";
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    try {
      await this.client.close();
    } catch {}
  }
}
