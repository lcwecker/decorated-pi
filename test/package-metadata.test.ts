/**
 * Package metadata invariants — the declared Pi version floor.
 *
 * The system-prompt injection mutates `systemPromptOptions`, which only Pi
 * 0.86+ renders, so two statements have to stay in step:
 *  - the peer floor users are told they need,
 *  - the devDependency range CI actually tests against.
 *
 * A dev range below the peer floor means CI verifies an older Pi than the
 * extension claims to support: the extension can then depend on newer Pi
 * behaviour without any test noticing, which is exactly how the 0.86
 * `systemPromptOptions` requirement went unnoticed while peer and dev both
 * read `0.84.4`.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const PI_PACKAGES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

/** Hard minimum: `systemPromptOptions.sections` mutations only render here. */
const REQUIRED_FLOOR = "0.86.0";

const repoRoot = path.join(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));

/** Lowest version a range can resolve to, for the range forms this repo uses. */
function floorTuple(range: string): [number, number, number] {
  const match = /^(?:\^|~|>=)?\s*(\d+)\.(\d+)\.(\d+)/.exec(range.trim());
  if (!match) throw new Error(`unsupported version range: ${range}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(left: [number, number, number], right: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

describe("package metadata — Pi version floor", () => {
  it("declares a peer floor at or above the Pi behaviour the extension needs", () => {
    for (const name of PI_PACKAGES) {
      const range = pkg.peerDependencies?.[name];
      expect(range, `${name} peer range is declared`).toBeDefined();
      expect(
        compare(floorTuple(range), floorTuple(REQUIRED_FLOOR)),
        `${name} peer floor ${range} satisfies >= ${REQUIRED_FLOOR}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it("tests against a Pi at least as new as the declared peer floor", () => {
    for (const name of PI_PACKAGES) {
      const range = pkg.devDependencies?.[name];
      expect(range, `${name} dev range is declared`).toBeDefined();
      expect(
        compare(floorTuple(range), floorTuple(pkg.peerDependencies[name])),
        `${name} dev floor ${range} satisfies peer floor ${pkg.peerDependencies[name]}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });
});
