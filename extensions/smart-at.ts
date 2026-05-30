/**
 * Smart @ - 高速文件搜索自动补全
 *
 * 设计:
 *   1. 缓存生命周期绑定用户交互: 触发 @ 时收集+缓存, 选择/取消时清除
 *   2. 收集时预计算路径惩罚(路径固有,跟 query 无关)
 *   3. 惩罚分级消费: 每个文件只命中最高级别的一档惩罚,不叠加
 *   4. 搜索时只算匹配分, 总分 = 匹配分 + 惩罚分
 *
 * 候选收集:
 *   - Git 仓库: git ls-files 列出文件, 从文件路径推导目录
 *   - 非 Git 仓库: fd 列出文件和目录
 *
 * 惩罚来源:
 *   - Git 仓库: .gitignore 规则(动态) + 静态规则
 *   - 非 Git 仓库: 仅静态规则
 *
 * 惩罚分级(从高到低,首次命中即消费,不叠加):
 *   Tier 1 (-400): 匹配 .gitignore 规则(仅 git 仓库)
 *   Tier 2 (-300): 在 .* 或 __* 目录下
 *   Tier 3 (-200): 在已知噪音目录下(build/dist/coverage 等)
 *   Tier 4 (-150~-80): 坏扩展名(二进制/编译产物/媒体文件)
 *   Base (always): -depth*30 - name.length
 *
 * 匹配:
 *   - 大小写敏感
 *   - 目录优先
 *
 * 【重要】applyCompletion / shouldTriggerFileCompletion 必须用 .bind(orig)
 * 不能用箭头函数! Pi editor 会做原型检查,新函数导致扩展崩溃。
 */

import { spawnSync } from "child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DependencyStatus } from "./rtk-integration";

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

type PenaltyTier = 0 | 1 | 2 | 3 | 4;

interface FileCandidate {
  path: string;       // 相对路径 "extensions/lsp/tools.ts"
  name: string;       // 文件名 "tools.ts"
  isDir: boolean;
  tier: PenaltyTier;  // 语义分级,用于空查询过滤
  penalty: number;    // 预计算: tierPenalty + basePenalty
}

// ═══════════════════════════════════════════════════════════
// 硬排除 & 惩罚规则
// ═══════════════════════════════════════════════════════════

/** 硬排除: 不枚举其子文件/子目录,但目录本身保留为候选 */
const HARD_EXCLUDE_DIRS = new Set(["node_modules", ".git", ".pnpm", ".svn"]);

/** Tier 3: 已知噪音目录(不以 . 开头,但通常是构建产物) */
const BAD_DIRS = new Set(["build", "dist", "coverage", "out", "target"]);

/** Tier 4: 扩展名惩罚(值为负数) */
const EXT_PENALTY: Record<string, number> = {
  o: -150, obj: -150, a: -150, so: -150, dll: -150, exe: -150,
  wasm: -150, class: -120, pyc: -120,
  bmp: -100, png: -100, jpg: -100, gif: -100, ico: -100, svg: -80,
  mp3: -100, wav: -100, mp4: -100, avi: -100,
  pdf: -100, zip: -100, tar: -100, gz: -100,
  lock: -80,
};

// ═══════════════════════════════════════════════════════════
// 惩罚预计算(分级消费,首次命中即停)
// ═══════════════════════════════════════════════════════════

interface PenaltyMeta {
  tier: PenaltyTier;
  penalty: number;
}

function computePenaltyMeta(filePath: string, isDir: boolean, gitIgnored: boolean): PenaltyMeta {
  const parts = filePath.replace(/\/$/, "").split("/");
  const name = parts[parts.length - 1] || filePath;
  const ext = (!isDir && name.includes(".")) ? (name.split(".").pop()?.toLowerCase() || "") : "";
  const depth = parts.length;

  // 文件: 检查父目录段; 目录: 检查所有段(含自身)
  const dirSegments = isDir ? parts : parts.slice(0, -1);

  let tier: PenaltyTier = 0;
  let tierPenalty = 0;

  if (gitIgnored) {
    tier = 1;
    tierPenalty = -400;
  } else if (dirSegments.some(d => d.startsWith(".") || d.startsWith("__"))) {
    tier = 2;
    tierPenalty = -300;
  } else if (dirSegments.some(d => BAD_DIRS.has(d))) {
    tier = 3;
    tierPenalty = -200;
  } else if (!isDir && (EXT_PENALTY[ext] ?? 0) < 0) {
    tier = 4;
    tierPenalty = EXT_PENALTY[ext]!;
  }

  const basePenalty = -(depth * 30) - name.length;
  return { tier, penalty: tierPenalty + basePenalty };
}

