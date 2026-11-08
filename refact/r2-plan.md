# R2 实施计划（v1）

> 基线：`develop` @ `e41a060`（R1 收口后）
> 依据：`refact/GUIDE.MD` §6/§8/§11、ADR-006、ADR-007
> 拆法：R2a（Worktree，必须）+ R2b（调度器迁 Go，可延到 R3）

## 1. 五个已定决策

### D1. Worktree 路径与校验

GUIDE §6.2 同时写了「路径在 `<repo>/.worktrees/`」和「目标路径不在 repo 内」，二者矛盾。

落地：

```text
path    <repo>/.worktrees/task-<slug>/
branch  pidesk/task-<slug>
base    默认 HEAD，或用户显式指定 ref
```

校验改为：

- 路径必须落在 `<repo>/.worktrees/` 下（`filepath.Rel` 不允许 `..`）；
- 通过 `git rev-parse --git-path info/exclude` 写入 `/.worktrees/`，不改仓库 `.gitignore`；
- 不新增 `Location.Kind=worktree`，worktree 仍是 `KindLocal`，靠 `parentWorkspaceId` 分组。

### D2. Worktree 适用范围

只对**显式选择「隔离运行」的新 Task / 显式重试**生效，不迁移现有聊天 thread。

原因：Pi session 头部记录 CWD，把旧 thread 直接指向 worktree 会被
`SaveDesktopState` 的「session cwd == workspace path」校验拒绝
（`internal/appservice/catalog.go:555` 附近）。

- 同一 Task 的多次 Run 复用同一个 worktree；
- 新 Task 新建 worktree；
- legacy 聊天 Task 的重试仍留在原 workspace。

### D3. state.json 不升版本

`internal/workspace/catalog.go:20` 是 `stateVersion=6`，`:586` 对 `>6` 直接拒绝。
升到 7 会让旧版本无法回滚。

只加 `omitempty` 字段：

```text
Record.ParentWorkspaceID
Record.WorktreeBranch
Record.WorktreeTaskID
WorkspaceSummary.ParentWorkspaceID
```

`Location.Kind` 继续保持 `local`。

### D4. 调度器数据权

- SQLite `task_schedules` 是唯一真相；
- `state.json.desktop.scheduledTasks` 只做一次性导入与回滚导出；
- Go 运行时**不写** state.json 的 desktop：前端 `persistDesktopState` 会整份覆盖
  （`frontend/src/stores/app.ts:4605` / `:4680`）；
- 关闭 R2b 开关前先执行 `schedule export`，再做回滚演练。

### D5. 定时 Run 的会话身份

每个 schedule 对应一个 Task + 一个占位 thread/session，后续 Run 复用同一个 session，
不再每次新建 thread。

- 避免 Go 运行时改 catalog；
- 避免 `lastThreadId` 频繁变化；
- 与 GUIDE「Run ≠ Session」一致。

新建 schedule 时由前端先建 thread，再调用 `ScheduleService.SaveSchedule`；
导入旧 schedule 时，在窗口加载前补占位 thread（`StartHarness` 早于前端加载）。

## 2. 工作包

### P0 设计定稿 [~2–3d]

- 本文件；
- 临时 git repo 测试夹具；
- 明确 D1–D5，冻结 R2a 范围。

### P1 `internal/worktree` 内核 [~4–5d]

- `Create / List / Remove / Prune / Status`；
- 用 `internal/gitexec.Runner`，不引 go-git；
- 分支 `pidesk/task-<slug>`，路径 `<repo>/.worktrees/task-<slug>`；
- 删除前检查 dirty / untracked / 未合并提交；
- 不干净标 `orphaned`，不自动删分支；
- 路径前缀 + 不跟随软链 + `EvalSymlinks` 校验；
- 单测覆盖分支冲突、base ref、dirty、未合并提交、路径逃逸。

### P2 子 workspace 注册与 UI [~5–7d]

