# decorated-pi

`decorated-pi` is a practical enhancement pack for [Pi](https://github.com/earendil-works/pi) — token-efficient workflow, cache-friendly design, and smarter tools.

## Install

```bash
pi install npm:decorated-pi
# or
pi install git:github.com/lcwecker/decorated-pi
# or
pi install /path/to/decorated-pi
```

## Features

### 1. Token Efficiency

Multiple layers of token savings that compound across every session.

**Talk Normal Prompt** — injects a compact response-style prompt adapted from [talk-normal](https://github.com/hexiecs/talk-normal), trimming filler, summary stamps, conditional follow-up menus, and verbose framing. This reduces assistant output tokens and keeps visible reasoning / explanation blocks tighter.

**RTK** — integrates [RTK](https://github.com/rtk-ai/rtk) to rewrite supported shell commands into compact, structured output, falling back to the original command if RTK fails. **Just install the CLI, zero config**.

**Codegraph** — integrates [codegraph](https://github.com/colbymchenry/codegraph) to offer a code map of your project, so the LLM can navigate symbols and call graphs without chaining `ls` → `grep` → `read`. **Create and maintain the project index yourself; see the [codegraph documentation](https://github.com/colbymchenry/codegraph/blob/main/README.md).**

**Auxiliary Models** — offloads heavy-but-dumb tasks to cheaper models so your primary model only pays for the hard work:

- **Image Read Fallback** — detects image type via magic bytes, calls a configured vision-capable model, and injects the analysis text, so your main model never touches image tokens
- **Compact Model** — handles context compaction with a smaller model instead of burning main-model capacity

> Configured via `/dp-model`.

**Cache‑friendly Design** — stable system prompt prefix:

- tool definitions, guidelines, and skills are sorted alphabetically so the system prompt stays deterministic for the same project and configuration
- MCP tool schemas are persisted after a successful connection, keeping the tool list stable across restarts and temporary server outages

**Pi Native Prompt Slimming**

- moves the default Pi documentation block out of the system prompt and into a builtin `pi-docs` skill, so the docs reference loads on demand instead of sitting in every turn's prompt

**Large Result Externalization**

- a `tool_result` hook that saves a tool's first text result when it exceeds 30,000 characters to `/tmp/decorated-pi-results/<tool>-<callId>.txt`, replacing it with a one-line pointer (`[Output too long, saved to /tmp/…]`) that the LLM can read on demand

### 2. Smarter Tools

LLM-callable tools and workflow upgrades with better UX and fewer wasted turns.

#### Patch Tool

| Capability | Pi native `edit` | `patch` |
| ------ | :---: | :---: |
| **Anchor‑based search** | ❌ extending `oldText` for uniqueness | ✅ `anchor` bounds scope for precise matching |
| **Fuzzy whitespace match** | ❌ only reports "not found" | ✅ auto‑corrects tab↔space / trailing whitespace mismatches |
| **Edit fault diagnostics** | ❌ only reports "not found" | ✅ pinpoint faults for LLM comprehension |
| **Stale‑read protection** | ❌ Blind to external changes | ✅ `read` captures mtime, `patch` rejects stale targets |

#### LSP support

Covers what codegraph can't: real-time compiler and lint errors.

- **`lsp_diagnostics`** — file diagnostics with severity filtering

Supported languages: c/cpp, go, java, lua, json, python, ruby, rust, svelte, typescript. TypeScript and JSON support are bundled; other languages require their corresponding language-server binaries.

### 3. MCP Ecosystem

Zero-config MCP client with built-in servers:

| Server | Tool Prefix | Source |
| --- | --- | --- |
| Context7 | `context7_*` | `https://mcp.context7.com/mcp` |
| Exa | `exa_*` | `https://mcp.exa.ai/mcp` |
| codegraph | `codegraph_*` | local `codegraph` CLI |

**Custom servers** in `.pi/agent/mcp.json` (project) or `~/.pi/agent/mcp.json` (global). Project entries override global entries with the same name. Tool prompts and schemas are cached after a successful connection for fast startup on subsequent sessions.

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

### 4. Other

- **`ask` tool** — collect text, single-choice, and multi-choice answers through an interactive wizard when the agent needs clarification.
- `/code-review [prompt]` — offload review of current changes to a separately configured model, avoiding a `/model` switch in the main session and preserving its prompt cache.
- `/usage` — token stats with cache‑hit rate, per‑model breakdown (Session / Today / This Week / This Month / All Time)
- `/retry` — continue after interruption
- **Progressive context** — supports subdirectory `AGENTS.md` / `CLAUDE.md` discovery and injection
- **WakaTime** — coding activity tracking via [WakaTime](https://wakatime.com)

## Configuration

Runtime settings live in `~/.pi/agent/decorated-pi.json`. Run `/dp-settings` to configure modules and dependency paths, and `/dp-model` to configure auxiliary models.

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
      "rtk": true,
      "wakatime": true
    },
    "commands": {
      "retry": true,
      "usage": true
    }
  },
  "dependencies": {
    "rtk": {
      "path": "/custom/bin/rtk",
      "dontBother": false
    },
    "wakatime-cli": {
      "dontBother": true
    }
  }
}
```

- `modules` can be toggled on/off to enable/disable features. All are enabled by default.
- `dependencies[binaryName].path` overrides the lookup location for a binary (file or directory). `dependencies[binaryName].dontBother` silences missing-dependency notifications for that binary. Both are optional.

## License

MIT
