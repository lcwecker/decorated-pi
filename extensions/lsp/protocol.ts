/**
 * JSON-RPC over stdio — minimal LSP transport layer.
 *
 * Handles message framing (Content-Length headers), request/response
 * correlation with timeouts, and server-to-client notifications.
 */
import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export class LspProtocolError extends Error {
  constructor(public readonly code: number, message: string) {
    super(`LSP error ${code}: ${message}`);
    this.name = "LspProtocolError";
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class LspProtocol extends EventEmitter {
  #proc: ChildProcess | null = null;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #stopped = false;

  get process(): ChildProcess | null {
    return this.#proc;
  }

  /** Spawn the LSP server process. */
  spawn(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#stopped = false;
      this.#proc = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
      const proc = this.#proc;
      let settled = false;

      proc.once("spawn", () => {
        if (settled) return;
        settled = true;
        resolve();
      });

      proc.once("error", (err) => {
        if (!settled) {
          settled = true;
          reject(Object.assign(new Error(`Failed to spawn ${command}: ${err.message}`), { code: (err as NodeJS.ErrnoException).code }));
        }
      });

      proc.on("close", (code) => {
        if (!this.#stopped) {
          for (const p of this.#pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error(`LSP server exited (code ${code})`));
          }
          this.#pending.clear();
        }
      });

      proc.stderr?.on("data", () => {}); // discard

      proc.stdout?.on("data", (chunk: Buffer) => {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        this.#drain();
      });
    });
  }

  /** Send a request and wait for response. */
  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`LSP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err);
      }
    });
  }

  /** Send a fire-and-forget notification. */
  notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  /** Gracefully shut down the server. */
  async shutdown(timeoutMs = 1000): Promise<void> {
    this.#stopped = true;
    try {
      await this.request("shutdown", null, timeoutMs);
    } catch {
      // server already dead
    }
    this.notify("exit", null);
    this.#proc?.kill();
    this.#proc = null;
  }

  /** Force kill. */
  kill(): void {
    this.#stopped = true;
    this.#proc?.kill();
    this.#proc = null;
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("LSP protocol stopped"));
    }
    this.#pending.clear();
  }

  #send(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (!this.#proc?.stdin?.writable) {
      throw new Error("LSP server not connected");
    }
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
    this.#proc.stdin.write(Buffer.concat([header, body]));
  }

  #drain(): void {
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.#buffer = this.#buffer.subarray(headerEnd + 4);
        continue;
      }

      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.#buffer.length < bodyStart + length) return;

      const body = this.#buffer.subarray(bodyStart, bodyStart + length);
      this.#buffer = this.#buffer.subarray(bodyStart + length);

      try {
        this.#handle(JSON.parse(body.toString("utf8")));
      } catch (err) {
        // ignore malformed messages
      }
    }
  }

  #handle(msg: Record<string, unknown>): void {
    // Response to our request
    if (msg.id != null) {
      const numId = typeof msg.id === "number"
        ? msg.id
        : typeof msg.id === "string" && /^-?\d+$/.test(msg.id)
          ? Number(msg.id)
          : null;

      if (numId != null && this.#pending.has(numId)) {
        const p = this.#pending.get(numId)!;
        this.#pending.delete(numId);
        clearTimeout(p.timer);

        if (msg.error) {
          const e = msg.error as { code: number; message: string };
          p.reject(new LspProtocolError(e.code, e.message));
        } else {
          p.resolve(msg.result);
        }
        return;
      }

      // Server-to-client request — respond with null
      if (msg.method != null && msg.id != null) {
        const resp: JsonRpcResponse = { jsonrpc: "2.0", id: msg.id as number | string, result: null };
        this.#send(resp);
      }
      return;
    }

    // Notification from server
    if (msg.method === "textDocument/publishDiagnostics" && msg.params) {
      this.emit("diagnostics", msg.params);
    }
  }
}
