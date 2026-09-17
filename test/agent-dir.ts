/**
 * Access to the per-spec agent directory installed by
 * `test/setup-agent-dir.ts` (registered in `vitest.config.ts` as a setup file).
 *
 * Specs that need to assert on or pre-seed agent-dir files should build their
 * paths from here rather than from `os.homedir()`, so a test run can never
 * read or write the developer's real `~/.pi/agent` state.
 */
import * as path from "node:path";

export function agentDir(): string {
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (!dir) {
    throw new Error(
      "PI_CODING_AGENT_DIR is not set — test/setup-agent-dir.ts must be listed in vitest.config.ts setupFiles.",
    );
  }
  return dir;
}

/** Path of `name` inside the isolated agent directory. */
export function agentDirFile(name: string): string {
  return path.join(agentDir(), name);
}
