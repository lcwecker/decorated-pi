/**
 * LSP Server Config — language detection, server commands, workspace roots.
 */
import { existsSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

// ─── File extension → language mapping ────────────────────────────────────

const EXTENSION_LANGUAGES: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "typescript", ".jsx": "typescript", ".mjs": "typescript", ".cjs": "typescript",
  ".c": "c", ".h": "cpp", ".cc": "cpp", ".cp": "cpp", ".cpp": "cpp",
  ".cxx": "cpp", ".hh": "cpp", ".hpp": "cpp", ".hxx": "cpp",
  ".py": "python", ".rs": "rust", ".go": "go", ".rb": "ruby",
  ".java": "java", ".lua": "lua", ".svelte": "svelte",
};

export interface LanguageConfig {
  language: string;
  command: string;
  args: string[];
  install_hint: string;
  is_project_local?: boolean;
}

const LANGUAGE_SERVERS: Record<string, Omit<LanguageConfig, "is_project_local">> = {
  typescript: {
    language: "typescript", command: "typescript-language-server",
    args: ["--stdio"],
    install_hint: "Install TypeScript LSP with: pnpm add -D typescript typescript-language-server",
  },
  c: {
    language: "c", command: "clangd", args: ["--background-index"],
    install_hint: "Install clangd and ensure the clangd binary is on PATH.",
  },
  cpp: {
    language: "cpp", command: "clangd", args: ["--background-index"],
    install_hint: "Install clangd and ensure the clangd binary is on PATH.",
  },
  python: {
    language: "python", command: "pylsp", args: [],
    install_hint: "Install Python LSP with: pip install python-lsp-server",
  },
  rust: {
    language: "rust", command: "rust-analyzer", args: [],
    install_hint: "Install Rust Analyzer and ensure the rust-analyzer binary is on PATH.",
  },
  go: {
    language: "go", command: "gopls", args: ["serve"],
    install_hint: "Install Go LSP with: go install golang.org/x/tools/gopls@latest",
  },
  ruby: {
    language: "ruby", command: "solargraph", args: ["stdio"],
    install_hint: "Install Ruby LSP with: gem install solargraph",
  },
  java: {
    language: "java", command: "jdtls", args: [],
    install_hint: "Install Eclipse JDT Language Server and ensure the jdtls binary is on PATH.",
  },
  lua: {
    language: "lua", command: "lua-language-server", args: [],
    install_hint: "Install Lua LSP and ensure the lua-language-server binary is on PATH.",
  },
  svelte: {
    language: "svelte", command: "svelteserver", args: ["--stdio"],
    install_hint: "Install Svelte LSP with: pnpm add -D svelte-language-server",
  },
};

const WORKSPACE_MARKERS = [
  "svelte.config.js", "svelte.config.ts", "tsconfig.json", "jsconfig.json",
  "package.json", "pyproject.toml", "Cargo.toml", "go.mod",
  "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts",
  ".clangd", "compile_commands.json", "compile_flags.txt",
  "CMakeLists.txt", "meson.build", "Makefile",
];

const REPOSITORY_MARKERS = [
  "pnpm-workspace.yaml", "package-lock.json", "yarn.lock",
  "bun.lockb", "bun.lock", ".git",
];

// ─── Public API ───────────────────────────────────────────────────────────

export function detectLanguage(filePath: string): string | undefined {
  return EXTENSION_LANGUAGES[extname(filePath).toLowerCase()];
}

export function listSupportedLanguages(): string[] {
  return Object.keys(LANGUAGE_SERVERS).sort();
}

export function getServerConfig(
  language: string,
  cwd = process.cwd(),
): LanguageConfig | undefined {
  const base = LANGUAGE_SERVERS[language];
  if (!base) return undefined;

  const resolved = resolveLocalBinary(base.command, cwd);
  return { ...base, command: resolved.command, is_project_local: resolved.is_project_local };
}

export function languageIdForFile(filePath: string): string | undefined {
  return detectLanguage(filePath);
}

export function findWorkspaceRoot(
  filePath: string,
  fallback = process.cwd(),
): string {
  const start = resolve(dirname(filePath));
  const projectRoot = findNearestMarker(start, WORKSPACE_MARKERS);
  if (projectRoot) return projectRoot;
  const repoRoot = findNearestMarker(start, REPOSITORY_MARKERS);
  if (repoRoot) return repoRoot;
  return resolve(fallback);
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function resolveLocalBinary(
  command: string,
  cwd: string,
): { command: string; is_project_local: boolean } {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return { command, is_project_local: false };
  }
  for (const dir of ancestorDirs(cwd)) {
    const localBin = join(dir, "node_modules", ".bin", command);
    if (existsSync(localBin)) return { command: localBin, is_project_local: true };
    if (existsSync(localBin + ".cmd")) return { command: localBin + ".cmd", is_project_local: true };
  }
  return { command, is_project_local: false };
}

function findNearestMarker(start: string, markers: string[]): string | undefined {
  for (const dir of ancestorDirs(start)) {
    if (markers.some((m) => existsSync(join(dir, m)))) return dir;
  }
  return undefined;
}

function* ancestorDirs(start: string): Generator<string> {
  let current = resolve(start);
  while (true) {
    yield current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
