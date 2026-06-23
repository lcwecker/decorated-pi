/**
 * System prompt stability — sortSystemPromptOptions unit tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sortSystemPromptOptions } from "../hooks/skeleton.js";
import { stripPiDocsBlock, sortSkillsInSystemPrompt, getBuiltinSkillPaths } from "../index.js";

describe("sortSystemPromptOptions", () => {
  it("sorts toolSnippets keys alphabetically", () => {
    const opts = {
      toolSnippets: {
        zebra: "zebra snippet",
        apple: "apple snippet",
        mango: "mango snippet",
      },
    };
    sortSystemPromptOptions(opts as any);
    const keys = Object.keys(opts.toolSnippets!);
    expect(keys).toEqual(["apple", "mango", "zebra"]);
    expect(opts.toolSnippets!["apple"]).toBe("apple snippet");
    expect(opts.toolSnippets!["mango"]).toBe("mango snippet");
    expect(opts.toolSnippets!["zebra"]).toBe("zebra snippet");
  });

  it("sorts selectedTools to match toolSnippets order", () => {
    const opts = {
      toolSnippets: { zebra: "z", apple: "a", mango: "m" },
      selectedTools: ["zebra", "apple", "mango"],
    };
    sortSystemPromptOptions(opts as any);
    expect(opts.selectedTools).toEqual(["apple", "mango", "zebra"]);
  });

  it("sorts promptGuidelines alphabetically", () => {
    const opts = {
      toolSnippets: {},
      promptGuidelines: ["zebra guideline", "apple guideline", "mango guideline"],
    };
    sortSystemPromptOptions(opts as any);
    expect(opts.promptGuidelines).toEqual(["apple guideline", "mango guideline", "zebra guideline"]);
  });

  it("sorts skills by name", () => {
    const opts = {
      toolSnippets: {},
      skills: [
        { name: "zebra-skill", description: "z", filePath: "/z" },
        { name: "apple-skill", description: "a", filePath: "/a" },
        { name: "mango-skill", description: "m", filePath: "/m" },
      ],
    };
    sortSystemPromptOptions(opts as any);
    expect(opts.skills!.map(s => s.name)).toEqual(["apple-skill", "mango-skill", "zebra-skill"]);
  });

  it("handles all fields present together", () => {
    const opts = {
      toolSnippets: { zebra: "z", apple: "a" },
      selectedTools: ["zebra", "apple"],
      promptGuidelines: ["zebra g", "apple g"],
      skills: [
        { name: "zebra-skill", description: "z", filePath: "/z" },
        { name: "apple-skill", description: "a", filePath: "/a" },
      ],
    };
    sortSystemPromptOptions(opts as any);
    expect(Object.keys(opts.toolSnippets!)).toEqual(["apple", "zebra"]);
    expect(opts.selectedTools).toEqual(["apple", "zebra"]);
    expect(opts.promptGuidelines).toEqual(["apple g", "zebra g"]);
    expect(opts.skills!.map(s => s.name)).toEqual(["apple-skill", "zebra-skill"]);
  });

  it("handles empty arrays", () => {
    const opts = {
      toolSnippets: {},
      selectedTools: [],
      promptGuidelines: [],
      skills: [],
    };
    sortSystemPromptOptions(opts as any);
    expect(Object.keys(opts.toolSnippets!)).toHaveLength(0);
    expect(opts.selectedTools).toHaveLength(0);
  });

  it("does not throw when fields are undefined", () => {
    const opts = {} as Parameters<typeof sortSystemPromptOptions>[0];
    sortSystemPromptOptions(opts);
    // toolSnippets gets initialized to {} when undefined
    expect(opts.toolSnippets).toEqual({});
    expect(opts.selectedTools).toBeUndefined();
    expect(opts.promptGuidelines).toBeUndefined();
    expect(opts.skills).toBeUndefined();
  });

  it("sorts keys in stable order regardless of case", () => {
    const opts = {
      toolSnippets: { zebra: "z", Apple: "A", apple: "a" },
    };
    sortSystemPromptOptions(opts as any);
    const keys = Object.keys(opts.toolSnippets!);
    // Stable alphabetical order, all three present
    expect(keys).toHaveLength(3);
    expect(keys).toContain("Apple");
    expect(keys).toContain("apple");
    expect(keys).toContain("zebra");
  });
});

// ─── Decorated Pi Guidance: main block + codegraph follows MCP server switch ──────────

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("Decorated Pi Guidance structure", () => {
  it("BASE_GUIDANCE is hard-coded in index.ts (workflow + filesystem safety)", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "../index.ts"),
      "utf-8",
    );
    expect(src).toMatch(/BASE_GUIDANCE/);
    expect(src).toMatch(/Before acting on a prompt/);
    expect(src).toMatch(/Exercise caution/);
    expect(src).toMatch(/CAUTION: Do not perform write operations/);
  });

  it("REDACT_GUIDANCE is exported from hooks/redact.ts", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "../hooks/redact.ts"),
      "utf-8",
    );
    expect(src).toMatch(/REDACT_GUIDANCE/);
    expect(src).toMatch(/Secret Masking/);
    expect(src).toMatch(/masked secret values/);
  });

  it("INJECT_AGENTS_MD_GUIDANCE is exported from hooks/inject-agents-md.ts", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "../hooks/inject-agents-md.ts"),
      "utf-8",
    );
    expect(src).toMatch(/INJECT_AGENTS_MD_GUIDANCE/);
    expect(src).toMatch(/Context Loading/);
    expect(src).toMatch(/AGENTS\.md/);
  });

  it("index.ts imports and pushes all module guidelines via buildGuidelines()", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "../index.ts"),
      "utf-8",
    );
    expect(src).toMatch(/REDACT_GUIDANCE/);
    expect(src).toMatch(/INJECT_AGENTS_MD_GUIDANCE/);
    expect(src).toMatch(/TALK_NORMAL_GUIDANCE/);
    expect(src).toMatch(/buildGuidelines/);
  });

  it("TALK_NORMAL_GUIDANCE adapts talk-normal prompt rules", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "../index.ts"),
      "utf-8",
    );
    expect(src).toMatch(/hexiecs\/talk-normal/);
    expect(src).toMatch(/Be direct and informative/);
    expect(src).toMatch(/Never restate the question/);
    expect(src).toMatch(/summary-stamp closings/);
  });

  it("pi-docs skill contains the exact Pi documentation block", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "../skills/pi-docs/SKILL.md"),
      "utf-8",
    );
    expect(src).toMatch(/name: pi-docs/);
    expect(src).toMatch(/description: pi docs resources/);
    expect(src).toMatch(/Pi documentation \(read only when the user asks about pi itself/);
    expect(src).toMatch(/Main documentation:/);
    expect(src).toMatch(/Always read pi \.md files completely/);
  });
});

describe("stripPiDocsBlock", () => {
  it("removes the Pi documentation block and its following non-empty lines", () => {
    const input = [
      "Some base prompt text.",
      "",
      "Pi documentation (read only when ...):",
      "- Main documentation: /path/to/README.md",
      "- Additional docs: /path/to/docs",
      "",
      "Current date: 2025-01-01",
    ].join("\n");
    const result = stripPiDocsBlock(input);
    expect(result).not.toMatch(/Pi documentation/);
    expect(result).not.toMatch(/Main documentation/);
    expect(result).toMatch(/Some base prompt text/);
    expect(result).toMatch(/Current date:/);
  });

  it("leaves unrelated content untouched", () => {
    const input = "Foo\n\nBar\n";
    expect(stripPiDocsBlock(input)).toBe(input);
  });

  it("handles a block at the end of the prompt without a trailing blank line", () => {
    const input = [
      "Base.",
      "",
      "Pi documentation:",
      "- line one",
      "- line two",
    ].join("\n");
    const result = stripPiDocsBlock(input);
    expect(result).not.toMatch(/Pi documentation/);
    expect(result).not.toMatch(/line one/);
    expect(result).toMatch(/Base\./);
  });
});

describe("Builtin skills", () => {
  it("exposes the plugin's skills/ directory as an absolute path", () => {
    const paths = getBuiltinSkillPaths();
    expect(paths).toHaveLength(1);
    expect(fs.existsSync(paths[0])).toBe(true);
    expect(fs.existsSync(path.join(paths[0], "pi-docs", "SKILL.md"))).toBe(true);
  });

  it("registers resources_discover to inject the builtin skill path", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "../index.ts"),
      "utf-8",
    );
    expect(src).toMatch(/resources_discover/);
    expect(src).toMatch(/skillPaths/);
    expect(src).toMatch(/getBuiltinSkillPaths/);
  });
});

describe("sortSkillsInSystemPrompt", () => {
  it("sorts skills alphabetically by name", () => {
    const input = [
      "Intro text.",
      "",
      "<available_skills>",
      "  <skill>",
      "    <name>xlsx</name>",
      "    <description>X</description>",
      "    <location>/xlsx/SKILL.md</location>",
      "  </skill>",
      "  <skill>",
      "    <name>pi-docs</name>",
      "    <description>pi docs resources</description>",
      "    <location>/pi-docs/SKILL.md</location>",
      "  </skill>",
      "  <skill>",
      "    <name>zentao-bug</name>",
      "    <description>Z</description>",
      "    <location>/zentao-bug/SKILL.md</location>",
      "  </skill>",
      "</available_skills>",
    ].join("\n");
    const result = sortSkillsInSystemPrompt(input);
    const names = Array.from(result.matchAll(/<name>([^<]+)<\/name>/g)).map((m) => m[1]);
    expect(names).toEqual(["pi-docs", "xlsx", "zentao-bug"]);
  });

  it("leaves the prompt unchanged when there is no available_skills block", () => {
    const input = "No skills here.";
    expect(sortSkillsInSystemPrompt(input)).toBe(input);
  });

  it("preserves surrounding text and markers", () => {
    const input = [
      "Prefix.",
      "<available_skills>",
      "  <skill>",
      "    <name>b</name>",
      "  </skill>",
      "  <skill>",
      "    <name>a</name>",
      "  </skill>",
      "</available_skills>",
      "Suffix.",
    ].join("\n");
    const result = sortSkillsInSystemPrompt(input);
    expect(result.startsWith("Prefix.\n<available_skills>")).toBe(true);
    expect(result.endsWith("</available_skills>\nSuffix.")).toBe(true);
  });
});