function computePenalty(filePath: string, isDir: boolean, gitIgnored: boolean): number {
  return computePenaltyMeta(filePath, isDir, gitIgnored).penalty;
}

// ═══════════════════════════════════════════════════════════
// 候选收集
// ═══════════════════════════════════════════════════════════

const SPAWN_OPTS = { timeout: 5000, encoding: "utf-8" as const, maxBuffer: 10 * 1024 * 1024 };

function isGitWorkTree(cwd: string): boolean {
  return spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { ...SPAWN_OPTS, cwd }).status === 0;
}

function commandExists(command: string): boolean {
  const result = spawnSync(
    process.platform === "win32" ? "where" : (process.env.SHELL || "sh"),
    process.platform === "win32" ? [command] : ["-lc", `command -v '${command.replace(/'/g, `'"'"'`)}'`],
    SPAWN_OPTS,
  );
  return result.status === 0;
}

export function getSmartAtDependencyStatuses(cwd: string): DependencyStatus[] {
  const isGit = isGitWorkTree(cwd);
  return [{
    module: "smart-at",
    label: "fd",
    state: commandExists("fd") ? "ok" : (isGit ? "n/a" : "missing"),
    detail: isGit
      ? "Only needed outside Git repositories."
      : "Install fd for non-Git project file discovery.",
  }];
}

function collectCandidates(cwd: string): FileCandidate[] {
  const candidates: FileCandidate[] = [];

  // 判断路径是否为硬排除目录的子项(不含硬排除目录本身)
  const isChildOfHardExclude = (p: string): boolean => {
    const parts = p.replace(/\/$/, "").split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      if (HARD_EXCLUDE_DIRS.has(parts[i]!)) return true;
    }
    return false;
  };

  const opts = { ...SPAWN_OPTS, cwd };

  // ── 检测是否 git 仓库 ──
  const isGit = isGitWorkTree(cwd);

  if (isGit) {
    collectGit(candidates, opts, isChildOfHardExclude);
  } else {
    collectFd(candidates, cwd, isChildOfHardExclude);
  }

  return candidates;
}

/** Git 仓库: git ls-files 列出文件, 从文件路径推导目录 */
function collectGit(
  candidates: FileCandidate[],
  opts: { timeout: number; encoding: "utf-8"; maxBuffer: number; cwd: string },
  isChildOfHardExclude: (p: string) => boolean,
) {
  // 可见文件(tracked + untracked 非 ignored)
  const r1 = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], opts);
  const visibleFiles = (r1.status === 0 && r1.stdout)
    ? r1.stdout.trim().split("\n").filter(Boolean)
    : [];

  // ignored 项(目录优先聚合)
  const r2 = spawnSync(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"],
    opts,
  );
  const ignoredDirs = new Set<string>();
  const ignoredFiles: string[] = [];
  if (r2.status === 0 && r2.stdout) {
    for (const raw of r2.stdout.trim().split("\n").filter(Boolean)) {
      const entry = raw.replace(/^\.\//,  "");
      if (isChildOfHardExclude(entry)) continue;
      if (entry.endsWith("/")) {
        ignoredDirs.add(entry.replace(/\/$/, ""));
      } else {
        ignoredFiles.push(entry);
      }
    }
  }

  const hasIgnoredAncestor = (p: string): boolean => {
    const parts = p.split("/");
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i]!;
      if (ignoredDirs.has(current)) return true;
    }
    return false;
  };

  const ignoredFileSet = new Set(ignoredFiles);

  // ── 可见文件 → 候选 ──
  const dirSet = new Set<string>();
  for (const f of visibleFiles) {
    if (isChildOfHardExclude(f)) continue;
    const name = f.split("/").pop() || f;
    const meta = computePenaltyMeta(f, false, false);
    candidates.push({ path: f, name, isDir: false, tier: meta.tier, penalty: meta.penalty });
    // 推导目录
    const parts = f.split("/");
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i]!;
      dirSet.add(current);
    }
  }

  // ── ignored 文件 → 候选 ──
  for (const f of ignoredFiles) {
    const name = f.split("/").pop() || f;
    const meta = computePenaltyMeta(f, false, true);
    candidates.push({ path: f, name, isDir: false, tier: meta.tier, penalty: meta.penalty });
  }

  // ── 推导的可见目录 → 候选 ──
  for (const d of dirSet) {
    const name = d.split("/").pop() || d;
    const meta = computePenaltyMeta(d, true, false);
    candidates.push({ path: d + "/", name, isDir: true, tier: meta.tier, penalty: meta.penalty });
  }

  // ── ignored 目录 → 候选 ──
  for (const d of ignoredDirs) {
    const name = d.split("/").pop() || d;
    const meta = computePenaltyMeta(d, true, true);
    candidates.push({ path: d + "/", name, isDir: true, tier: meta.tier, penalty: meta.penalty });
  }

  // ── 硬排除目录本身 → 候选(仅存在时加入) ──
  for (const hd of HARD_EXCLUDE_DIRS) {
    if (!existsSync(join(opts.cwd, hd))) continue;
    const meta = computePenaltyMeta(hd, true, false);
    candidates.push({ path: hd + "/", name: hd, isDir: true, tier: meta.tier, penalty: meta.penalty });
  }
}

