import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "./config.js";
import { isSseUrl } from "./config.js";

export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Per-server MCP client wrapper. Supports stdio, http, and sse transports. */
export class McpConnection {
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport | undefined;
  tools: McpToolSpec[] = [];
  connected = false;
  private disposed = false;
  private closePromise: Promise<void> | null = null;

  source: string = "unknown";

  constructor(
    public readonly serverName: string,
    public readonly config: McpServerConfig,
  ) {
    this.client = new Client({
      name: `decorated-pi-${serverName}`,
      version: "0.3.0",
    });
  }

  async connect(timeoutMs = 8000): Promise<void> {
    const connectAndListTools = async (): Promise<void> => {
      if (this.config.command) {
        // Stdio transport — spawn a local process
        const transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          env: this.config.env,
          stderr: "ignore",
        });
        this.transport = transport;
        await this.client.connect(transport);
        if (this.disposed) throw new Error(`MCP ${this.serverName}: connection cancelled`);
        this.connected = true;
      } else if (this.config.url) {
        // HTTP or SSE transport — determined by URL path
        if (isSseUrl(this.config.url)) {
          const transport = new SSEClientTransport(new URL(this.config.url));
          this.transport = transport;
          await this.client.connect(transport);
        } else {
          const transport = new StreamableHTTPClientTransport(new URL(this.config.url));
          this.transport = transport;
          await this.client.connect(transport);
        }
        if (this.disposed) throw new Error(`MCP ${this.serverName}: connection cancelled`);
        this.connected = true;
      } else {
        throw new Error(`MCP ${this.serverName}: no url or command configured`);
      }

      const result = (await this.client.listTools()) as unknown as {
        tools: Array<{
          name: string;
          description?: string;
          inputSchema?: Record<string, unknown>;
        }>;
      };

      if (this.disposed) throw new Error(`MCP ${this.serverName}: connection cancelled`);
      this.tools = (result.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description || "",
        inputSchema: t.inputSchema || { type: "object", properties: {} },
      }));
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`MCP ${this.serverName}: connection timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      await Promise.race([connectAndListTools(), timeout]);
    } catch (error) {
      // Start cleanup, but don't await SDK close here: close() can hang for
      // the same transport-level reasons as connect(). Runtime teardown has
      // its own bounded wait and disconnect() is idempotent.
      void this.disconnect();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
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
    this.disposed = true;
    this.connected = false;
    if (!this.transport) return;
    this.closePromise ??= (async () => {
      try { await this.client.close(); } catch { /* ignore */ }
    })();
    await this.closePromise;
  }
}