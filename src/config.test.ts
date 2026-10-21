import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_CONFIG, DEFAULT_DEPTH, DEFAULT_IGNORE_DIRS, parseConfig } from "./config.ts"

test("parseConfig: empty input uses defaults", () => {
  const { config, warnings } = parseConfig(undefined)
  assert.deepEqual(warnings, [])
  assert.equal(config.depth, DEFAULT_DEPTH)
  assert.equal(config.takeover, "auto")
  assert.equal(config.logLevel, "off")
  assert.deepEqual(config.ignoreDirs, DEFAULT_IGNORE_DIRS)
  assert.deepEqual(config.scanRoots, [])
})

test("parseConfig: invalid values fall back", () => {
  const { config } = parseConfig({
    depth: -1,
    takeover: "sometimes",
    concurrency: 0,
    maxUntrackedFiles: -5,
    maxUntrackedBytes: "big",
    logLevel: "verbose",
    ignoreDirs: [],
  })
  assert.equal(config.depth, DEFAULT_DEPTH)
  assert.equal(config.takeover, "auto")
  assert.equal(config.concurrency, DEFAULT_CONFIG.concurrency)
  assert.equal(config.maxUntrackedFiles, DEFAULT_CONFIG.maxUntrackedFiles)
  assert.equal(config.maxUntrackedBytes, DEFAULT_CONFIG.maxUntrackedBytes)
  assert.equal(config.logLevel, "off")
  assert.deepEqual(config.ignoreDirs, DEFAULT_IGNORE_DIRS)
})

test("parseConfig: scanRoots inherit and override depth", () => {
  const { config } = parseConfig({
    depth: 2,
    scanRoots: [".codespace", { path: "services", depth: 4 }, { path: "" }, 42],
  })
  assert.deepEqual(config.scanRoots, [
    { path: ".codespace", depth: 2 },
    { path: "services", depth: 4 },
  ])
})

test("parseConfig: values are clamped", () => {
  const { config } = parseConfig({ concurrency: 999, depth: 999 })
  assert.equal(config.concurrency, 16)
  assert.equal(config.depth, 32)
})

test("parseConfig: accepts explicit valid values", () => {
  const { config } = parseConfig({
    depth: 0,
    scanRoots: [{ path: ".codespace", depth: 0 }],
    ignoreDirs: ["node_modules"],
    takeover: "always",
    gitBinary: "/usr/bin/git",
    maxUntrackedFiles: 0,
    maxUntrackedBytes: 1024,
    concurrency: 2,
    logLevel: "debug",
  })
  assert.equal(config.depth, 0)
  assert.deepEqual(config.scanRoots, [{ path: ".codespace", depth: 0 }])
  assert.equal(config.takeover, "always")
  assert.equal(config.gitBinary, "/usr/bin/git")
  assert.equal(config.maxUntrackedFiles, 0)
  assert.equal(config.maxUntrackedBytes, 1024)
  assert.equal(config.concurrency, 2)
  assert.equal(config.logLevel, "debug")
})