- `workspace.Record` 加 `ParentWorkspaceID` / `WorktreeBranch` / `WorktreeTaskID`；
- `Catalog.AddWorktree(parentID, path, trust)`，父子信任派生；
- `WorkspaceSummary` 透传 `parentWorkspaceId`；
- 侧栏按父 workspace 分组，worktree 子项默认折叠；
- 文件树仍按 `workspaceId` 独立 key；
- Terminal/Git/Diff 继续走 `workspaceId + workspacePath`，注册子 workspace 后即可工作；
- 远程 workspace 隐藏 worktree 入口并明确报错。

### P3 Bootstrap [~2–3d]

- 配置放 `~/.pi-desk/config.json`（ADR-006 open question）；
- 支持 `none / copy / symlink / command`，默认 `none`；
- 只复制显式 allowlist，不自动复制 `.env`/密钥；
- `command` 失败必须让 Run 失败并给出缺什么；
- 首次为 workspace 创建 worktree 时询问策略，之后复用。

### P4 调度器数据面 [~3–4d]

- migration 003：`task_schedules` + `task_worktrees`；
- `task_schedules` 保留 prompt、model、thinking、frequency/time/weekday/runAt、
  enabled、next/last run、last status/error；
- 导入 `state.json.desktop.scheduledTasks`：备份、幂等、失败回滚事务；
- 新增 `internal/schedule` + `ScheduleService`；
- `TaskService` 补 `CreateTask`。

### P5 调度器运行时 [~5–7d]

- Go ticker（15–30s），启动时先 `ReconcileInterruptedRuns`；
- 触发路径复用 `TaskService.RetryTask` 已验证链路：
  `StartSession` → `SetModel` / `SetThinkingLevel` → `CreateRun` → `SendPrompt`；
- 退出期间到期 → 下次启动只补一次；
- 0–30s 抖动，同时最多 3 个，超出排队；
- 无 `catch_up` 或超出批次 → 标 `missed` 并通知；
- `once` 触发后自动 disable；手动 Run 不推进 `next_run_at`；
- 已有 active Run 时跳过并记 `skipped`；
- 前端 `ScheduledTasksPage` 改读 `ScheduleService`，开关打开时停掉
  `startScheduledTaskScheduler`（`frontend/src/stores/scheduledTaskActions.ts:44`）。

### P6 收口 [~3–4d]

- 沙箱 A/B、回滚演练、文档、默认开关；
- bindings 生成与 CI 比对；
- `go test ./... -race`、`npm run typecheck/test/build`。

## 3. 开关

```text
PI_DESK_R2_WORKTREE=1 / 0     默认 1；=0 隐藏 worktree 入口
PI_DESK_R2_SCHEDULER=1 / 0    默认 1；=0 回前端定时器
```

两个开关都进 `BootstrapState`，前端据此隐藏入口，不靠 localStorage。

## 4. 验收

```bash
go test -race ./internal/worktree ./internal/schedule ./internal/storage/sqlite ./internal/appservice
go vet ./...
cd frontend && npm run typecheck && npm run test && npm run build
wails3 generate bindings -f '' -clean=true -ts -i
git diff --exit-code -- frontend/bindings
```

场景：

- 同一 repo 两个隔离 Task 并行写文件，互不覆盖；
- 删除 clean worktree 成功；dirty / 未合并 → orphaned；
- 缺依赖时 `none` 下 Run 失败并提示，`command` 下成功；
- 子 workspace 的文件树展开态、终端 cwd、Diff 都指向 worktree；
- 远程 workspace 创建 worktree 被拒绝；
- 退出 Pi Desk，跨过一个定时点，重启 → 补跑一次且只补一次；
- 5 个任务同时到期 → 抖动 + 最多 3 个并发，其余排队/标 missed；
- 重启后 `running` 的定时 Run 收敛为 failed；
- DST / 跨时区测试；
- 两个开关都 `=0` 时，聊天、旧定时任务、文件树与今天一致；
- 回滚演练：`schedule export` → 关开关 → 旧前端能看到 R2 期间新建的 schedule。

## 5. 不做

- 不升 `stateVersion`；
- 不给 `Location.Kind` 加 `worktree`；
- 不让 Go 运行时写 `state.json` 的 desktop；
- 不每个定时 Run 新建 thread；
- 不先删旧前端 scheduler；
- 不自动删除有未合并提交的 worktree 分支；
- 不做远程 worktree / Sandbox / 多 Runtime。
