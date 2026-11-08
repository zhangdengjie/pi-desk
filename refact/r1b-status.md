# R1b 实施状态（第一刀：Task Center 只读）

- 日期：2026-11-08
- 分支：`feat/r1a-go-data-plane`
- 前提：`PI_DESK_HARNESS=1`；否则 Task Center 显示 disabled，不影响现有聊天。

## 已交付

```text
Go
  internal/domain/task.go          Task/Run/Event/Usage 的 Wails DTO
  internal/appservice/taskservice.go  TaskService：Enabled/ListTasks/GetTask/ListRunEvents/GetRunUsage
  internal/appservice/harness.go      Harness 暴露 task.Service
  main.go                             注册第 16 个 Wails service

Bindings
  frontend/bindings/.../taskservice.ts  5 个方法
  16 services / 164 methods / 167 models

Frontend
  services/tasks.ts               bindings 薄包装
  stores/tasks.ts                 tasks/detail/run/events 状态与 refresh/select
  components/TaskCenterPage.vue   列表 + 详情 + Run + 事件 + 用量（只读）
  AppSidebar / App.vue / app.ts    “任务”入口与页面路由
  i18n.ts                         en/zh 文案
```

## 验证

```bash
TMPDIR=/tmp go test ./...
cd frontend && npm run typecheck && npm run test && npm run build
```

烟测（`PI_DESK_HARNESS=1` + 沙箱）：

```text
harness: imported 425/425 legacy threads
窗口 title = Pi Desk · sandbox
Task Center 显示 425 个历史 Task；当前选中任务无 Run/事件（历史导入不造 Run）
截图：/tmp/r1b-task-center.png
```

## 第二刀：message/tool/retry 纯 reducer

```text
frontend/src/stores/events/piEvents.ts
  contentText / contentThinking / resultText / boundedToolOutput / tokenCount / messageTimestamp
  messageStartParts / messageEndParts
  toolStartFromPayload / toolProgressFromPayload
  retryStartFromPayload / retryEndFromPayload
frontend/src/stores/events/piEvents.test.ts
```

`handlePiEvent` 现在只负责编排：取状态、调用纯函数、写回 store。`app.ts` 从 5,115 行降到 5,058 行。

## 第三刀：session store

```text
frontend/src/stores/session.ts
  messagesByThread / activeAssistantByThread / waitingForOutputByThread
  currentAssistant / finishAssistant
frontend/src/utils/ids.ts
  createID / formatMessageTime / nowLabel
frontend/src/stores/app.ts
  三个同名 getter + action 包装，保持外部调用与测试不变
```

`app.ts` 从 5,058 行降到 5,028 行；`app.test.ts` 与组件测试全绿。

## 第四刀：workspace store

```text
frontend/src/stores/workspace.ts
  threads / workspaces / workspaceApplications / workspaceApplication
frontend/src/stores/app.ts
  四个同名 getter；写入改走 workspace store
测试：
  直接赋值改为 useWorkspaceStore().field = ...
  `$patch({threads/workspaces})` 统一走 patchApp() 适配器
```

`app.ts` 5,028 → 5,038 行；108 个测试文件全绿。

## 第五刀：normalized tool cards（灰度脚手架）

```text
frontend/src/services/agentEvents.ts
  onAgentEvent + AgentEvent
frontend/src/stores/app.ts
  useNormalizedEvents：默认 false；localStorage 键 `pidesk.useNormalizedEvents=1` 可开启
  handleAgentEvent：只接管 tool.started / tool.updated / tool.completed / tool.failed
  flag on 时 raw tool_execution_* 分支直接跳过
```

前提：Go 侧 `PI_DESK_HARNESS=1` 才会发 `agent:event`。当前只迁移工具卡，message/run 仍走 `pi:event`。

验证：109 个前端测试文件 / 1282 tests 通过；`useNormalizedEvents` 默认 false。

## 第六刀：normalized run.* + 清理 patchApp

```text
normalized run.started / run.updated / run.completed / run.cancelled / run.failed
  Go eventbus 信封增加 error 字段
  app.ts 抽出 applyRunStarted / applyRunUpdated / applyRunSettled / applyRuntimeExit
  flag on 时 raw agent_start/agent_end/agent_settled/runtime_exit 跳过
测试：
  删除全部 patchApp() 过渡函数（171 个调用点）
  直接使用 useWorkspaceStore().threads/workspaces = ...
```

