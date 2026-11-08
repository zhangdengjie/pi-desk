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

## 本刀边界（下一刀）

```text
✅ 只读数据通路：Task/Run/Event/Usage 都能看到
⏳ handlePiEvent → 纯 reducer（message/tool/run）
⏳ app.ts 拆 store（session/tasks/workspace/usage）
⏳ useNormalizedEvents 灰度：工具卡 → 运行态 → 消息
⏳ 写操作：cancel / retry / archive
⏳ 历史导入 Task 的 Run 关联（当前只有下一次 Prompt 才产生 Run）
```

> 本刀先做加法（不改现有聊天状态机），避免在 5k 行 store 上同时改数据和 UI；reducer 拆分在下一刀做，验收基线用本页和现有 `app.test.ts`。
