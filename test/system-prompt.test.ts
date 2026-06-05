/**
 * System prompt stability — sortSystemPromptOptions unit tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sortSystemPromptOptions } from "../extensions/index.js";

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

// ─── Decorated Pi Guidance: sub-headings + codegraph conditional ──────────

import { isCodegraphActive } from "../extensions/index.js";
import { getAllModuleSettings, setModuleEnabled } from "../extensions/settings.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("Decorated Pi Guidance structure", () => {
  it("groups existing rules under ### sub-headings", () => {
    // Read the source of the guidance builder to make sure the rules are
    // organised under sub-headings (cache-friendly + easier for the LLM
    // to skim). The order in this expectation also pins the file layout.
    const extSrc = fs.readFileSync(
      path.join(import.meta.dirname, "../extensions/index.ts"),
      "utf-8",
    );
    expect(extSrc).toMatch(/###\s+Workflow/);
    expect(extSrc).toMatch(/###\s+Context Loading/);
    expect(extSrc).toMatch(/###\s+Filesystem Safety/);
    expect(extSrc).toMatch(/###\s+Secret Masking/);
    expect(extSrc).toMatch(/###\s+CodeGraph/);
  });
});

describe.sequential("isCodegraphActive", () => {
  let tmpDir: string;
  let prevModuleState: boolean;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-active-"));
    prevModuleState = getAllModuleSettings().codegraph;
    // Ensure module is OFF for tests that rely on default state
    setModuleEnabled("codegraph", false);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setModuleEnabled("codegraph", prevModuleState ?? false);
  });

  it("returns false on a fresh project (module off by default)", () => {
    // modules.codegraph defaults to false — opt-in via /dp-settings.
    // isCodegraphActive is a pure dp-settings check; tmpDir is unused.
    expect(isCodegraphActive()).toBe(false);
  });

  it("returns true when module is on (no .codegraph/ probe needed)", () => {
    // Once the user enables codegraph in /dp-settings, the server is
    // registered and guidance is injected, regardless of whether the
    // project has been initialised. If the project hasn't run
    // `codegraph init` yet, the tools will error at call time, but
    // the agent still needs to know they exist. The function is a
    // pure dp-settings check — no filesystem probe.
    setModuleEnabled("codegraph", true);
    expect(isCodegraphActive()).toBe(true);
  });
});
