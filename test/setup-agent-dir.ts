/**
 * Per-spec agent-dir isolation.
 *
 * Every module that resolves an agent-dir path does so through pi's
 * `getAgentDir()` — `settings.ts` (decorated-pi.json), `tools/mcp/config.ts`
 * (mcp.json), `tools/mcp/cache.ts` (mcp-cache.json), `commands/usage.ts`
 * (usage jsonl + sessions). `getAgentDir()` honours `PI_CODING_AGENT_DIR`, so
 * pointing that at a fresh temp directory keeps the suite off the user's real
 * `~/.pi/agent` state.
 *
 * Runs once per spec file (vitest `setupFiles`), which gives each file its own
 * directory and lets files run in parallel without sharing a config file.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll } from "vitest";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "decorated-pi-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

afterAll(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});
