# decorated-pi

`decorated-pi` is a practical enhancement pack for [Pi](https://github.com/earendil-works/pi).

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

### 2. Secret redaction

Three-layer detection: high-confidence known-format patterns (AWS, GitHub, OpenAI, etc.), config-key regex matching, and adjusted Shannon entropy heuristics for unknown secret-like values.

### 3. Built-in MCP Client

Zero-config MCP client with two built-in servers:

| Server | Tool Prefix | Source |
| --- | --- | --- |
| Context7 | `context7_*` | `https://mcp.context7.com/mcp` |
| Exa | `exa_*` | `https://mcp.exa.ai/mcp` |

**Project-level config** — add custom MCP servers by placing an `mcp.json` or `.mcp.json` (also `.pi/mcp.json`, `.agents/mcp.json`, `.claude/mcp.json` and their `.`-prefixed variants) anywhere in your project tree. Servers found closer to `cwd` take precedence over ancestor directories.

```json
{
  "mcpServers": {
    "my-server": {
      "url": "https://my-mcp.example.com/mcp",
      "enabled": true
    }
  }
}
```

**Global config** — persist custom servers in `~/.pi/agent/decorated-pi.json`:

```json
{
  "mcpServers": {
    "my-server": { "url": "https://my-mcp.example.com/mcp" }
  }
}
```

**Priority**: project > global > builtin. A server with the same name from a higher-priority source overrides lower ones.

Use `/mcp` to view connection status and registered tools.

### 4. Auxiliary Models (Image + Compact)

Uses cheaper models for auxiliary tasks, configured via `/dp-model`:

- **Image read fallback** — when the model reads an image file, detects type via magic bytes, calls a configured vision-capable model, and replaces the read result with image analysis text (jpeg, png, gif, webp)
- **Compact model** — uses a configured model for context compaction (instead of the main model), auto-resumes after compaction.

### 5. Smart `@` File Search

Replaces Pi's default file search with a faster, project-aware search strategy:

- Uses project-aware file discovery
- Prioritizes filename-based matches for more intuitive results
- Reduces clutter from hidden, cache, and build directories
- Keeps default suggestions focused on visible project files

### 6. LSP Tool Suite

A cleaned-up, minimal LSP toolset. The extension keeps only the two LSP tools that cover the most practical coding workflows: checking diagnostics after edits and inspecting file structure before focused changes.

- **`lsp_diagnostics`** — file diagnostics with severity filtering
- **`lsp_document_symbols`** — file symbol outline

Supported languages: c/cpp, go, java, lua, json, python, ruby, rust, svelte, typescript

### 7. Dynamic Subdirectory `AGENTS.md` / `CLAUDE.md`

When the agent reads or edits a file:

- discovers `AGENTS.md` / `CLAUDE.md` in the file's directory and ancestor directories
- injects newly discovered guidance into tool results

### 8. Extend Providers

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
| `safety` | `true` | No secret redaction on `read` / `bash` output |
| `lsp` | `true` | All `lsp_*` tools unregistered — no diagnostics, hover, etc. |
| `smart-at` | `true` | Fallback to Pi's built-in `@` file completion |
| `mcp` | `true` | All `{server}_*` MCP tools unregistered |

Use `/dp-settings` to toggle, or edit the config file directly:

```json
{
  "modules": {
    "patch": true,
    "safety": true,
    "lsp": false,
    "smart-at": true,
    "mcp": true
  }
}
```

## License

MIT
