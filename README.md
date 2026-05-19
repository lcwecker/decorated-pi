# decorated-pi

`decorated-pi` is a Pi extension that adds safety gates, LSP tools, image/compaction model helpers, smarter `@` file search, dynamic subdirectory `AGENTS.md` loading, and a few workflow quality-of-life improvements.

## Install

```bash
pi install npm:decorated-pi
pi install git:github.com/lcwecker/decorated-pi
pi install /path/to/decorated-pi
```

## Features

### 1. Patch Tool

Replaces Pi's built-in `edit` / `write` with a stronger `patch` tool:

- **anchor mechanism** — narrows the search range by specifying a unique string that appears before `old_str`, preventing mismatches in files with repeated patterns
- **mtime tracking** — records file modification time on `read`, rejects `patch` if the file changed since last read, preventing blind or stale edits
- **explicit overwrite** — offer atomic `overwrite: true` mode for overwrite files or full-file creation to prevent unintened overwrite

### 2. Smart `@` File Search

Replaces Pi's default file search with a faster, project-aware search strategy:

- Uses project-aware file discovery
- Prioritizes filename-based matches for more intuitive results
- Reduces clutter from hidden, cache, and build directories
- Keeps default suggestions focused on visible project files

### 3. LSP Tool Suite

Based on [@spences10/pi-lsp](https://github.com/spences10/my-pi/tree/main/packages/pi-lsp) by Scott Spence (MIT License), with major additions:

- C/C++ and Lua support
- `lsp_find_symbol`, `lsp_rename`, multi-file support merged into `lsp_diagnostics`
- Force-sync on `didChange` (no stale diagnostics)

Supported languages: c/cpp, go, java, lua, python, ruby, rust, svelte, typescript

### 4. Auxiliary Models (Image + Compact)

Uses cheaper models for auxiliary tasks, configured via `/dp-model`:

- **Image read fallback** — when the model reads an image file, detects type via magic bytes, calls a configured vision-capable model, and replaces the read result with image analysis text (jpeg, png, gif, webp)
- **Compact model** — uses a configured model for context compaction (instead of the main model), auto-resumes after compaction.

### 5. Safety Layer

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

### 6. Dynamic Subdirectory `AGENTS.md` / `CLAUDE.md`

When the agent reads or edits a file:

- discovers `AGENTS.md` / `CLAUDE.md` in the file's directory and ancestor directories
- injects newly discovered guidance into tool results

### 7. Extend Providers

Extend providers are registered via `/login` → "Use a subscription":

| Provider | Base URL |
| ---------- | ----------- |
| Ollama Cloud | `ollama.com/v1` |
| Baidu Qianfan | `qianfan.baidubce.com/v2/coding` |
| ARK Coding | `ark.cn-beijing.volces.com/api/coding/v3` |

## Configuration

Runtime settings are stored in:

```text
~/.pi/agent/decorated-pi.json
```

### Module Loading

Modules can be toggled on/off. Changes take effect after `/reload`.

| Module | Default | Effect when disabled |
| -------- | --------- | --------------------- |
| `patch` | `true` | Reverts to Pi's built-in `edit` / `write` tools |
| `safety` | `true` | No command guard, no protected path check, no secret redaction |
| `lsp` | `true` | All `lsp_*` tools unregistered — no diagnostics, hover, etc. |
| `smart-at` | `true` | Fallback to Pi's built-in `@` file completion |

Use `/dp-settings` to toggle, or edit the config file directly:

```json
{
  "modules": {
    "patch": true,
    "safety": true,
    "lsp": false,
    "smart-at": true
  }
}
```

## License

MIT
