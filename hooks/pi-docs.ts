/**
 * pi-docs — builtin skill that carries Pi's own documentation block.
 *
 * Two-stage lifecycle, both owned here:
 *  1. `resources_discover` (entry layer) — make sure a SKILL.md exists with
 *     our frontmatter, so this session's skill scan picks up the entry.
 *  2. `before_agent_start` (content layer) — write the body with the exact
 *     "Pi documentation" block Pi rendered for the CURRENT install, replace
 *     Pi's docs section with a short pointer into that skill, and add the
 *     decorated-pi guidelines as their own prompt section.
 *
 * Both prompt changes are structured sections (`systemPromptOptions.sections`)
 * rather than a rewritten prompt string: Pi diffs the sections against what the
 * model already has and patches only the changed ones, so the cached prefix of
 * the rest of the prompt survives.
 *
 * The skill lives at ~/.pi/agent/skills/pi-docs/ so Pi's own skill discovery
 * picks it up (progressive disclosure: name + description always in context,
 * the full block loaded on demand via read). The body is extracted from the
 * live system prompt, so it can never drift from what Pi would have told the
 * model.
 *
 * Ownership is tracked via a frontmatter marker: a file that exists without
 * the marker is user-authored and is left untouched.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Module } from "./skeleton.js";

export const PI_DOCS_SKILL_NAME = "pi-docs";
export const PI_DOCS_MARKER = "source: decorated-pi";
export const PI_DOCS_DESCRIPTION =
  "Use when the user asks about pi itself, its SDK, extensions, or themes.";

/** Section key Pi uses for its own documentation block. */
export const PI_DOCS_SECTION = "docs";

/** Section key carrying the decorated-pi guidelines. */
export const GUIDANCE_SECTION = "decorated_pi_guidance";

/** Heading of the guidelines block. Only needed on the forced-prompt path,
 *  where the guidance is appended to a string instead of a section. */
export const GUIDELINES_MARKER = "## Decorated Pi Guidance";

/** Stand-in for Pi's documentation block; the full text is the pi-docs skill
 *  body, loaded on demand. */
export const PI_DOCS_POINTER =
  "Full Pi documentation (README, docs/, examples/) is in the `pi-docs` skill — read it when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI.";

/** Placeholder body used until the first agent turn replaces it with the
 *  real rendered block. It is never visible to the model: before_agent_start
 *  runs before any LLM inference. */
const PI_DOCS_PLACEHOLDER_BODY =
  "Placeholder — the full Pi documentation block is written on the first agent turn.\n";

function piDocsSkillDir(agentDir: string): string {
  return join(agentDir, "skills", PI_DOCS_SKILL_NAME);
}

function piDocsSkillFile(agentDir: string): string {
  return join(piDocsSkillDir(agentDir), "SKILL.md");
}

/** Remove the injected Pi documentation block from the base system prompt.
 *  Matches a line containing "Pi documentation" and deletes it plus all
 *  following non-empty lines, stopping at the first blank line.
 *  Returns the stripped prompt together with the removed block (trimmed),
 *  so callers can reuse the exact text Pi rendered for this install. */
export function stripPiDocsBlock(prompt: string): {
  prompt: string;
  block: string | undefined;
} {
  const lines = prompt.split("\n");
  const out: string[] = [];
  const removed: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.includes("Pi documentation")) {
      removed.push(line);
      i++;
      while (i < lines.length && lines[i].trim() !== "") {
        removed.push(lines[i]);
        i++;
      }
      // Drop the terminating blank line as well so we don't leave orphan whitespace.
      if (i < lines.length && lines[i].trim() === "") i++;
      continue;
    }
    out.push(line);
    i++;
  }
  const block = removed.length > 0 ? removed.join("\n").trim() : undefined;
  return { prompt: out.join("\n"), block };
}

/** Replace Pi's docs block with the pointer and add the guidelines as their
 *  own section. Mutating `systemPromptOptions` (instead of returning a rewritten
 *  `systemPrompt`) is what keeps the transcript's structured sections intact:
 *  Pi diffs them and patches only what changed, so the rest of the prompt keeps
 *  its cached prefix. Requires Pi 0.86+, where option mutations are rendered. */
export function applyStructuredPrompt(
  options: {
    customPrompt?: string;
    sections: Record<string, string>;
  },
  guidelines: string,
): void {
  // A custom prompt replaces the default prefix, docs block included; adding a
  // docs section there would document a surface the user opted out of.
  if (!options.customPrompt) {
    options.sections[PI_DOCS_SECTION] = PI_DOCS_POINTER;
  }
  options.sections[GUIDANCE_SECTION] = guidelines;
}

