/**
 * Tests for wakatime.ts — heartbeat metadata and classification helpers
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAppHeartbeat,
  buildCliArgs,
  buildFileHeartbeat,
  buildPluginString,
  classifyBash,
  findWakatimeCli,
  heartbeatChanged,
  readWakatimeCfgApiKey,
  resetWakatimeStateForTests,
  setupWakatimeWithApiKey,
} from "../hooks/wakatime.js";

function countPathParts(p: string): number {
  return path.resolve(p).split(/[\\/]+/).filter(Boolean).length;
}

describe("wakatime", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wakatime-test-"));
  });

  afterEach(() => {
    resetWakatimeStateForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("readWakatimeCfgApiKey", () => {
    it("reads and trims api_key from config", () => {
      const cfgPath = path.join(tmpDir, ".wakatime.cfg");
      fs.writeFileSync(cfgPath, "[settings]\napi_key =  'abc-123'  \n", "utf-8");
      expect(readWakatimeCfgApiKey(cfgPath)).toBe("abc-123");
    });

    it("returns undefined when config is missing", () => {
      expect(readWakatimeCfgApiKey(path.join(tmpDir, "missing.cfg"))).toBeUndefined();
    });
  });

  describe("classifyBash", () => {
    it("classifies build commands", () => {
      expect(classifyBash("pnpm build")).toBe("building");
      expect(classifyBash("cargo build --release")).toBe("building");
    });

    it("classifies test commands", () => {
      expect(classifyBash("vitest run")).toBe("running tests");
      expect(classifyBash("go test ./... ")).toBe("running tests");
    });

    it("defaults other or empty commands to ai coding", () => {
      expect(classifyBash(undefined)).toBe("ai coding");
      expect(classifyBash("rg TODO src")).toBe("ai coding");
    });
  });

  describe("heartbeatChanged", () => {
    it("returns false for identical heartbeats", () => {
      const hb = {
        entity: "/tmp/a.ts",
        type: "file" as const,
        category: "ai coding" as const,
        project: "demo",
        project_root_count: 3,
        language: "TypeScript",
        lines: 10,
      };
      expect(heartbeatChanged(hb, { ...hb })).toBe(false);
    });

    it("returns true when tracked fields change", () => {
      const base = {
        entity: "/tmp/a.ts",
        type: "file" as const,
        category: "ai coding" as const,
        project: "demo",
        project_root_count: 3,
        language: "TypeScript",
      };
      expect(heartbeatChanged(base, { ...base, entity: "/tmp/b.ts" })).toBe(true);
      expect(heartbeatChanged(base, { ...base, category: "running tests" })).toBe(true);
      expect(heartbeatChanged(base, { ...base, project: "other" })).toBe(true);
    });
  });

  describe("buildCliArgs", () => {
    it("builds wakatime-cli args with plugin and project-folder", () => {
      const hb = {
        entity: "/tmp/demo.ts",
        time: 123,
        type: "file" as const,
        category: "ai coding" as const,
        project: "demo",
        language: "TypeScript",
        lines: 42,
        is_write: true,
      };
      expect(buildCliArgs(hb, "abc-123", "/tmp/project", buildPluginString("9.9.9"))).toEqual([
        "--entity", "/tmp/demo.ts",
        "--entity-type", "file",
        "--category", "ai coding",
        "--plugin", "pi/9.9.9 pi/9.9.9",
        "--key", "abc-123",
        "--time", "123",
        "--hostname", os.hostname(),
        "--project-folder", "/tmp/project",
        "--project", "demo",
        "--language", "TypeScript",
        "--lines-in-file", "42",
        "--write",
      ]);
    });

    it("omits project-folder for files outside the current project", () => {
      const hb = {
        entity: "/tmp/demo.ts",
        time: 123,
        type: "file" as const,
        category: "ai coding" as const,
        language: "TypeScript",
        lines: 42,
      };
      expect(buildCliArgs(hb, "abc-123", "/tmp/project", buildPluginString("9.9.9"))).toEqual([
        "--entity", "/tmp/demo.ts",
        "--entity-type", "file",
        "--category", "ai coding",
        "--plugin", "pi/9.9.9 pi/9.9.9",
        "--key", "abc-123",
        "--time", "123",
        "--hostname", os.hostname(),
        "--language", "TypeScript",
        "--lines-in-file", "42",
      ]);
    });
  });

  describe("findWakatimeCli", () => {
    it("prefers PATH and caches the absolute path", () => {
      const probePath = vi.fn(() => "bin/wakatime-cli");

      expect(findWakatimeCli({ probePath })).toBe(path.resolve("bin/wakatime-cli"));
      expect(findWakatimeCli({ probePath })).toBe(path.resolve("bin/wakatime-cli"));
      expect(probePath).toHaveBeenCalledTimes(1);
    });

    it("returns null when probePath finds nothing and caches it", () => {
      const probePath = vi.fn(() => null);

      expect(findWakatimeCli({ probePath })).toBe(null);
      expect(findWakatimeCli({ probePath })).toBe(null);
      expect(probePath).toHaveBeenCalledTimes(1);
    });
  });

  describe("setupWakatime", () => {
    function createFakePi() {
      const handlers = new Map<string, Function[]>();
      return {
        handlers,
        pi: {
          on(event: string, handler: Function) {
            const arr = handlers.get(event) ?? [];
            arr.push(handler);
            handlers.set(event, arr);
          },
        },
      };
    }

    it("does nothing when no api key is configured", () => {
      const { pi, handlers } = createFakePi();
      setupWakatimeWithApiKey(pi as any, undefined);
      expect(handlers.size).toBe(0);
    });

    it("keeps app heartbeat active while file heartbeats are one-shot", () => {
      vi.useFakeTimers();
      const sent: Array<{ hb: any; cwd?: string }> = [];

      const { pi, handlers } = createFakePi();
      setupWakatimeWithApiKey(pi as any, "abc-123", "/usr/bin/wakatime-cli", (hb, cwd) => {
        sent.push({ hb, cwd });
      });

      const cwd = path.join(tmpDir, "repo");
      const filePath = path.join(cwd, "src", "main.ts");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "const x = 1;\nconst y = 2;\n", "utf-8");

      let terminalInputHandler: ((data: string) => unknown) | undefined;
      const sessionCtx = {
        cwd,
        hasUI: true,
        ui: {
          onTerminalInput(handler: (data: string) => unknown) {
            terminalInputHandler = handler;
            return () => {
              terminalInputHandler = undefined;
            };
          },
        },
      };

      handlers.get("session_start")?.[0]({ reason: "startup" }, sessionCtx);
      terminalInputHandler?.("a");
      handlers.get("tool_result")?.[0]({ toolName: "read", input: { path: filePath } }, { cwd });

      expect(sent).toHaveLength(2);
      expect(sent[0]!.hb.entity).toBe("pi");
      expect(sent[0]!.hb.type).toBe("app");
      expect(sent[1]!.hb.entity).toBe(filePath);
      expect(sent[1]!.hb.type).toBe("file");

      vi.advanceTimersByTime(90_000);
      expect(sent).toHaveLength(3);
      expect(sent[2]!.hb.entity).toBe("pi");
      expect(sent[2]!.hb.type).toBe("app");
    });

    it("keeps the app heartbeat active across terminal input, agent start/end, and keepalive", () => {
      vi.useFakeTimers();
      const sent: Array<{ hb: any; cwd?: string }> = [];

      const { pi, handlers } = createFakePi();
      setupWakatimeWithApiKey(pi as any, "abc-123", "/usr/bin/wakatime-cli", (hb, cwd) => {
        sent.push({ hb, cwd });
      });

      const cwd = path.join(tmpDir, "repo-flow");
      const filePath = path.join(cwd, "src", "flow.ts");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "export const flow = true;\n", "utf-8");

      let terminalInputHandler: ((data: string) => unknown) | undefined;
      const sessionCtx = {
        cwd,
        hasUI: true,
        ui: {
          onTerminalInput(handler: (data: string) => unknown) {
            terminalInputHandler = handler;
            return () => {
              terminalInputHandler = undefined;
            };
          },
        },
      };

      handlers.get("session_start")?.[0]({ reason: "startup" }, sessionCtx);
      terminalInputHandler?.("x");
      handlers.get("tool_result")?.[0]({ toolName: "read", input: { path: filePath } }, { cwd });
      handlers.get("before_agent_start")?.[0]({}, { cwd });
      handlers.get("agent_end")?.[0]({}, { cwd });

      expect(sent).toHaveLength(3);
      const bodies = sent.map((call) => call.hb);
      expect(bodies.map((b) => `${b.type}:${b.entity}`)).toEqual([
        "app:pi",
        `file:${filePath}`,
        "app:pi",
      ]);

      vi.advanceTimersByTime(89_000);
      expect(sent).toHaveLength(3);
      vi.advanceTimersByTime(1_000);
      expect(sent).toHaveLength(4);
      const keepalive = sent[3]!.hb;
      expect(keepalive.entity).toBe("pi");
      expect(keepalive.type).toBe("app");
    });
  });

  describe("buildAppHeartbeat", () => {
    it("uses cwd basename as project metadata", () => {
      const cwd = path.join(tmpDir, "my-project");
      fs.mkdirSync(cwd, { recursive: true });

      expect(buildAppHeartbeat(cwd)).toEqual({
        entity: "pi",
        type: "app",
        category: "ai coding",
        project: "my-project",
        project_root_count: countPathParts(cwd),
      });
    });
  });

  describe("buildFileHeartbeat", () => {
    it("captures project metadata for files inside cwd", () => {
      const cwd = path.join(tmpDir, "repo");
      const filePath = path.join(cwd, "src", "main.ts");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "const a = 1;\nconst b = 2;", "utf-8");

      expect(buildFileHeartbeat(filePath, cwd)).toEqual({
        entity: filePath,
        type: "file",
        category: "ai coding",
        project: "repo",
        project_root_count: countPathParts(cwd),
        language: "TypeScript",
        lines: 2,
      });
    });

    it("does not assign cwd project to files outside cwd", () => {
      const cwd = path.join(tmpDir, "repo");
      const outside = path.join(tmpDir, "scratch.py");
      fs.mkdirSync(cwd, { recursive: true });
      fs.writeFileSync(outside, "print('hi')", "utf-8");

      expect(buildFileHeartbeat(outside, cwd)).toEqual({
        entity: outside,
        type: "file",
        category: "ai coding",
        project: undefined,
        project_root_count: undefined,
        language: "Python",
        lines: 1,
      });
    });
  });
});
