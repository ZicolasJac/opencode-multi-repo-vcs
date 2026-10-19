# opencode-multi-repo-vcs — 实施计划

- **项目名**：`opencode-multi-repo-vcs`（中文称呼：多仓库变更统计插件）
- **插件 id**：`multi-repo-vcs`
- **目标目录**：`D:\zjc-ai-workspace\opencode-multi-repo-vcs`
- **创建日期**：2026-10-19
- **状态**：待开发（本文件在 Plan 模式下暂存于 `C:\Users\Zicol\.opencode\plan\`，切换到非 Plan 模式后复制到目标目录并开始开发）

---

## 1. 背景与目标

### 1.1 问题

OpenCode Desktop 的变更栏（Review 面板）只统计**根仓库**的 git 改动。工作区内 `.codespace/` 目录下的多个独立 git 仓库（如 `jspg-cvat`、`jspg-cvat-model-factory`）的改动永远不会出现在变更栏里。

### 1.2 根因（已在 2.0.32 上核实）

- 变更栏的文件列表来自 `GET /api/vcs/status`（根仓库 git status 视角），文件 diff 来自 `GET /api/vcs/diff`（代码中可见 "[session-review] failed to load bounded vcs diff" 等调用点）；
- `D:\ai-workspace\jspg-data-labeling-aiws\.gitignore` 第 1 行是 `.codespace/`（`git check-ignore -v` 验证命中）；
- `.codespace/jspg-cvat`、`.codespace/jspg-cvat-model-factory` 是独立 git 仓库（各自有 `.git`）；
- 实测：根仓库 `git status` 输出 5 改 + 1 新增 = 6 个文件，与界面"6 个文件已更改"逐条一致；而 `jspg-cvat` 内部另有 3 个文件改动，界面完全不可见；
- 官方已知相关 issue：#10658（submodule 改动不进 review）、#15798、#30065（/undo 不回滚嵌套仓库）。

### 1.3 目标与范围（MVP）

**做**：让变更栏列出 `.codespace/*` 子仓库的未提交改动，并支持查看文件 diff。

**不做（本期）**：
- `/undo` / 快照回滚这些文件（快照机制跳过 git-ignored 文件，属官方 issue，插件 API 覆盖不到）；
- 缓存与性能深度优化、branch/committed diff 模式的精调、发布 npm 包、自动读 `CBB-WORKSPACE.json`。

---

## 2. 项目信息

### 2.1 目录结构（目标）

```
D:\zjc-ai-workspace\opencode-multi-repo-vcs\
  ├─ PLAN.md          ← 本文件
  ├─ src\
  │   └─ index.ts     ← 插件入口（MVP 单文件，零第三方依赖）
  └─ README.md        ← 说明 + 实测记录（开发中补充）
```

### 2.2 运行与加载机制（V2 官方文档已确认）

- 插件运行在 OpenCode 后台服务（Bun 运行时）中，spawn 子进程执行 git 命令；
- 加载方式二选一：
  - **A（推荐，开发与运行分离）**：在全局配置 `C:\Users\Zicol\.config\opencode\opencode.json` 的 `plugins` 数组里添加绝对路径引用，例如 `"D:/zjc-ai-workspace/opencode-multi-repo-vcs"`；
  - **B（即装即用）**：全局插件发现目录 `C:\Users\Zicol\.config\opencode\plugins\` 下直接放插件目录（自动发现）；
- 全局配置 `plugins` 数组为新版字段（现有配置里是 V1 的 `"plugin": []`，接入时需确认字段差异）；
- 修改 watched 配置目录可自动重载；必要时 `opencode service restart`。

---

## 3. 验收标准（MVP）

1. 在 `D:\ai-workspace\jspg-data-labeling-aiws\.codespace\jspg-cvat` 修改一个文件后，变更栏出现类似 `.codespace/jspg-cvat/cvat/apps/models_manager/views.py` 的条目；
2. 点击该条目能看到 diff 内容；
3. 记录"自动实时出现"还是"需要手动 Ctrl+R"（两种都算通过，结论影响后续优化）。

**回退**：删除插件目录（或移除配置引用）即恢复原状，零破坏性。

---

## 4. 技术方案

### 4.1 扩展点

```ts
await ctx.vcs.transform((editor) => {
  editor.add({
    id: "multi-repo",
    name: "Multi-repo Git",
    info: async () => /* { branch: { current, default } } */,
    branches: async (input, { signal }) => /* string[] */,
    status: async (scope, { signal }) => /* Vcs.FileStatus[] */,
    diff: async (input, { signal }) => /* FileDiff（结构实施时与内置 provider 输出对照核对） */,
  })
  editor.default.set("multi-repo")
})
```

- `Vcs.FileStatus` = `{ file, additions, deletions, status: "added" | "deleted" | "modified" }`（来自 API schema）；
- `scope` 提供工作区根（worktree）等上下文。

### 4.2 status 聚合

1. 对根仓库执行 `git status --porcelain=v2 -z --untracked-files=all`；
2. 扫描 `<工作区>\.codespace\*` 中含 `.git` 的子目录（进程内缓存）；对每个子仓库执行同样命令；
3. 子仓库文件路径加前缀：`.codespace/<仓库名>/<相对路径>`；
4. 状态映射：`A→added`、`D→deleted`、`M→modified`、`R/C→modified`、`??→added`；
5. `additions/deletions`：用 `git diff --numstat HEAD` 等补齐（untracked 单独处理，MVP 可先给 0，看 UI 表现再决定是否精确）。

### 4.3 diff 路由

- 按请求的 `file` 前缀判断所属仓库：`.codespace/<名字>/` → 对应子仓库；否则根仓库；
- mode 映射（`-U<context>` 控制上下文行数）：
  - `working` → `git diff -U<n> HEAD -- <path>`
  - `branch` → `git diff -U<n> <merge-base(base, HEAD)> -- <path>`
  - `committed` → `git diff -U<n> <base>..HEAD -- <path>`
- 未跟踪文件（`??`）需特殊处理（`git diff --no-index` 或读取内容构造新增 diff）。

### 4.4 info / branches

- 均以根仓库为准；任何 git 命令失败不得抛错阻塞 UI，返回空值并记录日志。

### 4.5 路径与编码

- 全程用进程参数数组直传（不经 shell）、`--` 分隔路径，避免注入与转义问题；
- 工作区文件名为中文/含空格（如 `docs/prompts/救生衣标注提示词.md`），git 输出统一为正斜杠相对路径，保持一致；
- Windows 下注意路径分隔符归一化。

---

## 5. 实施步骤

- [ ] 1. **前置小实验（直通骨架）**：写"直通版" provider（status/diff 全转发内置 Git 行为），验证插件被加载、provider 被选中、变更栏显示与现状一致；打通 `import { Plugin } from "@opencode/plugin"` 的加载方式。
- [ ] 2. **子仓库发现**：扫描 `.codespace\*`，进程内缓存。
- [ ] 3. **status 聚合**：根仓库 + 子仓库，路径前缀映射。
- [ ] 4. **diff 路由**：按前缀路由到对应仓库执行 git diff；与内置输出格式对照核对。
- [ ] 5. **info / branches 容错**：失败返回空值。
- [ ] 6. **实测三个验证点（E1–E3）**并记录。
- [ ] 7. **打磨与推广**：加秒级缓存；确定分发方式（独立目录 + 全局 `plugins` 引用，或复制到其它工作区）。

---

## 6. 关键验证点

| 编号 | 验证内容 | 不通过的后果 |
|---|---|---|
| E1 | 修改 `.codespace` 子仓库文件后，变更栏是否**自动实时**出现（文件监视器是否覆盖 git-ignored 目录） | 不自动 → "手动 Ctrl+R 后可见"，仍可用 |
| E2 | 带 `.codespace/` 前缀的条目点击后能否正常预览、diff 能否显示 | 不能 → 调整路径映射策略 |
| E3 | `status` 响应速度（每个仓库一次 git 命令；试点 2 个子仓库，开销可忽略） | 慢 → 升级缓存策略 |

---

## 7. 边界、风险与回退

- **不解决**：`/undo` 回滚子仓库文件（快照机制与插件 API 无关）。
- **风险与对策**：
  - 插件 bug 影响正常变更栏 → 每步增量验证；回退 = 删目录/移除引用；
  - `FileDiff` 输出结构不符 → 以"直通骨架"的输出为参照逐字段对齐；
  - git 命令注入 → 参数数组直传、`--` 分隔，不拼 shell 字符串。

---

## 8. 交付物

1. `src\index.ts` 插件源码（MVP 单文件）；
2. E1–E3 实测记录（README.md 内一节）；
3. 接入说明（全局配置 `plugins` 引用方式）。

---

## 9. 试点与推广

- **试点工作区**：`D:\ai-workspace\jspg-data-labeling-aiws`（含 `jspg-cvat`、`jspg-cvat-model-factory` 两个子仓库）；
- **同构工作区（共 6 个，后续推广）**：
  1. `D:\ai-workspace\jspg-data-labeling-aiws`
  2. `D:\ai-workspace\jspg-edi-yth-aiws`
  3. `D:\ai-workspace\jsygt-aiws`
  4. `D:\ai-workspace\jsygt-openapi-aiws`
  5. `D:\ai-workspace\yzg-ai-security-aiws`
  6. `D:\zjc-ai-workspace\建业用户管理后台`（目录名以实际为准）
- **接入方式**：全局配置 `C:\Users\Zicol\.config\opencode\opencode.json` 添加 `plugins: ["D:/zjc-ai-workspace/opencode-multi-repo-vcs"]`。

---

## 10. 参考

- OpenCode V2 文档：
  - 插件开发（含 VCS 扩展点）：https://opencode.ai/v2/docs/build/plugins
  - 插件配置与全局发现目录：https://opencode.ai/v2/docs/plugins
  - 配置（watcher 等）：https://opencode.ai/v2/docs/config
- 相关官方 issue：
  - #10658 Opencode Desktop - files touched in submodules aren't shown
  - #15798 windows desktop cannot flow git submodule's change
  - #30065 /undo does not revert changes inside nested independent git repositories