/** The YAML frontmatter for the generated skill (no trailing newline). */
export function buildPiDocsFrontmatter(): string {
  return [
    "---",
    `name: ${PI_DOCS_SKILL_NAME}`,
    `description: ${PI_DOCS_DESCRIPTION}`,
    "metadata:",
    `  ${PI_DOCS_MARKER}`,
    "---",
  ].join("\n");
}

/** Split a SKILL.md file into frontmatter block and body, or undefined when
 *  the file has no `---` frontmatter. */
export function splitSkillFile(
  content: string,
): { frontmatter: string; body: string } | undefined {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return undefined;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return undefined;
  return {
    frontmatter: lines.slice(0, end + 1).join("\n"),
    body: lines.slice(end + 1).join("\n").replace(/^\n+/, "").replace(/\n+$/, ""),
  };
}

function tryReadFile(file: string): string | undefined {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

/** Discovery stage (resources_discover): make sure a pi-docs SKILL.md exists
 *  with our frontmatter so this session's skill scan picks up the entry.
 *  Only the entry layer is managed here (file existence + frontmatter); the
 *  body is managed on the first agent turn.
 *  Returns the skillPaths to re-scan when the file was created or its
 *  frontmatter changed; empty otherwise. User-authored files (no marker) are
 *  never touched. */
export function ensureSkillFrontmatter(
  agentDir: string,
): { skillPaths?: string[] } {
  const file = piDocsSkillFile(agentDir);
  const existing = tryReadFile(file);

  if (existing === undefined) {
    mkdirSync(piDocsSkillDir(agentDir), { recursive: true });
    writeFileSync(
      file,
      `${buildPiDocsFrontmatter()}\n\n${PI_DOCS_PLACEHOLDER_BODY}`,
      "utf-8",
    );
    return { skillPaths: [join(agentDir, "skills")] };
  }

  if (!existing.includes(PI_DOCS_MARKER)) {
    // User-authored skill — leave it alone.
    return {};
  }

  const split = splitSkillFile(existing);
  const expected = buildPiDocsFrontmatter();
  if (split && split.frontmatter === expected) {
    // Entry layer already up to date; the initial scan covers the file.
    return {};
  }
  const body = split && split.body.length > 0 ? split.body : PI_DOCS_PLACEHOLDER_BODY;
  writeFileSync(file, `${expected}\n\n${body}`, "utf-8");
  return { skillPaths: [join(agentDir, "skills")] };
}

/** Content stage (before_agent_start): sync the skill body with the exact
 *  "Pi documentation" block Pi rendered for this install. Returns true when
 *  the file was written. User-authored files (no marker) are untouched. */
export function updateSkillBody(agentDir: string, block: string): boolean {
  const file = piDocsSkillFile(agentDir);
  const existing = tryReadFile(file);

  if (existing === undefined) {
    mkdirSync(piDocsSkillDir(agentDir), { recursive: true });
    writeFileSync(file, `${buildPiDocsFrontmatter()}\n\n${block}\n`, "utf-8");
    return true;
  }
  if (!existing.includes(PI_DOCS_MARKER)) {
    return false; // user-authored
  }
  const split = splitSkillFile(existing);
  if (split && split.body.trim() === block.trim()) {
    return false; // already in sync
  }
  writeFileSync(file, `${buildPiDocsFrontmatter()}\n\n${block}\n`, "utf-8");
  return true;
}

/** Build the pi-docs hook module.
 *
 *  `guidelines` is the fully joined system-prompt guideline text injected as
 *  the `decorated_pi_guidance` section on every turn; index.ts owns the prompt
 *  wording and hands it in here.
 *  `agentDir` defaults to pi's agent directory and is injectable for tests. */
export function createPiDocsModule(guidelines: string, agentDir = getAgentDir()): Module {
  return {
    name: "pi-docs",
    hooks: {
      resources_discover: [
        () => {
          const { skillPaths } = ensureSkillFrontmatter(agentDir);
          return skillPaths ? { skillPaths } : undefined;
        },
      ],
      before_agent_start: [
        (event) => {
          // The block is read off the prompt Pi rendered for this install, so
          // the skill body can never drift from what Pi would have told the model.
          const { prompt: stripped, block } = stripPiDocsBlock(event.systemPrompt ?? "");
          if (block) updateSkillBody(agentDir, block);

          const options = event.systemPromptOptions;
          if (!options) return undefined;

          // An earlier handler forced a whole prompt. Pi sends that text as the
          // request's head system message and drops every section patch, so the
          // guidance has to ride along inside the forced string.
          if (options.forceSystemPrompt !== undefined) {
            if (stripped.includes(GUIDELINES_MARKER)) return undefined;
            return { systemPrompt: `${stripped}\n\n${guidelines}` };
          }

          applyStructuredPrompt(options, guidelines);
          return undefined;
        },
      ],
    },
  };
}
