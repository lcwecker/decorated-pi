# decorated-pi

`decorated-pi` is a practical enhancement pack for [Pi](https://github.com/earendil-works/pi) — token-efficient workflow, cache-friendly design, and smarter tools.

## Install

```bash
pi install npm:decorated-pi
pi install git:github.com/lcwecker/decorated-pi
pi install /path/to/decorated-pi
```

## Features

### 1. Token Efficiency

Multiple layers of token savings that compound across every session. **All integrated CLI tools only require installing their respective CLIs — zero config**.

**RTK** — integrates [RTK](https://github.com/rtk-ai/rtk) to compress bash output into structured summaries, so the LLM never sees raw noise.

**Codegraph** — integrates [codegraph](https://github.com/colbymchenry/codegraph) to offer a code map of your project, so the LLM can navigate symbols and call graphs without chaining `ls` → `grep` → `read`.

**Auxiliary Models** — offloads heavy-but-dumb tasks to cheaper models so your primary model only pays for the hard work:

- **Image read fallback** — detects image type via magic bytes, calls a configured vision-capable model, and injects the analysis text, so your main model never touches image tokens
- **Compact model** — handles context compaction with a smaller model instead of burning main-model capacity

Configured via `/dp-model`.

**Cache‑friendly design** — stable system prompt prefix:

- tool definitions, guidelines, and skills are sorted alphabetically so the system prompt is identical across sessions
- volatile elements like `Current date: …` are stripped before prompt assembly
- MCP tool schemas are persisted to a local cache, so the tool list stays stable regardless of network conditions or server availability

### 2. Smarter Tools

Drop‑in replacements for Pi's built‑in tools, with better UX and fewer wasted turns.

#### Patch Tool

| Capability | Pi native `edit` | `patch` |
| ------ | :---: | :---: |
| **Anchor‑based search** | ❌ extending `oldText` for uniqueness | ✅ `anchor` bounds scope for precise matching |
| **Fuzzy whitespace match** | ❌ only reports "not found" | ✅ auto‑corrects tab↔space / trailing whitespace mismatches |
| **Edit fault diagnostics** | ❌ only reports "not found" | ✅ pinpoint faults for LLM comprehension |
| **Stale‑read protection** | ❌ Blind to external changes | ✅ `read` captures mtime, `patch` rejects stale targets |

#### Smarter `@` File Search

`decorated-pi` replaces pi's built-in `@` autocomplete with a high-speed file finder backed by **[`@ff-labs/fff-node`](https://github.com/dmtrKovalenko/fff)**— a Rust SIMD fuzzy file search engine with in-memory index, frecency ranking, and git status awareness. Pi's native provider shells out to `fd` on every keystroke.

| Aspect | Pi native `@` | `decorated-pi` (FFF) |
| ------ | :---: | :---: |
| **Speed** | ❌ walks filesystem via `fd` subprocess on every keystroke | ✅ in‑memory index built once per session, ~0.1 ms / query |
| **Ranking** | ❌ 4‑bucket case‑sensitive score (exact/starts/contains/path) | ✅ fuzzy match + frecency + git status (boots from git log) |
| **Noise** | ❌ shows every file in the project, including `.git`, `node_modules`, `dist` | ✅ filters `git‑ignored` files; substring filter on path keeps short queries relevant |

###### Benchmark of `@`

```
┌─ smart-at benchmark
├─ generated 500,000 files in 3.9 s
├─ FFF scan complete in 664 ms
│  RSS after FFF index: 408 MB  (+330 MB over baseline)
├─ accuracy (14 queries)
│                  top‑1   top‑3   top‑5   false‑pos
│  smart-at         93%     93%     93%    0
│  native (fd)      86%     93%     93%    0
└─ corpus cleaned

name                                            hz      mean
· smart-at                                      8.10    123 ms
· native @  (fd subprocess)                     3.12    320 ms

Summary: smart-at is 2.59x faster than native @  (fd subprocess)
```

#### LSP support

Covers what codegraph can't: real-time compiler and lint errors.

- **`lsp_diagnostics`** — file diagnostics with severity filtering

Supported languages: c/cpp, go, java, lua, json, python, ruby, rust, svelte, typescript

### 3. MCP Ecosystem

Zero-config MCP client with built-in servers:

| Server | Tool Prefix | Source |
| --- | --- | --- |
| Context7 | `context7_*` | `https://mcp.context7.com/mcp` |
| Exa | `exa_*` | `https://mcp.exa.ai/mcp` |
| codegraph | `codegraph_*` | bundled binary |

**Custom servers** in `.pi/agent/mcp.json` (project) or `~/.pi/agent/mcp.json` (global). Project overrides global. Tool prompts and schemas are cached locally so MCP tools are available immediately on startup.

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

Use `/mcp` to view connection status and toggle servers.

### 4. Secret Redaction

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

### 5. Other

- `/usage` — token stats with cache‑hit rate, per‑model breakdown (Session / Today / This Week / This Month / All Time)
- `/retry` — continue after interruption
- Progressive context — supports subdirectory `AGENTS.md` / `CLAUDE.md` discovery and injection
- **WakaTime** — coding activity tracking via [WakaTime](https://wakatime.com)

## Configuration

Runtime settings in `~/.pi/agent/decorated-pi.json`. Modules can be toggled via `/dp-settings` (changes take effect after `/reload`).

```json
{
  "modules": {
    "tools": {
      "patchOverrideEdit": true,
      "ask": true,
      "lsp": true,
      "mcp": true
    },
    "hooks": {
      "secretRedaction": true,
      "rtk": true,
      "wakatime": true
    },
    "commands": {
      "atOverride": true,
      "retry": true,
      "usage": true
    }
  }
}
```

## License

MIT
