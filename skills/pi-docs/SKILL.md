---
name: pi-docs
description: pi docs resources
---

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI).
Resolve pi's installation path dynamically via:
```
npm root -g
```
Then append `@earendil-works/pi-coding-agent` to find the package root, e.g.:
- Main documentation: `$(npm root -g)/@earendil-works/pi-coding-agent/README.md`
- Additional docs: `$(npm root -g)/@earendil-works/pi-coding-agent/docs`
- Examples: `$(npm root -g)/@earendil-works/pi-coding-agent/examples` (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)
