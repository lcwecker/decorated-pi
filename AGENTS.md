# decorated-pi — pi extension

## Architecture

### Three top-level categories

```
decorated-pi/
├── AGENTS.md
├── package.json
├── index.ts                 # entry point: registers tools, commands, hooks, guidelines
├── settings.ts              # ~/.pi/agent/decorated-pi.json read/write
├── tools/                   # LLM-callable tools
├── hooks/                   # agent-loop event handlers
├── commands/                # slash commands
├── ui/                      # TUI components used by commands
├── utils/                   # shared helpers
└── test/                    # vitest specs
```

| Category | Role | Knows about |
|----------|------|-------------|
| `tools/` | Endpoints the LLM calls | other modules via import only |
| `hooks/` | Reacts to agent-loop events | primitives, other hooks via skeleton |
| `commands/` | User-typed `/...` commands | `settings.ts`, and its own hook module when it needs agent-loop state |
| `ui/` | TUI components the commands render | pi-tui, `settings.ts` |
| `utils/` | Shared helpers | nothing internal |

**Hard rules**:
- A tool never registers a hook (no `pi.on(...)` in `tools/*.ts`). Session lifecycle for a tool is owned by a hook module that receives the tool's runtime object (see `hooks/lsp.ts`).
- A hook does not care whether the triggering tool was registered by us or by pi core.
- A command does not participate in the agent loop. When it needs agent-loop state (e.g. `/retry`'s in-flight flag), the state object is created by the command module and the reset lives in a hook module (see `hooks/retry.ts`).
- The skeleton (`hooks/skeleton.ts`) is the only place that calls `pi.on(...)`.

### Skeleton — `hooks/skeleton.ts`

```
       pi core
          │
          │  events
          ▼
   ┌──────────────┐
   │   skeleton   │  ← only place that calls pi.on(...)
   │              │
   │  · collect   │
   │  · order     │
   │  · dispatch  │
   │  · owns:     │
   │    - deps    │
   │    - prompt  │
   └──────┬───────┘
          │
          ▼
   registered hooks
```

**Rules**:
- Registration order = execution order.
- Four handler modes:
  - **parallel** — return values ignored. Lifecycle events: `session_start`, `session_shutdown`, `session_compact`, `agent_start`, `agent_end`, `input`.
  - **compose** — the next handler receives the previous return value. Transformation chains: `before_agent_start` mutates `systemPrompt`, `tool_call` mutates `input.command`, `tool_result` mutates `content`, plus `context` and `message_end`.
  - **result** — every handler sees the original event, the last non-undefined return wins. `session_before_compact`.
  - **collect** — the array fields (`skillPaths`, `promptPaths`, `themePaths`) of every handler's result are concatenated. `resources_discover`, mirroring how pi core accumulates those paths across all extensions.
- The system prompt is assembled by the `pi-docs` module (`hooks/pi-docs.ts`): it moves Pi's documentation block into the builtin skill body, then writes a pointer and the guidelines as `systemPromptOptions.sections` entries so Pi diffs sections instead of re-sending a rewritten prompt. It registers first so it runs before every other `before_agent_start` handler. Requires Pi 0.86+, where option mutations are rendered.

### `dp-settings`

The only shared state is `settings.ts`. Commands write; `index.ts` reads on `/reload` to decide which tools to register. Neither side imports the other.

### Adding a new feature

**New tool**:
1. `tools/<name>.ts` exporting `register<Name>Tool(pi)`.
2. In `index.ts`: `if (isModuleEnabled("<name>")) register<Name>Tool(pi);`
3. *(Optional)* In `commands/dp-settings.ts`: add the module label so users can toggle it via `/dp-settings`. Without this the tool is always on; users would have to edit `settings.json` directly to disable.

If the tool has its own state, protocol client, or dynamic sub-tools, organize it as a directory instead of a single file: `tools/<name>/{client,manager,...}.ts` plus `tools/<name>/index.ts` exporting `register<Name>Tools(pi)`. See `tools/mcp/` and `tools/lsp/` for examples.

When a single tool file grows past ~1000 lines because one algorithm is doing several jobs, split it by concern with `core.ts` as the public API plus re-exports, and keep the siblings acyclic. See `tools/patch/` (`core` = apply + preview + re-exports, siblings = `types` / `lines` / `locate` / `diagnostics` / `diff`); `test/patch-modules.test.ts` pins that layering.

**New hook**:
1. `hooks/<name>.ts` exporting `<name>Module` (or `create<Name>Module(deps)` when the hook needs a runtime object) and optionally `setup<X>(sk)`.
2. In `index.ts`: `sk.register(...)` in the right slot (order = execution order).
3. Inside the setup, call `sk.declareMissing({...})` for a missing binary dependency.

**New command**:
1. `commands/<name>.ts` exporting `register<Name>Command(pi)`.
2. In `index.ts`: call `register<Name>Command(pi)`.
3. If the command needs agent-loop state, derive it from a shared object it returns and register the resetting hook module with `sk.register(...)`.

## Test

```bash
npm test
```

Organization rules:

- Tests mirror the source layout one-to-one: `extensions/<area>/<name>.ts` → `test/<name>.test.ts`.
- All spec files live flat in `test/` (no nested folders). For a tool that is a directory (e.g. `tools/mcp/`), the spec is `test/mcp.test.ts` covering the whole module.
- Sub-features of the same module may get their own file: `test/mcp-externalize.test.ts` for a specific concern of MCP, `test/patch.test.ts` for the patch tool.
- Every new feature or bug fix ships with a test — run `npm test` before considering the change done.
- The suite must never read or write the developer's real `~/.pi/agent`:
  - `test/setup-agent-dir.ts` (vitest `setupFiles`) points `PI_CODING_AGENT_DIR` at a fresh temp directory per spec file. That also lets spec files run in parallel.
  - Specs build agent-dir paths with `agentDir()` / `agentDirFile()` from `test/agent-dir.ts` instead of `os.homedir()`.
  - Because the agent dir is throwaway, specs need no `backupConfig` / `restoreConfig` around it.
  - Anything that would reach the network on a cold cache (e.g. the URL-based builtin MCP servers) must be disabled in the spec's `mcp.json`.

## Release

Publishing is a CI pipeline: `.github/workflows/release.yml` creates the tag and publishes to npm. The local repo contributes the version bump and nothing else.

**Release steps** — this is the whole local procedure. `package.json` is the source of truth for the version: it lives in the `version` field, and `package-lock.json` mirrors it. No other file carries it.

1. Bump the version in `package.json`:

   ```bash
   npm version 0.9.5 --no-git-tag-version   # rewrites package.json + package-lock.json
   ```

   Editing `version` by hand works too; then sync the lockfile with `npm install --package-lock-only`.
   `--no-git-tag-version` keeps the tag out of the local repo — CI creates it.

2. Run the same gate CI will run:

   ```bash
   npm run typecheck && npm test
   ```

3. Commit. The subject carries the version and acts as the trigger — it must match the field from step 1, in the strict form `chore(release): vX.Y.Z` (a prerelease suffix such as `-rc.1` fails validation):

   ```bash
   git add package.json package-lock.json
   git commit -m "chore(release): v0.9.5"
   ```

4. Push to `main`, then watch with `gh run watch` or the Actions tab:

   ```bash
   git push origin main
   ```

A push to `main` runs `.github/workflows/ci.yml`; when the head commit's subject starts with `chore(release):`, the release job runs too. Both workflow files are short — read them for the step sequence and the skip rules. A failed release is retried with `gh run rerun <run-id>`: the commit is already on `main`, so pushing again produces no event.

**Outside the repo** (a failure here surfaces as `ENEEDAUTH` in the publish step):

- 2FA enabled on the npm account — npm requires it for publishing.
- The npm trusted publisher on `decorated-pi`: owner `lcwecker`, repository `decorated-pi`, workflow filename `release.yml`.

**Never**: put a token in the publish step (`NODE_AUTH_TOKEN` set to anything, empty included, disables the OIDC fallback), or push the release tag by hand.

**Release notes** are filled in after the workflow creates the release, with `gh release edit vX.Y.Z --notes-file <file>`: follow the `## What changed` shape of earlier releases and name the issue a change closes. Installation stays in the README, so the notes leave it out.
