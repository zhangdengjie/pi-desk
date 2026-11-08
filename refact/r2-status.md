# R2 实施状态（进行中）

- 分支：`feat/r2a-worktree-core`（已 `--no-ff` 合并进 `develop`，merge commit `1f75ce2`）
- 最近提交：`24156e4`
- 日期：2026-11-09
- 结论：**R2a 核心已落地，R2b 后端已落地；前端调度器切换与 bootstrap 尚未接完。**

## 1. 已完成

### P0 计划

- `refact/r2-plan.md` 写入 D1–D5 与 P0–P6 工作包。
- 决策：worktree 路径 `<repo>/.worktrees/task-<slug>`，`stateVersion` 不升，
  调度器 SQLite 为真相，Go 运行时不写 state.json desktop。

### P1 Worktree 内核

- `internal/worktree`：`Create / List / Remove / Prune / Status`。
- 分支 `pidesk/task-<slug>`，路径 `<repo>/.worktrees/task-<slug>`。
- `.git/info/exclude` 写入 `/.worktrees/`，不改 `.gitignore`。
- dirty / untracked / 未合并提交 → `Orphaned`，不自动删分支。
- 拒绝 linked worktree、非 git 目录、路径逃逸、`.worktrees` 软链逃逸。
- 临时 git repo 测试覆盖：create/reuse/list/remove、dirty、未合并、prune、
  exclude 幂等、子目录 repository、symlink 拒绝。

### P2 子 workspace 注册

- `workspace.Record` 新增 `ParentWorkspaceID` / `WorktreeBranch` / `WorktreeTaskID`，
  全部 `omitempty`；`stateVersion` 仍为 6。
- `Catalog.AddWorktree(parentID, path, branch, taskID)`：
  - 幂等；
  - 继承 parent trust 与默认 model/thinking；
  - 拒绝嵌套 worktree；
  - 父 workspace 删除时级联删除子 workspace、线程与定时任务；
  - 加载 state.json 时从 parent 重新派生 trust。
- `WorkspaceSummary` 透传 `parentWorkspaceId` / `worktreeBranch` / `worktreeTaskId`。
- `WorktreeService`（Wails）：`Enabled / Create / List / Remove / Prune`。
- 前端新任务对话框新增「在独立 worktree 中运行」：
  - 仅 `BootstrapState.r2Worktree = true` 时显示；
  - 创建线程前调用 `WorktreeService.Create`，把 thread 的 `workspaceId/path`
    指向子 workspace；
  - 文件树、终端、Diff 继续走 `workspaceId + workspacePath`，因此自动指向 worktree。
- bindings 已重新生成：18 services / 180 methods / 178 models。

### P4 调度器数据面

- migration 003：`task_schedules` + `task_worktrees`。
- `internal/schedule`：
  - `Schedule` / `Frequency` / `RunStatus`；
  - `Next` 与前端 `nextScheduledRun` 对齐（once/hourly/daily/weekdays/weekly）；
  - `Service` 校验、创建、更新、删除、due 查询、运行状态回写。
- `internal/storage/sqlite/schedules.go`：CRUD + due 查询 + NULL 时间处理。
- `importLegacySchedules`：一次性导入 `state.json.desktop.scheduledTasks`，
  按 schedule id 幂等，复用 `lastThreadId` 已导入的 Task。

### P5 调度器运行时

- `internal/scheduler`：
  - 30s ticker，启动先补跑；
  - 同时最多 3 个，超出排队；
  - 启动补跑 0–30s 抖动；
  - 到期后先推进 `nextRunAt`，再入队，避免同一行重复触发；
  - `once` 触发后 disable；
  - `missed` / `started` / `completed` / `failed` / `skipped` 状态；
  - `ErrBusy` → skipped。
- `ScheduledRunner`：
  - 复用 Task 的 thread/session；
  - `StartSession` → `CreateRun` → `StartRun` → `SetModel` → `SetThinkingLevel` → `SendPrompt`；
  - 失败时 `FinishRun(failed)` + Task failed + best-effort abort。
- 开关：`PI_DESK_R2_SCHEDULER=1` 时才启动 Go scheduler；默认仍是前端定时器。
- 启动时 `ReconcileInterruptedRuns` 已存在，Go scheduler 在其后启动。
- `ScheduleService`（Wails）：`Enabled / ListSchedules / SaveSchedule / DeleteSchedule / RunNow`；
  运行成功后先标 `started`，列表查询再按 Run 终态收敛 completed/failed/cancelled。
- `ScheduledTasksPage` 已在 `BootstrapState.r2Scheduler` 时切到 Go：
  - 新 schedule 先建占位 thread、`persistDesktopState`、`AdoptThread` 得到 Task；
  - 保存/删除/启停/手动运行都走 `ScheduleService`；
  - 旧前端 timer 在 Go 模式下不启动。
- Worktree bootstrap：`internal/worktree` 已支持 `none / copy / symlink / command`，
  默认 none；copy 只允许显式 allowlist，symlink 不跟随删除，command 失败带输出。
  尚未接 `~/.pi-desk/config.json` 与设置页。

## 2. 开关

```text
PI_DESK_R2_WORKTREE=1     显示新任务对话框的 worktree 选项；默认 0
PI_DESK_R2_SCHEDULER=1    启动 Go scheduler；默认 0（前端定时器继续工作）
```

两个开关都进入 `BootstrapState.r2Worktree` / `r2Scheduler`。

## 3. 尚未完成

```text
- ScheduleService 尚缺 export legacy（回滚导出）；Go 只处理已有 Task/Thread 的 schedule。
- Go scheduler 默认未开启；需要沙箱验收 + 回滚导出后才能默认 1。
- 旧 `state.json` schedule 在 Go 模式下仍会被镜像写入，作为回滚快照；尚未做显式 export 命令。
- worktree bootstrap 配置读取与设置页尚未接。
- worktree 归档 GC、孤儿清理 UI、启动扫描尚未接。
- 侧栏尚未把 worktree 子项折叠到父 workspace 下；目前是独立 workspace group。
- Worktree 与 Task/Run 的绑定使用 thread id（首个 Prompt 后 Task id 才生成），
  后续需要把 `task_worktrees` 表接上。
- 远程 workspace 的 worktree/scheduler 明确拒绝，已验证 worktree；scheduler 走现有 local 检查。
- 未跑沙箱 C 档交互验收；仅完成 Go/前端单测、typecheck、build。
```

## 4. 验证命令

```bash
cd ~/develop/git/github/pi-desk
TMPDIR=/tmp go test ./...
go vet ./...

cd frontend
npm run typecheck
npm run test
npm run build

cd ..
~/go/bin/wails3 generate bindings -f '' -clean=true -ts -i
git diff --exit-code -- frontend/bindings
```

沙箱（需要显式开开关）：

```bash
PI_DESK_R2_WORKTREE=1 ./.pi/bin/dev-sandbox.sh
pidesk-shot --raise /tmp/r2-worktree.png
./.pi/bin/dev-sandbox.sh stop
```

## 5. 下一步（按顺序）

1. 实现 `ScheduleService`（List/Save/Delete/Export），前端 `ScheduledTasksPage` 在
   `bootstrap.r2Scheduler` 时改读 Go。
2. 建 schedule 时由前端创建占位 thread + `AdoptThread`，把 Task/Thread 绑定写进
   `task_schedules`；Go 只在已有 thread 上起 Run。
3. 补 worktree bootstrap 与归档 GC；接 `task_worktrees` 表。
4. 侧栏按 `parentWorkspaceId` 折叠子项。
5. 沙箱 A/B + 真机 C 档验收，再决定两个开关默认值。
