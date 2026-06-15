/**
 * Tests for subdir-agents state restoration across reload/compaction.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __subdirAgentsTest } from "../hooks/inject-agents-md.js";

const { restoreFromBranch, findNewAgents, isInsideSkillDir } = __subdirAgentsTest;

describe("subdir-agents state restoration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subdir-agents-test-"));
    fs.mkdirSync(path.join(tmpDir, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "pkg", "AGENTS.md"), "# rules\n", "utf8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not reload AGENTS already restored from branch custom state", () => {
    restoreFromBranch({
      cwd: tmpDir,
      sessionManager: {
        getBranch: () => [
          { type: "custom", customType: "decorated-pi.subdir-agents", data: ["pkg/AGENTS.md"] },
        ],
      },
    });

    const agents = findNewAgents("pkg/file.ts", tmpDir);
    expect(agents).toHaveLength(0);
  });

  it("forgets restored AGENTS before the last compaction", () => {
    restoreFromBranch({
      cwd: tmpDir,
      sessionManager: {
        getBranch: () => [
          { type: "custom", customType: "decorated-pi.subdir-agents", data: ["pkg/AGENTS.md"] },
          { type: "compaction" },
        ],
      },
    });

    const agents = findNewAgents("pkg/file.ts", tmpDir);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.path).toBe("pkg/AGENTS.md");
  });
});

describe("isInsideSkillDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-dir-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true for SKILL.md itself", () => {
    const skillDir = path.join(tmpDir, "skills", "pi-docs");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: pi-docs\n---\n", "utf8");
    expect(isInsideSkillDir(path.join(skillDir, "SKILL.md"))).toBe(true);
  });

  it("returns true for files inside a skill directory", () => {
    const skillDir = path.join(tmpDir, "skills", "pi-docs");
    fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "", "utf8");
    fs.writeFileSync(path.join(skillDir, "references", "doc.md"), "", "utf8");
    expect(isInsideSkillDir(path.join(skillDir, "references", "doc.md"))).toBe(true);
  });

  it("returns false for normal project files", () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "foo.ts"), "", "utf8");
    expect(isInsideSkillDir(path.join(tmpDir, "src", "foo.ts"))).toBe(false);
  });

  it("returns false for project AGENTS.md", () => {
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "", "utf8");
    expect(isInsideSkillDir(path.join(tmpDir, "AGENTS.md"))).toBe(false);
  });

  it("returns true for deeply nested files inside a skill directory", () => {
    const skillDir = path.join(tmpDir, "skills", "pi-docs");
    const deepDir = path.join(skillDir, "references", "nested", "deep");
    fs.mkdirSync(deepDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "", "utf8");
    fs.writeFileSync(path.join(deepDir, "file.md"), "", "utf8");
    expect(isInsideSkillDir(path.join(deepDir, "file.md"))).toBe(true);
  });
});
