import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"

/**
 * opencode-multi-repo-vcs
 *
 * 将工作区根仓库与 `.codespace/*` 下各独立 git 子仓库的未提交改动
 * 聚合到 OpenCode 变更栏（VCS provider 扩展点）。
 */

type VcsStatus = {
  file: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

type DiffInfo = {
  file: string
  patch: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

type Scope = {
  directory: string
  worktree: string
  canonical: string
  store?: string
}

type DiffInput = Scope & {
  mode: "working" | "branch" | "committed"
  base?: string
  context: number
  maxOutputBytes: number
}

type BranchesInput = Scope & {
  search?: string
  limit?: number
}

const PROVIDER_ID = "multi-repo"
const CODESPACE_DIR = ".codespace"
const DEV_LOG = "D:\\zjc-ai-workspace\\opencode-multi-repo-vcs\\.dev\\plugin.log"
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024

function appendLog(line: string) {
  try {
    fs.mkdirSync(path.dirname(DEV_LOG), { recursive: true })
    fs.appendFileSync(DEV_LOG, line + "\n", "utf8")
  } catch {
    // 探针失败不影响插件本体
  }
}

function log(message: string, extra?: unknown) {
  const line = `${new Date().toISOString()} ${message}${extra === undefined ? "" : " " + JSON.stringify(extra)}`
  console.log(`[multi-repo-vcs] ${line}`)
  appendLog(line)
}

function git(cwd: string, args: string[], maxBuffer = 32 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, maxBuffer, windowsHide: true, encoding: "utf8" },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    )
  })
}

/**
 * 允许非零退出码的 git 调用。
 * `git diff --no-index` 在存在差异时退出码为 1，属于正常情况，标准输出仍是完整 patch。
 */
function gitAllowFailure(cwd: string, args: string[], maxBuffer = 32 * 1024 * 1024): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, maxBuffer, windowsHide: true, encoding: "utf8" },
      (_error, stdout) => resolve(String(stdout ?? "")),
    )
  })
}

function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "")
}

type ChildRepo = { name: string; dir: string }

function discoverChildRepos(worktree: string): ChildRepo[] {
  const root = path.join(worktree, CODESPACE_DIR)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const repos: ChildRepo[] = []
  for (const entry of entries) {
    // junction / symlink 指向的目录，Dirent.isDirectory() 为 false，需要 stat 兜底
    let isDir = entry.isDirectory()
    if (!isDir) {
      try {
        isDir = fs.statSync(path.join(root, entry.name)).isDirectory()
      } catch {
        isDir = false
      }
    }
    if (!isDir) continue
    const dir = path.join(root, entry.name)
    if (fs.existsSync(path.join(dir, ".git"))) repos.push({ name: entry.name, dir })
  }
  return repos
}

type RawStatus = { file: string; xy: string }

