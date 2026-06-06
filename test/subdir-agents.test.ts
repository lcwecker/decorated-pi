/**
 * Tests for subdir-agents state restoration across reload/compaction.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __subdirAgentsTest } from "../hooks/inject-agents-md.js";

const { restoreFromBranch, findNewAgents } = __subdirAgentsTest;

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
