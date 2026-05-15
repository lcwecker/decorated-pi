# decorated-pi

`decorated-pi` is a Pi extension bundle that adds safety gates, LSP tools, image/compaction model helpers, smarter `@` file completion, dynamic subdirectory `AGENTS.md` loading, and a few workflow quality-of-life improvements.

## Status

Current scope is **functionally complete for local use**.

Recent audit highlights:
- Fixed stale LSP diagnostics caused by returning cached diagnostics after `didChange`
- Fixed `subdir-agents` path capture on `tool_call`
- Fixed a `smart-at` multi-token search bug
- Updated safety checks so shell overwrite attempts on existing files are treated as dangerous

## Features

### 1. Decorated Pi Guidance
Adds global system-prompt guidance via `before_agent_start.systemPrompt`:
- Restate understanding before acting
- Break medium/large tasks into discrete steps

### 2. Safety Layer
Implemented in `extensions/safety.ts`.

- **Dangerous bash guard**
  - Blocks or asks for confirmation on destructive commands such as:
    - `rm`
    - `sudo`
    - `svn commit`
    - `svn revert`
    - `git reset`
    - `git restore`
    - `git clean`
    - `git push`
    - `git revert`
- **Shell overwrite detection**
  - Detects `bash` commands that would overwrite an **existing regular file**, including:
    - `>` / `>>`
    - `1>` / `1>>`
    - `2>` / `2>>`
    - `&>` / `&>>`
    - `tee`
  - Aggregates **all** dangerous reasons found in one command
- **Protected paths**
  - Blocks `write` / `edit` to sensitive locations such as `.env`, `.git/`, `.ssh/`, `node_modules/`, `*.pem`, `*.key`, etc.
- **Write guard**
  - Blocks the `write` tool when it would overwrite a non-empty file
  - Instructs the model to use `edit` instead
- **Secret redaction**
  - Uses `secretlint` rules to redact secrets from tool output before they are fed back into context

### 3. Smart `@` Completion
Implemented in `extensions/smart-at.ts`.

Replaces Pi's default file autocomplete behavior with a faster project-aware search strategy:
- Uses `git ls-files` in git repos
- Falls back to `fd` outside git repos
- Caches results for 10 seconds
- Scores primarily on **filename match quality**, not full-path fuzziness
- Penalizes hidden/cache/build directories
- Hides hidden paths from empty-query results
- Keeps Pi's original `applyCompletion` / `shouldTriggerFileCompletion` binding behavior intact

### 4. LSP Tool Suite
Implemented in `extensions/lsp/`.

Registered tools:
- `lsp_diagnostics`
- `lsp_find_symbol`
- `lsp_hover`
- `lsp_definition`
- `lsp_references`
- `lsp_document_symbols`
- `lsp_rename`

Supported languages:
- c
- cpp
- go
- java
- lua
- python
- ruby
- rust
- svelte
- typescript

LSP integration includes:
- prompt snippets for `Available tools`
- tool-specific prompt guidelines
- parameter descriptions for the JSON schema
- trust checks for project-local LSP binaries
- an LSP-specific system-prompt section injected only when LSP tools are active

### 5. Image Read Fallback
Implemented in `extensions/extend-model.ts`.

When the model reads an image file and an image model is configured:
- Detects supported image types via magic bytes
- Calls a configured vision-capable model
- Replaces the read result with image analysis text

Supported image types:
- jpeg
- png
- gif
- webp

### 6. Custom Compact Model + Auto Resume
Also implemented in `extensions/extend-model.ts`.

- Supports a configured **compact model** through `session_before_compact`
- Preserves auto-resume behavior through `session_compact`
- Appends read/modified file summaries to compaction output

### 7. `/extend-model`
Implemented in `extensions/slash.ts`.

Interactive command for configuring:
- image model
- compact model

### 8. `/retry`
Implemented in `extensions/slash.ts`.

Allows continuing after interruption by:
- aborting the current run if needed
- sending a hidden continuation trigger
- injecting a one-turn retry note into the system prompt

### 9. Dynamic Subdirectory `AGENTS.md` / `CLAUDE.md`
Implemented in `extensions/subdir-agents.ts`.

When the agent reads or edits a file:
- discovers `AGENTS.md` / `CLAUDE.md` in the file's directory and ancestor directories
- injects newly discovered guidance into tool results
- persists discovered files into the session so they are restored on resume

### 10. Automatic Session Title
Implemented in `extensions/session-title.ts`.

- Derives the session name from the first user message
- Avoids overriding a manually assigned session name

## Install

### Local install

```bash
pi install /path/to/decorated-pi
```

Then reload Pi:

```bash
/reload
```

### npm publish
Not published yet.

## Configuration

Runtime settings are stored in:

```text
~/.pi/agent/extensions/decorated-pi.json
```

Current keys:
- `imageModelKey`
- `compactModelKey`

Design rule:
- **only** `extensions/settings.ts` writes this file
- all other modules read through exported getters/setters

## Architecture

Entry point:
- `extensions/index.ts`

Main modules:
- `extensions/guidance.ts` — global system prompt guidance
- `extensions/safety.ts` — command guard, protected paths, write guard, secret redaction
- `extensions/smart-at.ts` — smart `@` autocomplete
- `extensions/extend-model.ts` — image fallback, compact model, auto-resume
- `extensions/slash.ts` — `/extend-model`, `/retry`
- `extensions/subdir-agents.ts` — dynamic `AGENTS.md` / `CLAUDE.md`
- `extensions/session-title.ts` — session naming
- `extensions/lsp/*` — LSP client, server manager, prompt wiring, tools
- `extensions/settings.ts` — config I/O

## Current Limitations

- `write` protection applies to the **LLM's `write` tool**; agent attempts to overwrite files via `bash` are handled separately by the dangerous-command gate
- shell overwrite detection only escalates when the target resolves to an **existing regular file**
- compact behavior still relies on Pi's normal compaction flow; this extension customizes the model and post-compact continuation, not the global compaction threshold UI
- npm distribution is not set up yet
- there is no dedicated automated test suite yet; current validation is based on Pi runtime checks, LSP diagnostics, and manual smoke tests

## Development Notes

Helpful checks during development:

```bash
pi install /path/to/decorated-pi
/reload
```

For focused validation, use:
- `lsp_diagnostics` on edited source files
- real `pi "..."` smoke tests for safety behavior
- manual autocomplete checks for `smart-at`

## License

MIT