function parsePorcelain(out: string): RawStatus[] {
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

function mapStatus(xy: string): "added" | "deleted" | "modified" {
  if (xy === "??") return "added"
  const x = xy[0]
  const y = xy[1]
  if (x === "A" || x === "?") return "added"
  if (x === "D" || y === "D") return "deleted"
  return "modified"
}

async function listUntracked(dir: string): Promise<string[]> {
  try {
    const out = await git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    return parsePorcelain(out)
      .filter((record) => record.xy === "??")
      .map((record) => record.file)
  } catch {
    return []
  }
}

/**
 * 空仓库（unborn branch）没有 HEAD，`git diff HEAD` / `git diff --numstat HEAD`
 * 会报 `fatal: bad revision 'HEAD'`，但 staged / worktree 的改动依然存在。
 */
function isMissingHead(error: unknown): boolean {
  const text = String(error)
  return (
    text.includes("bad revision 'HEAD'") ||
    text.includes("unknown revision") ||
    text.includes("does not have any commits") ||
    text.includes("needed a single revision")
  )
}

async function gitTextOrEmpty(dir: string, args: string[]): Promise<string> {
  try {
    return await git(dir, args)
  } catch {
    return ""
  }
}

async function numstatMap(dir: string): Promise<Map<string, { additions: number; deletions: number }>> {
  const map = new Map<string, { additions: number; deletions: number }>()
  let out: string
  try {
    out = await git(dir, ["diff", "--numstat", "-z", "HEAD", "--"])
  } catch (error) {
    if (!isMissingHead(error)) return map
    // 空仓库：空树↔index（已暂存）+ index↔worktree（未暂存）
    const parts = [
      await gitTextOrEmpty(dir, ["diff", "--numstat", "-z", "--cached", "--"]),
      await gitTextOrEmpty(dir, ["diff", "--numstat", "-z", "--"]),
    ]
    out = parts.join("\0")
  }
  for (const chunk of out.split("\0")) {
    if (!chunk) continue
    const parts = chunk.split("\t")
    if (parts.length < 3) continue
    const file = normalize(parts.slice(2).join("\t"))
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

async function countLines(filePath: string): Promise<number> {
  try {
    const stat = await fsp.stat(filePath)
    if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) return 0
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

async function statusForRepo(dir: string, prefix: string, out: string): Promise<VcsStatus[]> {
  const records = parsePorcelain(out)
  const stats = await numstatMap(dir)
  const items: VcsStatus[] = []
  for (const record of records) {
    const relative = normalize(record.file)
    let counts = stats.get(relative)
    if (!counts && record.xy === "??") {
      counts = { additions: await countLines(path.join(dir, relative)), deletions: 0 }
    }
    items.push({
      file: prefix ? `${prefix}/${relative}` : relative,
      additions: counts?.additions ?? 0,
      deletions: counts?.deletions ?? 0,
      status: mapStatus(record.xy),
    })
  }
  return items
}

async function collectStatus(worktree: string): Promise<VcsStatus[]> {
  const items: VcsStatus[] = []

  let rootOut = ""
  try {
    rootOut = await git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  } catch {
    // 根目录不是 git 仓库：跳过根，但仍继续聚合 .codespace 子仓库
    log("root repo status failed", { worktree: String(worktree) })
  }
  if (rootOut) items.push(...(await statusForRepo(worktree, "", rootOut)))

  for (const repo of discoverChildRepos(worktree)) {
    try {
      const out = await git(repo.dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
      items.push(...(await statusForRepo(repo.dir, `${CODESPACE_DIR}/${repo.name}`, out)))
    } catch (error) {
      log("child repo status failed", { repo: repo.name, error: String(error) })
    }
  }

  items.sort((a, b) => a.file.localeCompare(b.file))
  return items
}

function parsePatch(text: string): DiffInfo[] {
  const diffs: DiffInfo[] = []
  if (!text.trim()) return diffs

  type Chunk = {
    file?: string
    lines: string[]
    additions: number
    deletions: number
    status: "added" | "deleted" | "modified"
  }
  let current: Chunk | null = null

  const flush = () => {
    if (!current?.file) return
    diffs.push({
      file: normalize(current.file),
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

async function resolveMergeBase(dir: string, base?: string): Promise<string | null> {
  const candidates: string[] = []
  if (base) {
    // 显式基线优先；子仓库可能只有本地同名分支，补一个去 origin/ 的候选
    candidates.push(base)
    if (base.startsWith("origin/")) candidates.push(base.slice("origin/".length))
  } else {
    try {
      const head = (await git(dir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).trim()
      if (head) candidates.push(head)
    } catch {
      // 无 origin/HEAD 时走常见默认分支兜底
    }
  }
  // 同一工作区的子仓库未必都有显式基线，统一用常见默认分支兜底
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (!candidates.includes(ref)) candidates.push(ref)
  }
  for (const ref of candidates) {
    try {
      const out = (await git(dir, ["merge-base", ref, "HEAD"])).trim()
      if (out) return out
    } catch {
      // 尝试下一个候选
    }
  }
  return null
}

const MAX_UNTRACKED_DIFF_FILES = 50

/**
 * `git diff` 不包含未跟踪文件，这里为每个未跟踪文件用
 * `git diff --no-index -- /dev/null <file>` 构造标准的新增文件 patch。
 */
async function collectUntrackedDiff(dir: string, context: number): Promise<DiffInfo[]> {
  const result: DiffInfo[] = []
  const files = await listUntracked(dir)
  for (const file of files.slice(0, MAX_UNTRACKED_DIFF_FILES)) {
    try {
      const full = path.join(dir, file)
      const stat = await fsp.stat(full)
      if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) continue
      const text = await gitAllowFailure(dir, ["diff", "--no-index", `-U${context}`, "--", "/dev/null", file])
      result.push(...parsePatch(text))
    } catch (error) {
      log("untracked diff failed", { dir, file, error: String(error) })
    }
  }
  return result
}

/** 同一文件可能同时出现在 staged 与 unstaged 两段 diff 里，按文件合并避免重复条目。 */
function mergeDiffs(list: DiffInfo[]): DiffInfo[] {
  const map = new Map<string, DiffInfo>()
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

async function collectDiff(
  dir: string,
  mode: DiffInput["mode"],
  base: string | undefined,
  context: number,
): Promise<DiffInfo[]> {
  const common = ["--no-color", `-U${context}`]
  let text: string
  if (mode === "working") {
    try {
      text = await git(dir, ["diff", ...common, "HEAD", "--"])
    } catch (error) {
      if (!isMissingHead(error)) {
        log("diff failed", { dir, mode, error: String(error) })
        return []
      }
      // 空仓库（没有任何提交）：HEAD 不存在，退化为
      // 空树↔index（已暂存）+ index↔worktree（未暂存），未跟踪文件另行收集。
      log("diff HEAD missing, fallback to index/worktree", { dir })
      const parts = [
        await gitTextOrEmpty(dir, ["diff", ...common, "--cached", "--"]),
        await gitTextOrEmpty(dir, ["diff", ...common, "--"]),
      ]
      text = parts.join("\n")
    }
  } else {
    const merged = await resolveMergeBase(dir, base)
    if (!merged) return []
    const args =
      mode === "branch"
        ? ["diff", ...common, merged, "--"]
        : ["diff", ...common, `${merged}..HEAD`, "--"]
    try {
      text = await git(dir, args)
    } catch (error) {
      log("diff failed", { dir, mode, error: String(error) })
      return []
    }
  }
  const diffs = mergeDiffs(parsePatch(text))
  if (mode === "working") {
    const untracked = await collectUntrackedDiff(dir, context)
    return mergeDiffs([...diffs, ...untracked])
  }
  return diffs
}

async function aggregateDiff(input: DiffInput): Promise<DiffInfo[]> {
  const all: DiffInfo[] = []
  all.push(...(await collectDiff(input.worktree, input.mode, input.base, input.context)))
  for (const repo of discoverChildRepos(input.worktree)) {
    const list = await collectDiff(repo.dir, input.mode, input.base, input.context)
    for (const item of list) {
      all.push({ ...item, file: `${CODESPACE_DIR}/${repo.name}/${item.file}` })
    }
  }

  const limit = input.maxOutputBytes > 0 ? input.maxOutputBytes : Number.POSITIVE_INFINITY
  const result: DiffInfo[] = []
  let total = 0
  for (const item of all) {
    if (total >= limit) break
    let patch = item.patch
    if (total + patch.length > limit) patch = patch.slice(0, Math.max(0, limit - total))
    result.push({ ...item, patch })
    total += patch.length
  }
  return result
}

async function currentBranch(dir: string): Promise<string | undefined> {
  try {
    const value = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
    return value === "HEAD" ? undefined : value
  } catch {
    return undefined
  }
}

async function defaultBranch(dir: string): Promise<string | undefined> {
  try {
    const ref = (await git(dir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).trim()
    return ref.replace(/^refs\/remotes\//, "").replace(/^origin\//, "")
  } catch {
    return undefined
  }
}

async function listBranches(dir: string, input: BranchesInput): Promise<string[]> {
  try {
    const out = await git(dir, ["branch", "--all", "--format=%(refname:short)"])
    let branches = out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    if (input.search) {
      const needle = input.search.toLowerCase()
      branches = branches.filter((branch) => branch.toLowerCase().includes(needle))
    }
    if (input.limit && input.limit > 0) branches = branches.slice(0, input.limit)
    return branches
  } catch {
    return []
  }
}

/**
 * 2.1.0+ 的审阅基线（`GET /api/vcs/base`）：
 * 优先按分支创建历史（reflog）推断，其次回落到仓库默认分支；
 * detached HEAD / 空仓库 / 无法确定时返回 null。
 *
 * 返回的是**分支名/引用**而不是 merge-base commit，
 * 这样根仓库和每个 `.codespace` 子仓库都能各自解析自己的基线。
 */
type ReviewBase = { name: string; ref: string; source: "reflog" | "default" }

async function refExists(dir: string, ref: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
    return true
  } catch {
    return false
  }
}

async function branchCreatedFrom(dir: string, branch: string): Promise<string | null> {
  try {
    const out = await git(dir, ["reflog", "show", "--format=%gs", branch])
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

async function reviewBase(dir: string): Promise<ReviewBase | null> {
  const current = await currentBranch(dir)
  if (!current) return null

  const detected = await defaultBranch(dir)
  const names = detected ? [detected] : ["main", "master"]
  let defaultName: string | undefined
  let defaultRef: string | undefined
  for (const name of names) {
    if (await refExists(dir, `origin/${name}`)) {
      defaultName = name
      defaultRef = `origin/${name}`
      break
    }
    if (await refExists(dir, name)) {
      defaultName = name
      defaultRef = name
      break
    }
  }
  const fallback: ReviewBase | null =
    defaultName && defaultRef ? { name: defaultName, ref: defaultRef, source: "default" } : null

  // 当前就在默认分支上：基线即默认分支本身
  if (defaultName && current === defaultName) return fallback

  const from = await branchCreatedFrom(dir, current)
  if (from) {
    const candidates = from.startsWith("origin/") ? [from, from.slice("origin/".length)] : [from, `origin/${from}`]
    for (const ref of candidates) {
      if (await refExists(dir, ref)) {
        return { name: ref.replace(/^origin\//, ""), ref, source: "reflog" }
      }
    }
  }

  return fallback
}

export default Plugin.define({
  id: "multi-repo-vcs",
  async setup(ctx) {
    log("setup start", { location: ctx.location.directory })
    await ctx.vcs.transform((editor) => {
      editor.add({
        id: PROVIDER_ID,
        name: "Multi-repo Git",
        info: async (input) => ({
          provider: PROVIDER_ID,
          branch: {
            current: await currentBranch(input.worktree),
            default: await defaultBranch(input.worktree),
          },
        }),
        branches: async (input) => listBranches(input.worktree, input),
        base: async (input) => {
          try {
            const base = await reviewBase(input.worktree)
            log("base served", { base })
            return base
          } catch (error) {
            log("base failed", String(error))
            return null
          }
        },
        status: async (input) => {
          try {
            const items = await collectStatus(input.worktree)
            log("status served", { count: items.length, worktree: input.worktree })
            return items
          } catch (error) {
            log("status failed", String(error))
            return []
          }
        },
        diff: async (input) => {
          try {
            const items = await aggregateDiff(input)
            log("diff served", { count: items.length, mode: input.mode })
            return items
          } catch (error) {
            log("diff failed", String(error))
            return []
          }
        },
      })
      editor.default.set(PROVIDER_ID)
    })
    log("setup done", { provider: PROVIDER_ID })
    return () => {
      log("cleanup")
    }
  },
})