`app.ts` 5,107 行；109 个测试文件 / 1283 tests 全绿。

## 第七刀：Task Center cancel / retry

```text
TaskService.CancelTask
  abort 当前 Pi turn；把 active Run 标 cancelled；Task 标 cancelled
TaskService.RetryTask
  仅 failed/cancelled；读取 Pi JSONL 最后一条 user 文本
  重开 Task → 新 Run → StartSession → StartRun → SendPrompt
  remote workspace 暂不支持
Task 状态机
  failed/cancelled → queued（显式 retry reopen）
FinishRun(failed/cancelled) 同步收敛 Task 状态
```

Task Center 详情页新增 Cancel / Retry 按钮；Wails 方法 166，绑定函数 154。

## 第八刀：normalized message + 状态继续拆 + 历史 Run

```text
normalized message.started / message.delta / message.completed
  app.ts 抽出 applyMessageStart / applyMessageUpdate / applyMessageEnd
  flag on 时 raw message_* 跳过

state stores
  stores/repository.ts  repositoryByWorkspace / treeExpanded / stale / generation
  stores/usage.ts       sessionStats / promptCache / compaction estimates
  stores/composer.ts    drafts / attachments / pendingPrompts / queue / pending model

历史 Task Run
  ImportLegacy 为带 sessionPath 的旧 thread 建一条 completed/failed Run
  已导入的 Task 也会在下次启动时补齐缺失的 legacy Run
```

`app.ts` 5,127 行；109 个测试文件 / 1285 tests 全绿。

## 本刀边界（下一刀）

```text
✅ 只读数据通路：Task/Run/Event/Usage 都能看到
✅ message/tool/retry 的纯 reducer 与测试
✅ session / workspace / repository / usage / composer 状态已拆
✅ normalized tool + run + message 事件（flag 默认 false）
✅ Task Center cancel / retry（remote 暂不支持）
✅ 历史导入 Task 的 Run 关联
✅ 真机 A/B：PI_DESK_HARNESS=1 vs +PI_DESK_NORMALIZED_EVENTS=1，工具卡/消息/run 无异常
✅ Task Center archive（未归档 / 已归档双视图）
✅ retry 重放最后一条 user 消息的图片
```

> 先做加法（Task Center），再做可测试的纯函数（message/tool/retry）；下一刀才是 5k 行 store 的结构拆分。

## 第九刀：archive + retry 图片

```text
Task Center archive
  migration 002: tasks.archived_at + 索引
  TaskService.ArchiveTask / UnarchiveTask / ListArchivedTasks
  归档只改可见性；Run / Event / Usage 全部保留
  有 active Run 的 Task 拒绝归档
  retry 归档任务时自动取消归档

retry 图片
  Snapshot 里的 image block 是 {mimeType, bytes, ref}，base64 已被剥掉
  TaskService 通过 sessionindex.Image(ref) 还原 bytes，再填 PromptRequest.Images
  image 无法还原时直接失败，不静默丢掉附件
  仍受 SendPrompt 的图片数量 / 单图 / 总大小限制
```

前端：

```text
stores/tasks.ts       view=active|archived；archiveSelected / unarchiveSelected
TaskCenterPage.vue   未归档 / 已归档 tab；归档 / 取消归档按钮
i18n                 中英文案
```

验证：

```text
TMPDIR=/tmp go test ./...                       ✅
go vet ./...                                    ✅
cd frontend && npm run typecheck                ✅
cd frontend && npm run test                     ✅ 109 files / 1289 tests
cd frontend && npm run build                    ✅
Wails 方法 169 / 绑定函数 157                    ✅
```

## 真机 A/B（2026-11-08）

```text
A: PI_DESK_HARNESS=1 PI_DESK_NORMALIZED_EVENTS=0   （强制 raw）
B: PI_DESK_HARNESS=1                               （auto：本地 normalized）
同一条带 bash 工具的 prompt，各新建一个任务

结果：工具卡、流式消息、run 状态无异常；B 未出现重复/缺失
开关：BootstrapState.HarnessEnabled / NormalizedEventsDisabled，启动时读取
```

## Auto 默认策略

```text
本地 + harness on   → normalized
远程 + harness on   → raw（未接入 remote tap）
harness off         → raw
显式 env=0          → raw（A/B 用）

normalized display payload 上限 256KB；SQLite 仍存 16KB 摘要。
队列 8192；message.delta / run / tool 终态在满队列时最多等待 100ms。
```
