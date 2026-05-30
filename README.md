# decorated-pi

`decorated-pi` is a practical enhancement pack for [Pi](https://github.com/earendil-works/pi) — smarter tools that are token efficient and cache friendly.

## Install

```bash
pi install npm:decorated-pi
pi install git:github.com/lcwecker/decorated-pi
pi install /path/to/decorated-pi
```

## Features

### 1. Patch Tool

Replaces Pi's built-in `edit` / `write` with a stronger `patch` tool that adds unique safety and usability improvements on top of the native tools.

| Capability | Pi native `edit` | `patch` |
| ------ | :---: | :---: |
| Exact string replacement | ✅ `oldText` | ✅ `old_str` |
| Atomic overwrite | ✅ `write` | ✅ `overwrite` |
| Syntax‑highlighted overwrite | ✅ streaming | ✅ incremental |
| **Anchor‑based search** | ❌ extending `oldText` for uniqueness | ✅ `anchor` bounds scope for precise matching |
| **Fuzzy whitespace match** | ❌ only reports "not found" | ✅ auto‑corrects tab↔space / trailing whitespace mismatches |
| **Edit fault diagnostics** | ❌ only reports "not found" | ✅ pinpoint faults for LLM comprehension |
| **Stale‑read protection** | ❌ Blind to external changes | ✅ `read` captures mtime, `patch` rejects stale targets |

### 2. Smarter `@` File Search

Replaces Pi's built-in `@` file completion with smarter matching and noise filtering:

| Aspect | Pi native `@` | `decorated-pi` |
| ------ | :---: | :---: |
| **Speed** | ❌ re‑scans filesystem on every trigger | ✅ caches once per `@` trigger |
| **Noise filtering** | ❌ no penalty system, shows hidden files | ✅ tiered penalty auto‑filters clutter |
| **Default suggestions** | ❌ all files visible on empty query | ✅ only visible project files |
| **Match precision** | ❌ case‑insensitive simple scoring | ✅ multi‑level case‑sensitive scoring |

### 3. Secret redaction

Three-layer detection: high-confidence known-format patterns (AWS, GitHub, OpenAI, etc.), config-key regex matching, and adjusted Shannon entropy heuristics for unknown secret-like values.

Example redaction on a `read` / `bash` output:

```json
{
  "aws_access_key_id": "AKI**************PLE",
  "github_token": "ghp***************def",
  "database_password": "Sup#######t99",
  "api_key": "sk_**************f5a",
  "random_secret": "a1b??????5f5"
}
```

> `*` = known pattern, `#` = config key regex, `?` = entropy heuristic.

### 4. Auxiliary Models

Offloads auxiliary ops to cheaper models, reducing cost on every session. Configured via `/dp-model`:

- **Image read fallback** — when the model reads an image file, detects type via magic bytes, calls a configured vision-capable model, and replaces the read result with image analysis text (jpeg, png, gif, webp)
- **Compact model** — uses a configured model for context compaction (instead of the main model).

### 5. Progressive Context from `AGENTS.md` / `CLAUDE.md`

Extension capability: context is disclosed progressively as the agent works across different parts of the project.

- When reading or editing a file, discovers `AGENTS.md` / `CLAUDE.md` in that file's directory and ancestor directories
- Newly discovered guidance is injected into tool results, scoped to the current context

### 6. LSP Tool Suite

A cleaned-up, minimal LSP toolset. The extension keeps only the two LSP tools that cover the most practical coding workflows: checking diagnostics after edits and inspecting file structure before focused changes.

- **`lsp_diagnostics`** — file diagnostics with severity filtering
- **`lsp_document_symbols`** — file symbol outline

Supported languages: c/cpp, go, java, lua, json, python, ruby, rust, svelte, typescript

### 7. Built-in MCP Client

Zero-config MCP client with built-in servers:

| Server | Tool Prefix | Source |
| --- | --- | --- |
| Context7 | `context7_*` | `https://mcp.context7.com/mcp` |
| Exa | `exa_*` | `https://mcp.exa.ai/mcp` |

**Custom servers** in `.pi/agent/mcp.json` (project) or `~/.pi/agent/decorated-pi.json` (global). Project overrides global.
Tool prompts and schemas are cached locally so MCP tools are available immediately on startup, even before servers connect.

```json
{
  "mcpServers": {
    "my-server": {
      "url": "https://my-mcp.example.com/mcp",
      "enabled": true
    },
    "my-sse": {
      "url": "https://my-mcp.example.com/sse",
      "enabled": false
    },
    "my-stdio": {
      "command": "npx",
      "args": ["-y", "my-mcp-server"],
      "env": { "DEBUG": "1" }
    }
  }
}
```

Use `/mcp` to view connection status and registered tools.

### 8. Extend Providers

Extend providers are registered via `/login` → "Use a subscription":

| Provider | Base URL |
| ---------- | ----------- |
| Ollama Cloud | `ollama.com/v1` |
| Baidu Qianfan | `qianfan.baidubce.com/v2/coding` |
| ARK Coding | `ark.cn-beijing.volces.com/api/coding/v3` |

### 9. Other

- **RTK** — integrates [RTK](https://github.com/rtk-ai/rtk) for token-efficient command output.
- **WakaTime** — tracks coding activity via [WakaTime](https://wakatime.com).

## Configuration

Runtime settings are stored in:

```text
~/.pi/agent/decorated-pi.json
```

### Module Loading

Modules can be toggled on/off by `/dp-settings`. Changes take effect after `/reload`.

```json
{
  "modules": {
    "patch": true,
    "safety": true,
    "rtk": true,
    "lsp": true,
    "smart-at": true,
    "mcp": true,
    "wakatime": true
  }
}
```

## License

MIT
