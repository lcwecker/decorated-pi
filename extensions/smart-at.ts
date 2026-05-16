/**
 * Smart @ - 高速文件搜索自动补全
 *
 * 【重要】applyCompletion / shouldTriggerFileCompletion 必须用 .bind(orig)
 * 不能用箭头函数!Pi editor 会做原型检查,新函数导致扩展崩溃。
 */

import { spawnSync } from "child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ═══════════════════════════════════════════════════════════
// 文件列表(缓存 10s,maxBuffer 防 ENOBUFS)
// ═══════════════════════════════════════════════════════════

let cachedDirs: string[] = [];
let cachedFiles: string[] = [];
let cacheTime = 0;
let cacheCwd = "";

function getFileAndDirList(cwd: string): { dirs: string[]; files: string[] } {
  const now = Date.now();
  if (cacheCwd === cwd && now - cacheTime < 10000) return { dirs: cachedDirs, files: cachedFiles };

  let dirs: string[] = [];
  let files: string[] = [];
  const opts = { timeout: 5000, encoding: "utf-8" as const, maxBuffer: 10 * 1024 * 1024, cwd };

  // 去掉 cwd 前缀和 ./ 前缀,转相对路径
  const rel = (s: string) => {
    let r = s.startsWith(cwd + "/") ? s.slice(cwd.length + 1) : s;
    return r.startsWith("./") ? r.slice(2) : r;
  };

  // 1. git ls-files (returns relative paths)
  const git = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], opts);
  if (git.status === 0) {
    const r = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], opts);
    if (r.status === 0 && r.stdout) files = r.stdout.trim().split("\n").filter(Boolean);
  }

  // 2. fd (returns absolute paths when given absolute path)
  if (!files.length) {
    const fdFiles = spawnSync("fd", ["--type", "f", "--hidden", ".", cwd], { ...opts, cwd: undefined });
    if (fdFiles.status === 0 && fdFiles.stdout) files = fdFiles.stdout.trim().split("\n").filter(Boolean).map(rel);
  }
  const fdDirs = spawnSync("fd", ["--type", "d", "--hidden", ".", cwd], { ...opts, cwd: undefined });
  if (fdDirs.status === 0 && fdDirs.stdout) dirs = fdDirs.stdout.trim().split("\n").filter(Boolean).map(rel);

  cachedDirs = dirs;
  cachedFiles = files;
  cacheTime = Date.now();
  cacheCwd = cwd;
  return { dirs, files };
}

// ═══════════════════════════════════════════════════════════
// 评分
// ═══════════════════════════════════════════════════════════

const EXT_PENALTY: Record<string, number> = {
  o: -500, obj: -500, a: -500, so: -500, dll: -500, exe: -500,
  wasm: -500, class: -400, pyc: -400,
  bmp: -200, png: -200, jpg: -200, gif: -200, ico: -200, svg: -100,
  mp3: -200, wav: -200, mp4: -200, avi: -200,
  pdf: -200, zip: -200, tar: -200, gz: -200,
  lock: -100, json: 0, yml: 0, yaml: 0, toml: 0,
};

const BAD_DIRS = ["node_modules", ".obj", "build", "dist"];

// 真模糊匹配（字符可以不连续）
function fuzzyScore(text: string, query: string): number {
  const t = text.toLowerCase(), q = query.toLowerCase();
  let qi = 0, firstMatch = -1, lastMatch = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (firstMatch < 0) firstMatch = ti;
      lastMatch = ti;
      qi++;
    }
  }
  if (qi < q.length) return 0;
  const span = lastMatch - firstMatch + 1;  // 匹配跨度
  const totalLen = t.length;
  // 跨度小 + 文件名短 = 高分
  return Math.max(10, 200 - span * 3 - totalLen);
}

