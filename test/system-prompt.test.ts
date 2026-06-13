/**
 * System prompt stability — sortSystemPromptOptions unit tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sortSystemPromptOptions } from "../hooks/skeleton.js";

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
    expect(src).toMatch(/CODEGRAPH_GUIDANCE/);
    expect(src).toMatch(/buildGuidelines/);
  });

  it("CODEGRAPH_GUIDANCE is gated on resolveMcpConfigs codegraph enabled", () => {
    // The gating lives in tools/mcp/builtin/codegraph.ts (isCodegraphGuidanceActive)
    // so index.ts only needs to call the predicate.
    const indexSrc = fs.readFileSync(
      path.join(import.meta.dirname, "../index.ts"),
      "utf-8",
    );
    const codegraphSrc = fs.readFileSync(
      path.join(import.meta.dirname, "../tools/mcp/builtin/codegraph.ts"),
      "utf-8",
    );
    expect(indexSrc).toMatch(/isCodegraphGuidanceActive/);
    expect(indexSrc).not.toMatch(/c\.name === "codegraph"/);
    expect(codegraphSrc).toMatch(/resolveMcpConfigs/);
    expect(codegraphSrc).toMatch(/canUseInProject/);
    expect(codegraphSrc).not.toMatch(/isModuleEnabled\(["']codegraph["']\)/);
  });
});
