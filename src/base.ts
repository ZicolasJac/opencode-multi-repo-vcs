import type { GitRunner } from "./git.ts"

export type ReviewBase = { name: string; ref: string; source: "reflog" | "default" }

export async function currentBranch(git: GitRunner, dir: string): Promise<string | undefined> {
  try {
    const value = (await git.run(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
    return value === "HEAD" ? undefined : value
  } catch {
    return undefined
  }
}

export async function defaultBranch(git: GitRunner, dir: string): Promise<string | undefined> {
  try {
    const ref = (await git.run(dir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).trim()
    return ref.replace(/^refs\/remotes\//, "").replace(/^origin\//, "")
  } catch {
    return undefined
  }
}

export async function listBranches(
  git: GitRunner,
  dir: string,
  search?: string,
  limit?: number,
): Promise<string[]> {
  try {
    const out = await git.run(dir, ["branch", "--all", "--format=%(refname:short)"])
    let branches = out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    if (search) {
      const needle = search.toLowerCase()
      branches = branches.filter((branch) => branch.toLowerCase().includes(needle))
    }
    if (limit && limit > 0) branches = branches.slice(0, limit)
    return branches
  } catch {
    return []
  }
}

async function refExists(git: GitRunner, dir: string, ref: string): Promise<boolean> {
  try {
    await git.run(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
    return true
  } catch {
    return false
  }
}

async function branchCreatedFrom(
  git: GitRunner,
  dir: string,
  branch: string,
): Promise<string | null> {
  try {
    const out = await git.run(dir, ["reflog", "show", "--format=%gs", branch])
    for (const raw of out.split("\n")) {
      const match = raw.trim().match(/^branch: Created from (.+)$/)
      if (!match) continue
      const from = match[1].trim()
      // "Created from HEAD" 无法定位具体分支，交给默认分支兜底
      if (!from || from === "HEAD") continue
      return from
    }
  } catch {
    // 无 reflog（浅克隆 / 手工构造的仓库）时交给默认分支兜底
  }
  return null
}

/**
 * 2.1.0+ 的审阅基线（`GET /api/vcs/base`）：
 * 优先按分支创建历史（reflog）推断，其次回落到仓库默认分支；
 * detached HEAD / 空仓库 / 无法确定时返回 null。
 */
export async function reviewBase(git: GitRunner, dir: string): Promise<ReviewBase | null> {
  const current = await currentBranch(git, dir)
  if (!current) return null

  const detected = await defaultBranch(git, dir)
  const names = detected ? [detected] : ["main", "master"]
  let defaultName: string | undefined
  let defaultRef: string | undefined
  for (const name of names) {
    if (await refExists(git, dir, `origin/${name}`)) {
      defaultName = name
      defaultRef = `origin/${name}`
      break
    }
    if (await refExists(git, dir, name)) {
      defaultName = name
      defaultRef = name
      break
    }
  }
  const fallback: ReviewBase | null =
    defaultName && defaultRef ? { name: defaultName, ref: defaultRef, source: "default" } : null

  if (defaultName && current === defaultName) return fallback

  const from = await branchCreatedFrom(git, dir, current)
  if (from) {
    const candidates = from.startsWith("origin/")
      ? [from, from.slice("origin/".length)]
      : [from, `origin/${from}`]
    for (const ref of candidates) {
      if (await refExists(git, dir, ref)) {
        return { name: ref.replace(/^origin\//, ""), ref, source: "reflog" }
      }
    }
  }

  return fallback
}
