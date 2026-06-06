# decorated-pi — pi extension

## Architecture

### Three top-level categories

```
decorated-pi/
├── AGENTS.md
├── package.json
├── settings.ts              # ~/.pi/agent/decorated-pi.json read/write
├── tools/                   # LLM-callable tools
├── hooks/                   # agent-loop event handlers
├── commands/                # slash commands
├── providers/               # LLM providers
└── test/                    # vitest specs
```

| Category | Role | Knows about |
|----------|------|-------------|
| `tools/` | Endpoints the LLM calls | other modules via import only |
| `hooks/` | Reacts to agent-loop events | primitives, other hooks via skeleton |
| `commands/` | User-typed `/...` commands | `settings.ts` only |

**Hard rules**:
- A tool never registers a hook (no `pi.on(...)` in `tools/*.ts`).
- A hook does not care whether the triggering tool was registered by us or by pi core.
- A command does not participate in the agent loop. Its only shared state with tools is `settings.ts`.
- The skeleton (`hooks/skeleton.ts`) is the only place that calls `pi.on(...)` for hooks.

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
- Two handler modes: **parallel** (return values ignored) for lifecycle events; **compose** (next handler sees previous return) for transformation chains (`before_agent_start` mutates `systemPrompt`, `tool_call` mutates `input.command`, `tool_result` mutates `content`).
- The skeleton also owns dependency checking and system-prompt guideline injection — hooks declare them, skeleton enforces them at the right event.

### `dp-settings`

The only shared state is `settings.ts`. Commands write; `index.ts` reads on `/reload` to decide which tools to register. Neither side imports the other.

### Adding a new feature

**New tool**:
1. `tools/<name>.ts` exporting `register<Name>Tool(pi)`.
2. In `index.ts`: `if (isModuleEnabled("<name>")) register<Name>Tool(pi);`
3. *(Optional)* In `commands/dp-settings.ts`: add the module label so users can toggle it via `/dp-settings`. Without this the tool is always on; users would have to edit `settings.json` directly to disable.

If the tool has its own state, protocol client, or dynamic sub-tools, organize it as a directory instead of a single file: `tools/<name>/{client,manager,...}.ts` plus `tools/<name>/index.ts` exporting `register<Name>Tools(pi)`. See `tools/mcp/` and `tools/lsp/` for examples.

**New hook**:
1. `hooks/<name>.ts` exporting `<name>Module` and optionally `setup<X>(sk)`.
2. In `hooks/index.ts`: export the setup wrapper.
3. In `index.ts`: call `setup<X>(sk)` in the right slot (order = execution order).
4. Inside the setup, call `sk.declareDependency` / `sk.declareGuideline` if needed.

**New command**:
1. `commands/<name>.ts` exporting `register<Name>Command(pi)`.
2. In `index.ts`: call `register<Name>Command(pi)`.

## Test

```bash
npm test
```

Organization rules:

- Tests mirror the source layout one-to-one: `extensions/<area>/<name>.ts` → `test/<name>.test.ts`.
- All spec files live flat in `test/` (no nested folders). For a tool that is a directory (e.g. `tools/mcp/`), the spec is `test/mcp.test.ts` covering the whole module.
- Sub-features of the same module may get their own file: `test/mcp-externalize.test.ts` for a specific concern of MCP, `test/patch.test.ts` for the patch tool.
- Every new feature or bug fix ships with a test — run `npm test` before considering the change done.