function scoreFile(file: string, query: string, isDir = false): number {
  const cleaned = isDir ? file.replace(/\/$/, "") : file;
  const parts = cleaned.split("/");
  const name = parts[parts.length - 1] || cleaned;
  const stem = name.replace(/\.[^.]+$/, "");
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() || "" : "";
  const q = query.toLowerCase();
  const nl = name.toLowerCase();
  const sl = stem.toLowerCase();
  const depth = parts.length;
  const inDir = parts.slice(0, -1).some((d) => d.toLowerCase().includes(q));

  let s = 0;
  if (sl === q) s = isDir ? 980 : 950;
  else if (nl.startsWith(q + ".") || nl.startsWith(q + "_") || nl.startsWith(q + "/")) s = 900;
  else if (nl.startsWith(q)) s = 800;
  else if (nl.includes(q)) s = 500;
  else if (file.toLowerCase().includes(q)) s = 100;
  else {
    // 模糊匹配仅限文件名(全路径太松)
    s = fuzzyScore(nl, q);
  }
  if (!s) return 0;

  // 目录加成(+500,确保匹配目录排第一)
  if (isDir) s += 500;
  // 扩展名奖惩
  if (!isDir) s += EXT_PENALTY[ext] ?? 0;
  // 隐藏目录 / 缓存目录 / __pycache__ 类目录 降权
  const inBadDir = parts.some((d) => d.startsWith(".") || d.startsWith("__") || BAD_DIRS.includes(d));
  if (inBadDir) s -= 200;
  if (inDir) s += 300;

  return s * 3 - name.length - depth * 2;
}

// ═══════════════════════════════════════════════════════════
// 搜索
// ═══════════════════════════════════════════════════════════

function smartSearch(dirs: string[], files: string[], query: string): string[] {
  if (!query) {
    // 无查询:排除隐藏目录和隐藏目录下的所有文件
    const isHidden = (p: string) => p.split("/").some((s) => s.startsWith(".") || s.startsWith("__"));
    return [
      ...dirs.filter((d) => !isHidden(d)).slice(0, 10),
      ...files.filter((f) => !isHidden(f)).slice(0, 10),
    ];
  }
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  // 合并打分(隐藏目录降权但可见)
  const scored = [
    ...dirs.map((d) => ({ path: d.endsWith("/") ? d : d + "/", s: scoreFile(d, tokens[0]!, true) })),
    ...files.map((f) => ({ path: f, s: scoreFile(f, tokens[0]!, false) })),
  ].filter((x) => x.s > 0);

  if (tokens.length === 1) {
    return scored
      .sort((a, b) => b.s - a.s || a.path.localeCompare(b.path))
      .slice(0, 20)
      .map((x) => x.path);
  }

  // 多词 OR
  const seen = new Set<string>();
  const all = [
    ...dirs.map((d) => ({ path: d.endsWith("/") ? d : d + "/", isDir: true })),
    ...files.map((f) => ({ path: f, isDir: false })),
  ];
  for (const t of tokens) {
    for (const { path: p } of all
      .map(({ path, isDir }) => ({ path, s: scoreFile(path, t, isDir) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 20)) {
      seen.add(p);
    }
  }
  return [...seen].slice(0, 20);
}

// ═══════════════════════════════════════════════════════════
// @ 前缀
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

// ═══════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════

export function setupSmartAt(pi: ExtensionAPI) {
  pi.on("session_start", (_e: any, ctx: any) => {
    const cwd = String(ctx.cwd || "").trim();

    ctx.ui.addAutocompleteProvider((orig: any) => ({
      getSuggestions: (lines: any, cl: any, cc: any, opts: any) => {
        const prefix = atPrefix((lines[cl] || "").slice(0, cc));
        if (!prefix) {
          ctx.ui.setWidget("smart-at", undefined);
          return orig.getSuggestions(lines, cl, cc, opts);
        }

        const { dirs, files } = getFileAndDirList(cwd);
        const results = smartSearch(dirs, files, prefix.slice(1));

        if (!results.length) {
          ctx.ui.setWidget("smart-at", undefined);
          return null;
        }

        ctx.ui.setWidget("smart-at", ["[2mpowered by decorated-pi[0m"]);
        return Promise.resolve({
          items: results.map((f: string) => ({
            value: "@" + f,
            label: f.replace(/\/$/, "").split("/").pop() || f,
            description: f,
          })),
          prefix,
        });
      },
      // ⚠️ 必须 .bind(orig)
      applyCompletion: (...args: any[]) => {
        ctx.ui.setWidget("smart-at", undefined);
        return orig.applyCompletion.apply(orig, args);
      },
      shouldTriggerFileCompletion: orig.shouldTriggerFileCompletion?.bind(orig),
    }));
  });
}
