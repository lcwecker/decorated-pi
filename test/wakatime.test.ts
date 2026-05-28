/**
 * Tests for wakatime.ts — heartbeat metadata and classification helpers
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAppHeartbeat,
  buildFileHeartbeat,
  classifyBash,
  heartbeatChanged,
  readWakatimeCfgApiKey,
} from "../extensions/wakatime.js";

function countPathParts(p: string): number {
  return path.resolve(p).split(/[\\/]+/).filter(Boolean).length;
}

describe("wakatime", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wakatime-test-"));
  });

  afterEach(() => {
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
