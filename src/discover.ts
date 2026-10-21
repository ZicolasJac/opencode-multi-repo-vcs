import * as fs from "node:fs"
import * as path from "node:path"
import type { Logger } from "./log.ts"
import type { Config, Repo } from "./types.ts"

export function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"))
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function realKey(target: string): string {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return path.resolve(target)
  }
}

export function toPosix(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "")
}

/** `target` 是否位于 `root` 之内（含 root 自身） */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function prefixOf(root: string, dir: string): string {
  const rel = path.relative(root, path.resolve(dir))
  return rel === "" ? "" : toPosix(rel)
}

/**
 * 发现需要聚合的仓库。
 *
 * - 工作区根是仓库时纳入（前缀为空），**并继续向下扫描**（根同时是容器）；
 * - 根扫描：`depth` 层，命中仓库即停止深入（避免 submodule 套娃）；
 * - `scanRoots`：每个起点若是仓库则直接纳入，否则在其下按该项 depth 扫描；
 * - 所有路径必须落在工作区内，junction/symlink 解析到区外会被跳过。
 */
export function discoverRepos(worktree: string, config: Config, logger: Logger): Repo[] {
  const root = path.resolve(worktree)
  const rootReal = realKey(root)
  const ignore = new Set(config.ignoreDirs)
  const found = new Map<string, Repo>()

  const add = (dir: string, source: string) => {
    const abs = path.resolve(dir)
    const real = realKey(abs)
    if (!isInside(rootReal, real)) {
      logger.debug("repo outside workspace, skipped", { dir: abs, source })
      return
    }
    if (!found.has(real)) found.set(real, { dir: abs, prefix: prefixOf(root, abs) })
  }

  const scanChildren = (dir: string, depth: number, source: string) => {
    if (depth <= 0) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue
      // junction / symlink 的 Dirent.isDirectory() 为 false，用 stat 兜底
      const child = path.join(dir, entry.name)
      if (!isDirectory(child)) continue
      if (isGitRepo(child)) add(child, source)
      else scanChildren(child, depth - 1, source)
    }
  }

  // 根仓库（若存在）始终纳入
  if (isGitRepo(root)) add(root, "root")
  // 默认起点：工作区根，按 depth 向下扫描
  scanChildren(root, config.depth, "root")

  // 额外起点
  for (const scanRoot of config.scanRoots) {
    const abs = path.resolve(root, scanRoot.path)
    if (!isInside(root, abs)) {
      logger.debug("scanRoot outside workspace, skipped", { path: scanRoot.path })
      continue
    }
    if (!isDirectory(abs)) {
      logger.debug("scanRoot is not a directory, skipped", { path: scanRoot.path })
      continue
    }
    if (isGitRepo(abs)) {
      add(abs, scanRoot.path)
      continue
    }
    scanChildren(abs, scanRoot.depth, scanRoot.path)
  }

  return [...found.values()].sort((a, b) => a.prefix.localeCompare(b.prefix))
}
