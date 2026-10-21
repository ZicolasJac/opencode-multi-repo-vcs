import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { mapLimit } from "./async.ts"
import { isMissingHead, type GitRunner } from "./git.ts"
import type { Logger } from "./log.ts"
import type { Config, FileStatus, Repo } from "./types.ts"

export type RawStatus = { file: string; xy: string }

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "")
}

export function parsePorcelain(out: string): RawStatus[] {
  const records = out.split("\0")
  const result: RawStatus[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record || record.length < 4) continue
    const xy = record.slice(0, 2)
    const file = record.slice(3)
    result.push({ file, xy })
    // rename/copy 会额外跟一条旧路径记录
    if (xy[0] === "R" || xy[0] === "C") i++
  }
  return result
}

export function mapStatus(xy: string): FileStatus["status"] {
  if (xy === "??") return "added"
  const x = xy[0]
  const y = xy[1]
  if (x === "A" || x === "?") return "added"
  if (x === "D" || y === "D") return "deleted"
  return "modified"
}

async function numstatText(git: GitRunner, dir: string, args: string[]): Promise<string> {
  try {
    return await git.run(dir, args)
  } catch {
    return ""
  }
}

/** 空仓库（unborn HEAD）没有 HEAD，`git diff HEAD` 会失败，但 staged/worktree 改动仍在。 */
export async function numstatMap(
  git: GitRunner,
  dir: string,
): Promise<Map<string, { additions: number; deletions: number }>> {
  const map = new Map<string, { additions: number; deletions: number }>()
  let out: string
  try {
    out = await git.run(dir, ["diff", "--numstat", "-z", "HEAD", "--"])
  } catch (error) {
    if (!isMissingHead(error)) return map
    const parts = [
      await numstatText(git, dir, ["diff", "--numstat", "-z", "--cached", "--"]),
      await numstatText(git, dir, ["diff", "--numstat", "-z", "--"]),
    ]
    out = parts.join("\0")
  }
  const chunks = out.split("\0")
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    if (!chunk) continue
    const parts = chunk.split("\t")
    if (parts.length < 3) continue
    let file = parts.slice(2).join("\t")
    if (file === "") {
      // rename：后两块依次是旧路径、新路径
      const newPath = chunks[i + 2] ?? ""
      const oldPath = chunks[i + 1] ?? ""
      file = newPath || oldPath
      i += 2
    }
    file = normalizePath(file)
    if (!file) continue
    const additions = parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10)
    const deletions = parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10)
    const prev = map.get(file)
    map.set(file, {
      additions: (prev?.additions ?? 0) + (Number.isFinite(additions) ? additions : 0),
      deletions: (prev?.deletions ?? 0) + (Number.isFinite(deletions) ? deletions : 0),
    })
  }
  return map
}

async function countLines(filePath: string, maxBytes: number): Promise<number> {
  try {
    const stat = await fsp.stat(filePath)
    if (!stat.isFile() || stat.size > maxBytes) return 0
    const handle = await fsp.open(filePath, "r")
    try {
      const head = Buffer.alloc(8192)
      const { bytesRead } = await handle.read(head, 0, head.length, 0)
      // 前 8KiB 含 NUL 字节视为二进制，不计入行数
      if (head.subarray(0, bytesRead).includes(0)) return 0
    } finally {
      await handle.close()
    }
    const content = await fsp.readFile(filePath, "utf8")
    if (content.length === 0) return 0
    const lines = content.split(/\r\n|\r|\n/)
    return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length
  } catch {
    return 0
  }
}

async function statusForRepo(
  git: GitRunner,
  repo: Repo,
  out: string,
  config: Config,
): Promise<FileStatus[]> {
  const records = parsePorcelain(out)
  const stats = await numstatMap(git, repo.dir)
  const items: FileStatus[] = []
  for (const record of records) {
    const relative = normalizePath(record.file)
    let counts = stats.get(relative)
    if (!counts && record.xy === "??") {
      counts = {
        additions: await countLines(path.join(repo.dir, relative), config.maxUntrackedBytes),
        deletions: 0,
      }
    }
    items.push({
      file: repo.prefix ? `${repo.prefix}/${relative}` : relative,
      additions: counts?.additions ?? 0,
      deletions: counts?.deletions ?? 0,
      status: mapStatus(record.xy),
    })
  }
  return items
}

/**
 * 根仓库会把嵌套仓库显示为 gitlink（`M path`）或未跟踪目录（`?? path/`），
 * 这些条目与子仓库文件重复，需要过滤。
 */
export function isNestedRepoEntry(file: string, childPrefixes: readonly string[]): boolean {
  const normalized = normalizePath(file)
  const stripped = normalized.replace(/\/+$/, "")
  return childPrefixes.some(
    (prefix) =>
      stripped === prefix || (normalized.endsWith("/") && prefix.startsWith(normalized)),
  )
}

export async function collectStatus(
  worktree: string,
  repos: readonly Repo[],
  git: GitRunner,
  config: Config,
  logger: Logger,
): Promise<FileStatus[]> {
  const childPrefixes = repos.filter((repo) => repo.prefix !== "").map((repo) => repo.prefix)
  const perRepo = await mapLimit(repos, config.concurrency, async (repo) => {
    try {
      const out = await git.run(repo.dir, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ])
      const items = await statusForRepo(git, repo, out, config)
      return repo.prefix === ""
        ? items.filter((item) => !isNestedRepoEntry(item.file, childPrefixes))
        : items
    } catch (error) {
      logger.error("status failed", { repo: repo.prefix || worktree, error: String(error) })
      return []
    }
  })
  return perRepo.flat().sort((a, b) => a.file.localeCompare(b.file))
}
