import { execFile } from "node:child_process"

export type GitRunner = {
  /** 非零退出码视为错误 */
  run(cwd: string, args: string[], maxBuffer?: number): Promise<string>
  /** 忽略退出码，只取标准输出（`git diff --no-index` 有差异时退出码为 1） */
  allowFailure(cwd: string, args: string[], maxBuffer?: number): Promise<string>
}

const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024

/** 空仓库（unborn HEAD）没有 HEAD，`git diff HEAD` / `--numstat HEAD` 会报错。 */
export function isMissingHead(error: unknown): boolean {
  const text = String(error)
  return (
    text.includes("bad revision 'HEAD'") ||
    text.includes("unknown revision") ||
    text.includes("does not have any commits") ||
    text.includes("needed a single revision")
  )
}

export function createGit(binary: string): GitRunner {
  const base = ["-c", "core.quotepath=false"]
  return {
    run(cwd, args, maxBuffer = DEFAULT_MAX_BUFFER) {
      return new Promise((resolve, reject) => {
        execFile(
          binary,
          [...base, ...args],
          { cwd, maxBuffer, windowsHide: true, encoding: "utf8" },
          (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
        )
      })
    },
    allowFailure(cwd, args, maxBuffer = DEFAULT_MAX_BUFFER) {
      return new Promise((resolve) => {
        execFile(
          binary,
          [...base, ...args],
          { cwd, maxBuffer, windowsHide: true, encoding: "utf8" },
          (_error, stdout) => resolve(String(stdout ?? "")),
        )
      })
    },
  }
}
