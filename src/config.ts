import type { Config, ScanRoot } from "./types.ts"

export const DEFAULT_IGNORE_DIRS = [
  ".git",
  ".worktrees",
  "node_modules",
  "dist",
  "build",
  "vendor",
  "target",
  "coverage",
]

export const DEFAULT_DEPTH = 2
export const DEFAULT_MAX_UNTRACKED_FILES = 50
export const DEFAULT_MAX_UNTRACKED_BYTES = 2 * 1024 * 1024
export const DEFAULT_CONCURRENCY = 4
const MAX_DEPTH = 32
const MAX_CONCURRENCY = 16

export const DEFAULT_CONFIG: Config = {
  depth: DEFAULT_DEPTH,
  scanRoots: [],
  ignoreDirs: DEFAULT_IGNORE_DIRS,
  takeover: "auto",
  gitBinary: "git",
  maxUntrackedFiles: DEFAULT_MAX_UNTRACKED_FILES,
  maxUntrackedBytes: DEFAULT_MAX_UNTRACKED_BYTES,
  concurrency: DEFAULT_CONCURRENCY,
  logLevel: "off",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function intInRange(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  const rounded = Math.trunc(value)
  if (rounded < min) return fallback
  return Math.min(rounded, max)
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  const list = value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
  return list.length > 0 ? list.map((item) => item.trim()) : fallback
}

function parseScanRoots(value: unknown, defaultDepth: number, warnings: string[]): ScanRoot[] {
  if (!Array.isArray(value)) return []
  const roots: ScanRoot[] = []
  for (const item of value) {
    if (typeof item === "string") {
      const path = item.trim()
      if (path) roots.push({ path, depth: defaultDepth })
      else warnings.push(`scanRoots 中存在空路径，已忽略`)
      continue
    }
    if (!isRecord(item)) {
      warnings.push(`scanRoots 中存在非字符串/非对象项，已忽略`)
      continue
    }
    const path = nonEmptyString(item.path, "")
    if (!path) {
      warnings.push(`scanRoots 中存在缺少 path 的项，已忽略`)
      continue
    }
    const depth =
      item.depth === undefined ? defaultDepth : intInRange(item.depth, defaultDepth, 0, MAX_DEPTH)
    roots.push({ path, depth })
  }
  return roots
}

/**
 * 解析 `opencode.json` 中 `plugins[].options`。
 * 所有非法值都回退默认，并返回 warnings 供 `logLevel: "debug"` 时输出。
 */
export function parseConfig(raw: unknown): { config: Config; warnings: string[] } {
  const warnings: string[] = []
  if (raw !== undefined && !isRecord(raw)) {
    warnings.push("插件 options 不是对象，已全部使用默认值")
    return { config: { ...DEFAULT_CONFIG }, warnings }
  }

  const input = isRecord(raw) ? raw : {}
  const depth = intInRange(input.depth, DEFAULT_DEPTH, 0, MAX_DEPTH)
  const takeover =
    input.takeover === "always" || input.takeover === "auto" || input.takeover === "never"
      ? input.takeover
      : DEFAULT_CONFIG.takeover
  if (input.takeover !== undefined && takeover !== input.takeover) {
    warnings.push(`takeover 只能是 auto/always/never，已回退 ${takeover}`)
  }
  const logLevel = input.logLevel === "debug" ? "debug" : "off"
  if (input.logLevel !== undefined && input.logLevel !== "debug" && input.logLevel !== "off") {
    warnings.push(`logLevel 只能是 off/debug，已回退 off`)
  }

  const config: Config = {
    depth,
    scanRoots: parseScanRoots(input.scanRoots, depth, warnings),
    ignoreDirs: stringList(input.ignoreDirs, DEFAULT_IGNORE_DIRS),
    takeover,
    gitBinary: nonEmptyString(input.gitBinary, DEFAULT_CONFIG.gitBinary),
    maxUntrackedFiles: intInRange(input.maxUntrackedFiles, DEFAULT_MAX_UNTRACKED_FILES, 0, 10000),
    maxUntrackedBytes: intInRange(
      input.maxUntrackedBytes,
      DEFAULT_MAX_UNTRACKED_BYTES,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    concurrency: intInRange(input.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
    logLevel,
  }

  return { config, warnings }
}