/** 非 Git 仓库: fd 列出文件和目录, 仅用静态规则惩罚 */
function collectFd(
  candidates: FileCandidate[],
  cwd: string,
  isChildOfHardExclude: (p: string) => boolean,
) {
  const rel = (s: string) => {
    let r = s.startsWith(cwd + "/") ? s.slice(cwd.length + 1) : s;
    return r.startsWith("./") ? r.slice(2) : r;
  };

  const fdExcludes = [...HARD_EXCLUDE_DIRS].flatMap(d => ["--exclude", d]);
  const fdOpts = { ...SPAWN_OPTS, cwd: undefined as string | undefined };

  // 文件(排除硬排除目录的子文件)
  const r1 = spawnSync("fd", ["--type", "f", "--hidden", "--no-ignore", ...fdExcludes, ".", cwd], fdOpts);
  if (r1.status === 0 && r1.stdout) {
    for (const raw of r1.stdout.trim().split("\n").filter(Boolean)) {
      const f = rel(raw);
      const name = f.split("/").pop() || f;
      const meta = computePenaltyMeta(f, false, false);
      candidates.push({ path: f, name, isDir: false, tier: meta.tier, penalty: meta.penalty });
    }
  }

  // 目录(排除硬排除目录的子目录)
  const r2 = spawnSync("fd", ["--type", "d", "--hidden", "--no-ignore", ...fdExcludes, ".", cwd], fdOpts);
  if (r2.status === 0 && r2.stdout) {
    for (const raw of r2.stdout.trim().split("\n").filter(Boolean)) {
      const d = rel(raw).replace(/\/$/, "");
      const name = d.split("/").pop() || d;
      const meta = computePenaltyMeta(d, true, false);
      candidates.push({ path: d + "/", name, isDir: true, tier: meta.tier, penalty: meta.penalty });
    }
  }

  // 硬排除目录本身 → 候选(仅存在时加入)
  for (const hd of HARD_EXCLUDE_DIRS) {
    if (!existsSync(join(cwd, hd))) continue;
    const meta = computePenaltyMeta(hd, true, false);
    candidates.push({ path: hd + "/", name: hd, isDir: true, tier: meta.tier, penalty: meta.penalty });
  }
}

// ═══════════════════════════════════════════════════════════
// 匹配评分(query 相关,大小写敏感)
// ═══════════════════════════════════════════════════════════

/** 模糊匹配(大小写敏感,字符可以不连续) */
function fuzzyScore(text: string, query: string): number {
  let qi = 0, firstMatch = -1, lastMatch = -1;
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) {
      if (firstMatch < 0) firstMatch = ti;
      lastMatch = ti;
      qi++;
    }
  }
  if (qi < query.length) return 0;
  const span = lastMatch - firstMatch + 1;
  return Math.max(10, 200 - span * 3 - text.length);
}

