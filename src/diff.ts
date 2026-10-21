import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { mapLimit } from "./async.ts"
import { isMissingHead, type GitRunner } from "./git.ts"
import type { Logger } from "./log.ts"
import { isNestedRepoEntry, normalizePath, parsePorcelain } from "./status.ts"
import type { Config, FileDiff, Repo } from "./types.ts"

export type DiffMode = "working" | "branch" | "committed"

export function parsePatch(text: string): FileDiff[] {
  const diffs: FileDiff[] = []
  if (!text.trim()) return diffs

  type Chunk = {
    file?: string
    lines: string[]
    additions: number
    deletions: number
    status: FileDiff["status"]
  }
  let current: Chunk | null = null

  const flush = () => {
    if (!current?.file) return
    diffs.push({
      file: normalizePath(current.file),
      patch: current.lines.join("\n"),
      additions: current.additions,
      deletions: current.deletions,
      status: current.status,
    })
  }

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush()
      current = { lines: [line], additions: 0, deletions: 0, status: "modified" }
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
      if (match) current.file = match[2]
      continue
    }
    if (!current) continue
    current.lines.push(line)

    if (line.startsWith("new file mode")) current.status = "added"
    else if (line.startsWith("deleted file mode")) current.status = "deleted"
    else if (line.startsWith("+++ /dev/null")) current.status = "deleted"
    else if (line.startsWith("+++ b/")) current.file = line.slice("+++ b/".length)
    else if (line.startsWith("--- /dev/null")) current.status = "added"
    else if (line.startsWith("--- a/")) {
      if (!current.file) current.file = line.slice("--- a/".length)
    } else if (line.startsWith("+") && !line.startsWith("+++")) current.additions++
    else if (line.startsWith("-") && !line.startsWith("---")) current.deletions++
  }
  flush()
  return diffs
}

/** 同一文件可能同时出现在 staged 与 unstaged 两段 diff 里，按文件合并避免重复条目。 */
export function mergeDiffs(list: readonly FileDiff[]): FileDiff[] {
  const map = new Map<string, FileDiff>()
  for (const item of list) {
    const prev = map.get(item.file)
    if (!prev) {
      map.set(item.file, { ...item })
      continue
    }
    prev.patch = `${prev.patch}\n${item.patch}`.trim()
    prev.additions += item.additions
    prev.deletions += item.deletions
    if (item.status === "added") prev.status = "added"
    else if (item.status === "deleted" && prev.status === "modified") prev.status = "deleted"
  }
  return [...map.values()]
}

async function resolveMergeBase(
  git: GitRunner,
  dir: string,
  base?: string,
): Promise<string | null> {
  const candidates: string[] = []
  if (base) {
    // 显式基线优先；子仓库可能只有本地同名分支，补一个去 origin/ 的候选
    candidates.push(base)
    if (base.startsWith("origin/")) candidates.push(base.slice("origin/".length))
  } else {
    try {
      const head = (await git.run(dir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).trim()
      if (head) candidates.push(head)
    } catch {
      // 无 origin/HEAD 时走常见默认分支兜底
    }
  }
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (!candidates.includes(ref)) candidates.push(ref)
  }
  for (const ref of candidates) {
    try {
      const out = (await git.run(dir, ["merge-base", ref, "HEAD"])).trim()
      if (out) return out
    } catch {
      // 尝试下一个候选
    }
  }
  return null
}

async function listUntracked(git: GitRunner, dir: string): Promise<string[]> {
  try {
    const out = await git.run(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    return parsePorcelain(out)
      .filter((record) => record.xy === "??")
      .map((record) => record.file)
  } catch {
    return []
  }
}

/**
 * `git diff` 不包含未跟踪文件，这里为每个未跟踪文件用
 * `git diff --no-index -- /dev/null <file>` 构造标准的新增文件 patch。
 */
async function collectUntrackedDiff(
  git: GitRunner,
  dir: string,
  context: number,
  config: Config,
  logger: Logger,
): Promise<FileDiff[]> {
  const result: FileDiff[] = []
  const files = await listUntracked(git, dir)
  for (const file of files.slice(0, config.maxUntrackedFiles)) {
    try {
      const full = path.join(dir, file)
      const stat = await fsp.stat(full)
      if (!stat.isFile() || stat.size > config.maxUntrackedBytes) continue
      const text = await git.allowFailure(dir, [
        "diff",
        "--no-index",
        `-U${context}`,
        "--",
        "/dev/null",
        file,
      ])
      result.push(...parsePatch(text))
    } catch (error) {
      logger.debug("untracked diff failed", { dir, file, error: String(error) })
    }
  }
  return result
}

async function collectDiff(
  git: GitRunner,
  repo: Repo,
  mode: DiffMode,
  base: string | undefined,
  context: number,
  config: Config,
  logger: Logger,
): Promise<FileDiff[]> {
  const dir = repo.dir
  const common = ["--no-color", `-U${context}`]
  let text: string
  if (mode === "working") {
    try {
      text = await git.run(dir, ["diff", ...common, "HEAD", "--"])
    } catch (error) {
      if (!isMissingHead(error)) {
        logger.error("diff failed", { repo: repo.prefix || dir, error: String(error) })
        return []
      }
      // 空仓库：HEAD 不存在，退化为空树↔index + index↔worktree
      logger.debug("HEAD missing, fallback to index/worktree", { dir })
      const parts = [
        await git.allowFailure(dir, ["diff", ...common, "--cached", "--"]),
        await git.allowFailure(dir, ["diff", ...common, "--"]),
      ]
      text = parts.join("\n")
    }
  } else {
    const merged = await resolveMergeBase(git, dir, base)
    if (!merged) return []
    const args =
      mode === "branch"
        ? ["diff", ...common, merged, "--"]
        : ["diff", ...common, `${merged}..HEAD`, "--"]
    try {
      text = await git.run(dir, args)
    } catch (error) {
      logger.error("diff failed", { repo: repo.prefix || dir, mode, error: String(error) })
      return []
    }
  }

  const diffs = mergeDiffs(parsePatch(text))
  if (mode !== "working") return diffs
  const untracked = await collectUntrackedDiff(git, dir, context, config, logger)
  return mergeDiffs([...diffs, ...untracked])
}

export type AggregateInput = {
  worktree: string
  mode: DiffMode
  base?: string
  context: number
  maxOutputBytes: number
}

export async function aggregateDiff(
  input: AggregateInput,
  repos: readonly Repo[],
  git: GitRunner,
  config: Config,
  logger: Logger,
): Promise<FileDiff[]> {
  const childPrefixes = repos.filter((repo) => repo.prefix !== "").map((repo) => repo.prefix)
  const perRepo = await mapLimit(repos, config.concurrency, async (repo) => {
    const list = await collectDiff(git, repo, input.mode, input.base, input.context, config, logger)
    const filtered =
      repo.prefix === ""
        ? list.filter((item) => !isNestedRepoEntry(item.file, childPrefixes))
        : list
    return filtered.map((item) => ({
      ...item,
      file: repo.prefix ? `${repo.prefix}/${item.file}` : item.file,
    }))
  })

  const all = perRepo.flat()
  const limit = input.maxOutputBytes > 0 ? input.maxOutputBytes : Number.POSITIVE_INFINITY
  const result: FileDiff[] = []
  let total = 0
  for (const item of all) {
    // 按文件边界截断，避免把 patch 切成半截
    if (total + item.patch.length > limit) break
    result.push(item)
    total += item.patch.length
  }
  return result
}
