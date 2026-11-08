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

## 本刀边界（下一刀）

```text
✅ 只读数据通路：Task/Run/Event/Usage 都能看到
✅ message/tool/retry 的纯 reducer 与测试
⏳ app.ts 拆 store（session/tasks/workspace/usage）
⏳ useNormalizedEvents 灰度：工具卡 → 运行态 → 消息
⏳ 写操作：cancel / retry / archive
⏳ 历史导入 Task 的 Run 关联（当前只有下一次 Prompt 才产生 Run）
```

> 先做加法（Task Center），再做可测试的纯函数（message/tool/retry）；下一刀才是 5k 行 store 的结构拆分。
