export type FileStatus = {
  file: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

export type FileDiff = FileStatus & {
  patch: string
}

export type Repo = {
  /** 仓库绝对路径 */
  dir: string
  /** 相对工作区根的 POSIX 路径，根仓库为空串 */
  prefix: string
}

export type ScanRoot = {
  /** 相对工作区根的目录 */
  path: string
  /** 该起点向下扫描的层数 */
  depth: number
}

export type Config = {
  /** 默认起点（工作区根）的扫描深度 */
  depth: number
  /** 额外的扫描起点 */
  scanRoots: ScanRoot[]
  /** 扫描时跳过的目录名 */
  ignoreDirs: string[]
  /** 何时接管默认 VCS provider */
  takeover: "auto" | "always" | "never"
  /** git 可执行文件 */
  gitBinary: string
  /** 未跟踪文件 diff 数量上限 */
  maxUntrackedFiles: number
  /** 未跟踪文件 diff 字节上限 */
  maxUntrackedBytes: number
  /** 同时执行的 git 命令数 */
  concurrency: number
  /** 日志级别 */
  logLevel: "off" | "debug"
}
