export type Logger = {
  debug(message: string, extra?: unknown): void
  error(message: string, extra?: unknown): void
}

const PREFIX = "[multi-repo-vcs]"

function format(message: string, extra?: unknown): string {
  const line = `${new Date().toISOString()} ${message}`
  return extra === undefined ? line : `${line} ${JSON.stringify(extra)}`
}

/**
 * `off` 只保留错误日志（低频、用于排障）；
 * `debug` 额外输出请求级细节。不写任何文件。
 */
export function createLogger(level: "off" | "debug"): Logger {
  const debugEnabled = level === "debug"
  return {
    debug(message, extra) {
      if (debugEnabled) console.log(`${PREFIX} ${format(message, extra)}`)
    },
    error(message, extra) {
      console.error(`${PREFIX} ${format(message, extra)}`)
    },
  }
}
