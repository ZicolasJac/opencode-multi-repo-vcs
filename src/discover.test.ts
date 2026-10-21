import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "./config.ts"
import { discoverRepos } from "./discover.ts"
import { createLogger } from "./log.ts"
import type { Config } from "./types.ts"

const logger = createLogger("off")

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "multi-repo-vcs-"))
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q")
  git(dir, "config", "user.email", "test@example.com")
  git(dir, "config", "user.name", "test")
}

function config(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides }
}

function prefixes(dir: string, cfg: Config): string[] {
  return discoverRepos(dir, cfg, logger).map((repo) => repo.prefix)
}

test("discover: root + nested repos within depth", () => {
  const root = tempDir()
  try {
    initRepo(root)
    initRepo(path.join(root, ".codespace", "repo-a"))
    initRepo(path.join(root, "packages", "repo-b"))

    const found = discoverRepos(root, config({ depth: 2 }), logger)
    assert.deepEqual(
      found.map((repo) => repo.prefix),
      ["", ".codespace/repo-a", "packages/repo-b"],
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("discover: depth 1 only sees direct children", () => {
  const root = tempDir()
  try {
    initRepo(root)
    initRepo(path.join(root, "repo-top"))
    initRepo(path.join(root, ".codespace", "repo-a"))

    assert.deepEqual(prefixes(root, config({ depth: 1 })), ["", "repo-top"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("discover: ignoreDirs skips matching directory names", () => {
  const root = tempDir()
  try {
    initRepo(root)
    initRepo(path.join(root, "node_modules", "repo-x"))

    assert.deepEqual(prefixes(root, config({ depth: 2 })), [""])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("discover: scanRoots supports strings and per-root depth", () => {
  const root = tempDir()
  try {
    initRepo(root)
    initRepo(path.join(root, "deep", "one", "two", "repo-d"))
    initRepo(path.join(root, ".codespace", "repo-a"))

    const found = prefixes(
      root,
      config({
        depth: 1,
        scanRoots: [
          { path: ".codespace", depth: 1 },
          { path: "deep", depth: 3 },
        ],
      }),
    )
    assert.deepEqual(found, ["", ".codespace/repo-a", "deep/one/two/repo-d"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("discover: scanRoot can point directly at a repo", () => {
  const root = tempDir()
  try {
    initRepo(root)
    initRepo(path.join(root, ".codespace", "repo-a"))

    const found = prefixes(root, config({ depth: 0, scanRoots: [{ path: ".codespace/repo-a", depth: 0 }] }))
    assert.deepEqual(found, ["", ".codespace/repo-a"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("discover: scanRoot outside workspace is ignored", () => {
  const base = tempDir()
  const root = path.join(base, "workspace")
  const outside = path.join(base, "outside")
  try {
    initRepo(root)
    initRepo(outside)

    const found = prefixes(root, config({ scanRoots: [{ path: "../outside", depth: 0 }] }))
    assert.deepEqual(found, [""])
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test("discover: non-repo root still aggregates children", () => {
  const root = tempDir()
  try {
    initRepo(path.join(root, ".codespace", "repo-a"))

    assert.deepEqual(prefixes(root, config({ depth: 2 })), [".codespace/repo-a"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
