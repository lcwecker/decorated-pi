/**
 * Builtin pi-docs skill — two-stage lifecycle:
 *  1. ensureSkillFrontmatter (resources_discover): entry layer — file
 *     existence + frontmatter (name/description/metadata marker).
 *  2. updateSkillBody (before_agent_start): content layer — sync the body
 *     with the exact "Pi documentation" block Pi rendered for this install.
 *  User-authored files (no marker) are never touched.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PI_DOCS_MARKER,
  PI_DOCS_SKILL_NAME,
  buildPiDocsFrontmatter,
  ensureSkillFrontmatter,
  splitSkillFile,
  updateSkillBody,
} from "../index.js";

function skillFile(agentDir: string): string {
  return path.join(agentDir, "skills", PI_DOCS_SKILL_NAME, "SKILL.md");
}

const REAL_BLOCK = [
  "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
  "- Main documentation: `/active/pi/README.md`",
  "- Additional docs: `/active/pi/docs`",
  "- Examples: `/active/pi/examples` (extensions, custom tools, SDK)",
].join("\n");

describe("buildPiDocsFrontmatter", () => {
  it("emits a valid YAML frontmatter with name, description, and ownership marker", () => {
    const fm = buildPiDocsFrontmatter();
    const lines = fm.split("\n");
    expect(lines[0]).toBe("---");
    expect(lines[lines.length - 1]).toBe("---");
    expect(fm).toContain(`name: ${PI_DOCS_SKILL_NAME}`);
    expect(fm).toContain("description: Use when the user asks about pi itself");
    expect(fm).toContain("metadata:");
    expect(fm).toContain(`  ${PI_DOCS_MARKER}`);
  });
});

describe("splitSkillFile", () => {
  it("splits frontmatter and body", () => {
    const content = [
      "---",
      "name: pi-docs",
      "---",
      "",
      "Body text.",
      "",
    ].join("\n");
    const split = splitSkillFile(content);
    expect(split).toBeDefined();
    expect(split!.frontmatter).toBe("---\nname: pi-docs\n---");
    expect(split!.body).toBe("Body text.");
  });

  it("returns undefined for a file without frontmatter", () => {
    expect(splitSkillFile("no frontmatter here")).toBeUndefined();
  });
});

describe("ensureSkillFrontmatter", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "decorated-pi-agent-"));
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("creates the skill on first run with placeholder body and returns re-scan paths", () => {
    const result = ensureSkillFrontmatter(agentDir);
    expect(result.skillPaths).toEqual([path.join(agentDir, "skills")]);
    const file = skillFile(agentDir);
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain(PI_DOCS_MARKER);
    expect(content).toContain("name: pi-docs");
    expect(content).toContain("Placeholder");
  });

  it("is a no-op when the entry layer is already up to date", () => {
    ensureSkillFrontmatter(agentDir);
    const file = skillFile(agentDir);
    const before = fs.readFileSync(file, "utf-8");
    const result = ensureSkillFrontmatter(agentDir);
    expect(result.skillPaths).toBeUndefined();
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });

  it("refreshes only the frontmatter when the description changed, preserving the body", () => {
    ensureSkillFrontmatter(agentDir);
    const file = skillFile(agentDir);
    const content = fs.readFileSync(file, "utf-8");
    const custom = content.replace(
      /description: .*/,
      "description: old description from a previous plugin version",
    );
    fs.writeFileSync(file, custom, "utf-8");

    const result = ensureSkillFrontmatter(agentDir);
    expect(result.skillPaths).toEqual([path.join(agentDir, "skills")]);
    const updated = fs.readFileSync(file, "utf-8");
    expect(updated).toContain("description: Use when the user asks about pi itself");
    // body preserved across the frontmatter refresh
    expect(updated).toContain("Placeholder");
  });

  it("never touches a user-authored skill without the marker", () => {
    const file = skillFile(agentDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const userSkill = [
      "---",
      "name: pi-docs",
      "description: my own pi docs skill",
      "---",
      "",
      "User content.",
      "",
    ].join("\n");
    fs.writeFileSync(file, userSkill, "utf-8");

    const result = ensureSkillFrontmatter(agentDir);
    expect(result.skillPaths).toBeUndefined();
    expect(fs.readFileSync(file, "utf-8")).toBe(userSkill);
  });
});

describe("updateSkillBody", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "decorated-pi-agent-"));
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("writes the real block on the first agent turn", () => {
    expect(updateSkillBody(agentDir, REAL_BLOCK)).toBe(true);
    const content = fs.readFileSync(skillFile(agentDir), "utf-8");
    expect(content).toContain(PI_DOCS_MARKER);
    expect(content).toContain("- Main documentation: `/active/pi/README.md`");
  });

  it("is a no-op when the body already matches the rendered block", () => {
    updateSkillBody(agentDir, REAL_BLOCK);
    const file = skillFile(agentDir);
    const before = fs.readFileSync(file, "utf-8");
    expect(updateSkillBody(agentDir, REAL_BLOCK)).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });

  it("replaces an outdated body while preserving the frontmatter", () => {
    updateSkillBody(agentDir, "old block content");
    const file = skillFile(agentDir);
    const before = fs.readFileSync(file, "utf-8");
    expect(before).toContain("old block content");

    expect(updateSkillBody(agentDir, REAL_BLOCK)).toBe(true);
    const updated = fs.readFileSync(file, "utf-8");
    expect(updated).not.toContain("old block content");
    expect(updated).toContain("- Additional docs: `/active/pi/docs`");
  });

  it("never touches a user-authored skill without the marker", () => {
    const file = skillFile(agentDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const userSkill = [
      "---",
      "name: pi-docs",
      "description: my own pi docs skill",
      "---",
      "",
      "User content.",
      "",
    ].join("\n");
    fs.writeFileSync(file, userSkill, "utf-8");

    expect(updateSkillBody(agentDir, REAL_BLOCK)).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe(userSkill);
  });
});

describe("pi-docs lifecycle (discovery → content)", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "decorated-pi-agent-"));
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("ends with a skill whose body is exactly the rendered block", () => {
    ensureSkillFrontmatter(agentDir);
    updateSkillBody(agentDir, REAL_BLOCK);
    const content = fs.readFileSync(skillFile(agentDir), "utf-8");
    const split = splitSkillFile(content);
    expect(split).toBeDefined();
    expect(split!.frontmatter).toBe(buildPiDocsFrontmatter());
    expect(split!.body.trim()).toBe(REAL_BLOCK);
    // re-running both stages is stable
    expect(ensureSkillFrontmatter(agentDir).skillPaths).toBeUndefined();
    expect(updateSkillBody(agentDir, REAL_BLOCK)).toBe(false);
  });
});
