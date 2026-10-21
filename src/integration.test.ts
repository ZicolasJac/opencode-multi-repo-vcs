import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "./config.ts"
import { aggregateDiff } from "./diff.ts"
import { discoverRepos } from "./discover.ts"
import { createGit } from "./git.ts"
import { createLogger } from "./log.ts"
import { collectStatus } from "./status.ts"

const logger = createLogger("off")
const git = createGit("git")

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "multi-repo-vcs-"))
}

function run(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

function initRepo(dir: string, commit: boolean): void {
  fs.mkdirSync(dir, { recursive: true })
  run(dir, "init", "-q")
  run(dir, "config", "user.email", "test@example.com")
  run(dir, "config", "user.name", "test")
  run(dir, "config", "core.autocrlf", "false")
  if (!commit) return
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n")
  run(dir, "add", ".")
  run(dir, "commit", "-q", "-m", "init")
}

function fixture() {
  const root = tempDir()
  initRepo(root, true)
  fs.writeFileSync(path.join(root, "base.txt"), "base\nchanged\n")

  // 空仓库：staged + untracked，用来覆盖 unborn HEAD 分支
  const empty = path.join(root, ".codespace", "empty")
  initRepo(empty, false)
  fs.writeFileSync(path.join(empty, "staged.txt"), "staged\n")
  run(empty, "add", "staged.txt")
  fs.writeFileSync(path.join(empty, "untracked.txt"), "untracked\n")

  return { root, empty }
}

test("collectStatus: aggregates nested repo changes and drops directory entries", async () => {
  const { root } = fixture()
  try {
    const repos = discoverRepos(root, DEFAULT_CONFIG, logger)
    const items = await collectStatus(root, repos, git, DEFAULT_CONFIG, logger)
    const files = items.map((item) => item.file)

    assert.ok(files.includes("base.txt"))
    assert.ok(files.includes(".codespace/empty/staged.txt"))
    assert.ok(files.includes(".codespace/empty/untracked.txt"))
    assert.ok(!files.includes(".codespace/"))
    assert.ok(!files.some((file) => file.startsWith(".codespace/empty/" ) && file.endsWith("/")))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("aggregateDiff: includes empty-repo staged and untracked files", async () => {
  const { root } = fixture()
  try {
    const repos = discoverRepos(root, DEFAULT_CONFIG, logger)
    const diffs = await aggregateDiff(
      { worktree: root, mode: "working", context: 3, maxOutputBytes: 10 * 1024 * 1024 },
      repos,
      git,
      DEFAULT_CONFIG,
      logger,
    )
    const files = diffs.map((item) => item.file)

    assert.ok(files.includes("base.txt"))
    assert.ok(files.includes(".codespace/empty/staged.txt"))
    assert.ok(files.includes(".codespace/empty/untracked.txt"))
    assert.ok(!files.includes(".codespace/"))
    for (const item of diffs) assert.ok(item.patch.startsWith("diff --git "))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("aggregateDiff: respects maxOutputBytes by file boundary", async () => {
  const { root } = fixture()
  try {
    const repos = discoverRepos(root, DEFAULT_CONFIG, logger)
    const diffs = await aggregateDiff(
      { worktree: root, mode: "working", context: 3, maxOutputBytes: 1 },
      repos,
      git,
      DEFAULT_CONFIG,
      logger,
    )
    assert.equal(diffs.length, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