/** 计算单个候选对 query 的匹配分(大小写敏感) */
function computeMatchScore(candidate: FileCandidate, query: string): number {
  const { path: filePath, name, isDir } = candidate;
  const stem = name.replace(/\.[^.]+$/, "");
  const parts = filePath.replace(/\/$/, "").split("/");
  const inDir = parts.slice(0, -1).some(d => d.includes(query));

  let s = 0;

  // 大小写敏感匹配
  if (stem === query)                                                       s = isDir ? 1500 : 1050;
  else if (name.startsWith(query + ".") || name.startsWith(query + "_"))    s = 1000;
  else if (name.startsWith(query))                                          s = 900;
  else if (name.includes(query))                                            s = 600;
  else if (filePath.includes(query))                                        s = 300;
  else                                                                      s = fuzzyScore(name, query);

  if (!s) return 0;

  // 目录轻微加成(tiebreaker,不碾压深度)
  if (isDir) s += 100;

  // 父目录命中加成
  if (inDir) s += 50;

  return s;
}

// ═══════════════════════════════════════════════════════════
// 搜索(匹配分 + 惩罚分 = 总分排序)
// ═══════════════════════════════════════════════════════════

function smartSearch(candidates: FileCandidate[], query: string): string[] {
  // 空查询: 按 tier 语义过滤, 隐藏 Tier 1/2
  if (!query) {
    const visible = candidates.filter(c => c.tier === 0 || c.tier === 3 || c.tier === 4);
    return visible
      .sort((a, b) => {
        // 目录优先
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return b.penalty - a.penalty || a.path.localeCompare(b.path);
      })
      .slice(0, 20)
      .map(c => c.path);
  }

  const tokens = query.split(/\s+/).filter(Boolean);

  if (tokens.length === 1) {
    const scored = candidates
      .map(c => {
        const matchScore = computeMatchScore(c, tokens[0]!);
        return { path: c.path, total: matchScore + c.penalty, matchScore };
      })
      .filter(x => x.matchScore > 0);

    return scored
      .sort((a, b) => b.total - a.total || a.path.localeCompare(b.path))
      .slice(0, 20)
      .map(x => x.path);
  }

  // 多词: 各 token 独立搜索取 union
  const seen = new Set<string>();
  for (const t of tokens) {
    const scored = candidates
      .map(c => {
        const matchScore = computeMatchScore(c, t);
        return { path: c.path, total: matchScore + c.penalty, matchScore };
      })
      .filter(x => x.matchScore > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 20);
    for (const { path } of scored) seen.add(path);
  }
  return [...seen].slice(0, 20);
}

// ═══════════════════════════════════════════════════════════
// @ 前缀检测
// ═══════════════════════════════════════════════════════════

function atPrefix(text: string): string | null {
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== "@") continue;
    const b = text[i - 1];
    if (i === 0 || b === " " || b === "\t" || b === "(" || b === "[") return text.slice(i);
    return null;
  }
  return null;
}

// 测试导出: 仅暴露纯逻辑
export const __smartAtTest = {
  computePenaltyMeta,
  computePenalty,
  fuzzyScore,
  computeMatchScore,
  smartSearch,
  atPrefix,
};

// ═══════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════

export function setupSmartAt(pi: ExtensionAPI) {
  pi.on("session_start", (_e: any, ctx: any) => {
    const cwd = String(ctx.cwd || "").trim();

    let cache: FileCandidate[] | null = null;

    function getOrBuildCache(): FileCandidate[] {
      if (!cache) cache = collectCandidates(cwd);
      return cache;
    }

    function clearCache() {
      cache = null;
    }

    ctx.ui.addAutocompleteProvider((orig: any) => ({
      getSuggestions: (lines: any, cl: any, cc: any, opts: any) => {
        const prefix = atPrefix((lines[cl] || "").slice(0, cc));
        if (!prefix) {
          clearCache();
          ctx.ui.setWidget("smart-at", undefined);
          return orig.getSuggestions(lines, cl, cc, opts);
        }

        const candidates = getOrBuildCache();
        const results = smartSearch(candidates, prefix.slice(1));

        if (!results.length) {
          ctx.ui.setWidget("smart-at", undefined);
          return null;
        }

        ctx.ui.setWidget("smart-at", ["\x1b[2mpowered by decorated-pi\x1b[0m"]);
        return Promise.resolve({
          items: results.map((f: string) => ({
            value: "@" + f,
            label: f.replace(/\/$/, "").split("/").pop() || f,
            description: f,
          })),
          prefix,
        });
      },
      applyCompletion: (...args: any[]) => {
        clearCache();
        ctx.ui.setWidget("smart-at", undefined);
        return orig.applyCompletion.apply(orig, args);
      },
      shouldTriggerFileCompletion: orig.shouldTriggerFileCompletion?.bind(orig),
    }));
  });
}
