import assert from "node:assert/strict"
import { test } from "node:test"
import { mergeDiffs, parsePatch } from "./diff.ts"
import { isNestedRepoEntry, parsePorcelain } from "./status.ts"

test("parsePorcelain: handles NUL records, renames and staged files", () => {
  const out = "?? a.txt\0 M b.txt\0R  new.txt\0old.txt\0A  staged.txt\0"
  assert.deepEqual(parsePorcelain(out), [
    { file: "a.txt", xy: "??" },
    { file: "b.txt", xy: " M" },
    { file: "new.txt", xy: "R " },
    { file: "staged.txt", xy: "A " },
  ])
})

test("parsePatch: modified / added / deleted", () => {
  const text = [
    "diff --git a/a.txt b/a.txt",
    "index 1111111..2222222 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,1 +1,2 @@",
    " old",
    "+new",
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1 @@",
    "+hello",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "index 4444444..0000000",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
  ].join("\n")

  const diffs = parsePatch(text)
  assert.equal(diffs.length, 3)
  assert.deepEqual(
    diffs.map((diff) => [diff.file, diff.status, diff.additions, diff.deletions]),
    [
      ["a.txt", "modified", 1, 0],
      ["new.txt", "added", 1, 0],
      ["gone.txt", "deleted", 0, 1],
    ],
  )
  assert.ok(diffs.every((diff) => diff.patch.startsWith("diff --git ")))
})

test("mergeDiffs: merges staged and unstaged parts of the same file", () => {
  const merged = mergeDiffs([
    {
      file: "a.txt",
      patch: "diff --git a/a.txt b/a.txt\n+staged",
      additions: 1,
      deletions: 0,
      status: "modified",
    },
    {
      file: "a.txt",
      patch: "diff --git a/a.txt b/a.txt\n+unstaged",
      additions: 2,
      deletions: 1,
      status: "modified",
    },
    {
      file: "b.txt",
      patch: "diff --git a/b.txt b/b.txt\n+new",
      additions: 1,
      deletions: 0,
      status: "added",
    },
  ])
  const a = merged.find((item) => item.file === "a.txt")
  assert.ok(a)
  assert.equal(a.additions, 3)
  assert.equal(a.deletions, 1)
  assert.ok(a.patch.includes("+staged"))
  assert.ok(a.patch.includes("+unstaged"))
  assert.equal(merged.length, 2)
})

test("isNestedRepoEntry: filters gitlink and untracked directory entries", () => {
  const prefixes = [".codespace/repo-a"]
  assert.equal(isNestedRepoEntry(".codespace/repo-a", prefixes), true)
  assert.equal(isNestedRepoEntry(".codespace/repo-a/", prefixes), true)
  assert.equal(isNestedRepoEntry(".codespace/", prefixes), true)
  assert.equal(isNestedRepoEntry("src/main.ts", prefixes), false)
  assert.equal(isNestedRepoEntry(".codespace/other", prefixes), false)
})
