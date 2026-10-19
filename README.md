# opencode-multi-repo-vcs

把工作区根仓库与 `.codespace/*` 下各独立 git 子仓库的未提交改动，聚合展示到 OpenCode 变更栏（Review 面板）。

- 插件 id：`multi-repo-vcs`
- VCS provider id：`multi-repo`
- 目标 OpenCode：V2（desktop 2.0.32 实测通过）

## 状态（2026-10-19）

MVP 已实现并在 D:\ai-workspace\jspg-data-labeling-aiws 试点通过 **API 层**实测：

| 验证项 | 结果 |
| --- | --- |
| 插件自动加载 | server 热发现（junction 目录），并订阅 `index.ts` / `src/index.ts` 源文件用于热重载 |
| provider 接管 | `GET /api/vcs` 返回 `provider: "multi-repo"`，`branch.current/default` 正确 |
| status 聚合 | 子仓库文件以 `.codespace/<repo>/` 前缀返回，`additions` 正确 |
| diff 路由 | 按前缀路由到子仓库，patch 生成正确（含 new file / hunk） |
| 清理恢复 | 测试产生的临时文件清理后，API 恢复空数组 |

UI 层观察项（人工确认）：

- [ ] 变更栏出现 `.codespace/<repo>/...` 条目并可展开查看 diff
- [ ] 变更后自动刷新（还是需要 Ctrl+R）——需要观察 `filesystem.changed` 事件是否覆盖 `.codespace`

## 工作原理

1. 通过插件 API `ctx.vcs.transform` 注册自定义 VCS provider（`multi-repo`），并以 `editor.default.set` 设为默认；
2. `status`：根仓库 + `.codespace/*` 下含 `.git` 的子仓库分别执行
   `git status --porcelain=v1 -z --untracked-files=all`，子仓库路径统一加前缀；
3. `diff`：按请求路径前缀路由到所属仓库，执行对应 mode（working / branch / committed）的 `git diff`；
4. `info` / `branches`：以根仓库为准，失败时容错返回。

## 接入方式

### 方式一：项目级（试点）

在工作区放一个 Junction 指向本项目：

```powershell
# 本机 Windows PowerShell 执行
New-Item -ItemType Directory -Path "D:\ai-workspace\jspg-data-labeling-aiws\.opencode\plugins" -Force
New-Item -ItemType Junction -Path "D:\ai-workspace\jspg-data-labeling-aiws\.opencode\plugins\multi-repo-vcs" -Target "D:\zjc-ai-workspace\opencode-multi-repo-vcs"
```

### 方式二：全局（所有工作区一次生效）

在 `C:\Users\Zicol\.config\opencode\opencode.json` 增加：

```jsonc
{
  "plugins": ["D:/zjc-ai-workspace/opencode-multi-repo-vcs"]
}
```

## 解除/回退

- 项目级：删除对应 `.opencode\plugins\multi-repo-vcs` Junction 即可；
- 全局：移除 `plugins` 里的对应条目；
- 插件对本机文件零写入（除自身 `.dev\plugin.log` 探针日志）。

## 已知限制

- **untracked 且未暂存（未 `git add`）的新文件不出现在 diff 结果里**（status 中可见，标 added）——git diff 不显示未跟踪文件；后续版本计划用构造 patch 的方式补齐；
- `/undo` 快照回滚不会覆盖子仓库文件（OpenCode 快照机制跳过 git-ignored 路径，与本插件无关，属官方 issue #30065）；
- 子仓库发现只扫描 `.codespace/*` 一层目录；
- `additions/deletions` 对超大未跟踪文件（>2MiB）计 0。

## 开发

- 入口：`index.ts`（转发）→ `src/index.ts`（实现）
- 安装依赖：`npm install`
- 类型来源：`@opencode/plugin@2.0.32`（与 OpenCode 版本对齐）
- 探针日志：`.dev/plugin.log`
- server 日志：`C:\Users\Zicol\.local\share\opencode\log\opencode.log`（搜索 `multi-repo-vcs`）
- 修改源码后 server 自动重载（watcher 已订阅），无需重启

## 验证命令（可复现）

```powershell
$cli="C:\Users\Zicol\AppData\Roaming\ai.opencode.desktop\cli\2.0.32-x64\opencode-cli.exe"
$loc="D%3A%5Cai-workspace%5Cjspg-data-labeling-aiws"

# provider 信息
& $cli api get "/api/vcs?location[directory]=$loc"

# 聚合后的变更列表
& $cli api get "/api/vcs/status?location[directory]=$loc"

# 聚合后的 diff
& $cli api get "/api/vcs/diff?location[directory]=$loc&mode=working&context=3"
```
