import { Plugin } from "@opencode/plugin"
import { currentBranch, defaultBranch, listBranches, reviewBase } from "./base.ts"
import { parseConfig } from "./config.ts"
import { aggregateDiff } from "./diff.ts"
import { discoverRepos } from "./discover.ts"
import { createGit } from "./git.ts"
import { createLogger } from "./log.ts"
import { collectStatus } from "./status.ts"

const PROVIDER_ID = "multi-repo"

export default Plugin.define({
  id: "multi-repo-vcs",
  async setup(ctx) {
    const { config, warnings } = parseConfig(ctx.options)
    const logger = createLogger(config.logLevel)
    for (const warning of warnings) logger.debug(`config: ${warning}`)
    const git = createGit(config.gitBinary)

    await ctx.vcs.transform((editor) => {
      editor.add({
        id: PROVIDER_ID,
        name: "Multi-repo Git",
        info: async (input) => ({
          provider: PROVIDER_ID,
          branch: {
            current: await currentBranch(git, input.worktree),
            default: await defaultBranch(git, input.worktree),
          },
        }),
        branches: async (input) => listBranches(git, input.worktree, input.search, input.limit),
        base: async (input) => {
          try {
            return await reviewBase(git, input.worktree)
          } catch (error) {
            logger.error("base failed", { error: String(error) })
            return null
          }
        },
        status: async (input) => {
          try {
            const repos = discoverRepos(input.worktree, config, logger)
            const items = await collectStatus(input.worktree, repos, git, config, logger)
            logger.debug("status served", { count: items.length, worktree: input.worktree })
            return items
          } catch (error) {
            logger.error("status failed", { error: String(error) })
            return []
          }
        },
        diff: async (input) => {
          try {
            const repos = discoverRepos(input.worktree, config, logger)
            const items = await aggregateDiff(
              {
                worktree: input.worktree,
                mode: input.mode,
                base: input.base,
                context: input.context,
                maxOutputBytes: input.maxOutputBytes,
              },
              repos,
              git,
              config,
              logger,
            )
            logger.debug("diff served", { count: items.length, mode: input.mode })
            return items
          } catch (error) {
            logger.error("diff failed", { error: String(error) })
            return []
          }
        },
      })

      // takeover: auto —— 只有发现子仓库时才接管默认 provider
      const repos = discoverRepos(ctx.location.directory, config, logger)
      const nested = repos.filter((repo) => repo.prefix !== "").length
      const takeover = config.takeover === "always" || (config.takeover === "auto" && nested > 0)
      if (takeover) editor.default.set(PROVIDER_ID)
      logger.debug("setup", { location: ctx.location.directory, nested, takeover })
    })

    return () => logger.debug("cleanup")
  },
})
