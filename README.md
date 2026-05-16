# decorated-pi

`decorated-pi` is a Pi extension that adds safety gates, LSP tools, image/compaction model helpers, smarter `@` file search, dynamic subdirectory `AGENTS.md` loading, and a few workflow quality-of-life improvements.

## Features

### 1. Safety Layer

- **Dangerous bash guard**
  - asks for confirmation on destructive commands such as:
    - `rm`
    - `sudo`
    - `svn commit/revert`
    - `git reset/restore/clean/push/revert`
    - `npm publish`
    - `>` / `1>` / `2>` / `&>` / `tee` overwrite existing files
  - Hints the agent to use `edit` instead of `write` on non-empty files
- **Protected paths**
  - Blocks read/write access (via `write`/`edit`/`read` tools or `cat`/`head`/`tail`/`grep`/`rg` etc. bash commands) to sensitive locations such as `.env`, `.git/`, `.ssh/`, `*.pem`, `*.key`, etc.
- **Secret redaction**
  - Dual-layer detection: 40+ known-format patterns (AWS, GitHub, OpenAI, etc.) + Adjusted Shannon Entropy analysis for unknown formats. Based on [opencode-secrets-protect](https://github.com/jscheel/opencode-secrets-protect) (MIT)

### 2. Smart `@` File Search

Replaces Pi's default file search with a faster project-aware search strategy:

- Uses `git ls-files` in git repos
- Falls back to `fd` outside git repos
- Caches results for 10 seconds
- Scores primarily on **filename match quality**, not full-path fuzziness
- Penalizes hidden/cache/build directories
- Hides hidden paths from empty-query results

### 3. LSP Tool Suite

Based on [@spences10/pi-lsp](https://github.com/spences10/my-pi/tree/main/packages/pi-lsp) by Scott Spence (MIT License), with additions:

- C/C++ (clangd) and Lua support
- `lsp_find_symbol`, `lsp_rename`, multi-file support merged into `lsp_diagnostics`
- Force-sync on `didChange` (no stale diagnostics)

Registered tools:

- `lsp_diagnostics`
- `lsp_find_symbol`
- `lsp_hover`
- `lsp_definition`
- `lsp_references`
- `lsp_document_symbols`
- `lsp_rename`

Supported languages:

- c/cpp
- go
- java
- lua
- python
- ruby
- rust
- svelte
- typescript

### 4. Auxiliary Models (Image + Compact)

Uses cheaper models for auxiliary tasks, configured via `/extend-model`:

- **Image read fallback** — when the model reads an image file, detects type via magic bytes, calls a configured vision-capable model, and replaces the read result with image analysis text (jpeg, png, gif, webp)
- **Compact model** — uses a configured model for context compaction (instead of the main model), auto-resumes after compaction.

### 5. Dynamic Subdirectory `AGENTS.md` / `CLAUDE.md`

When the agent reads or edits a file:

- discovers `AGENTS.md` / `CLAUDE.md` in the file's directory and ancestor directories
- injects newly discovered guidance into tool results
- persists discovered files into the session so they are restored on resume

### 6. Extend Providers

Extend providers are registered via `/login` → "Use a subscription":

| Provider | Base URL |
| ---------- | ----------- |
| Ollama Cloud | `ollama.com/v1` |
| Baidu Qianfan | `qianfan.baidubce.com/v2/coding` |
| ARK Coding | `ark.cn-beijing.volces.com/api/coding/v3` |

## Install

```bash
pi install /path/to/decorated-pi #local
pi install npm:decorated-pi #npm
pi install git:github.com/lcwecker/decorated-pi #github
```

Then reload Pi

## Configuration

Runtime settings are stored in:

```text
~/.pi/agent/decorated-pi.json
```

## License

MIT
