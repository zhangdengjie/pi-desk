# R1a 数据面实施状态

- 日期：2026-11-08
- 分支：`feat/r1a-go-data-plane`
- 基线：`develop` @ `2224f42` + Wails v3.1 合并 `20e2769`
- 开关：`PI_DESK_HARNESS=1`（默认关闭，关闭时现有聊天路径不变）

## 已交付

```text
internal/task          Task/Run/Session 语义、状态机、旧 thread 导入
internal/storage/sqlite 纯 Go SQLite、迁移、单写连接、Task/Run/Event/Usage CRUD
internal/usage         message_end 用量解析与 per-Run 累加
internal/runtime       薄 Runtime 接口 + capability + PiAdapter + Mock
internal/eventbus      pi:event 旁路 Tap、归一化、脱敏/截断、落库、agent:event
internal/appservice    Harness 装配；AgentService 事件 sink；首次导入前备份 state.json
main.go                PI_DESK_HARNESS=1 时创建 DB/Tap，并转发 agent:event
```

## 验证

```bash
go build ./...
TMPDIR=/tmp go test ./...
TMPDIR=/tmp go test -race ./internal/task ./internal/storage/sqlite ./internal/eventbus ./internal/usage ./internal/runtime
wails3 generate bindings -f '' -clean=true -ts -i
git diff --exit-code -- frontend/bindings   # 159 methods，无变化
```

烟测（raw binary，`PI_DESK_DATA_DIR` 沙箱 + 复制真实 state.json）：

```text
harness: imported 425/425 legacy threads
tasks=425, task_runs=0, run_events=0, schema_version=1
backup/state-<ts>.json 已生成
```

raw binary 因没有 bundle identifier，notifications 服务报错退出；这是启动方式差异，不影响 DB/导入验证，正式 `.app` 下不会出现。

## 已知边界（不是 R1a 缺陷，是后续阶段）

```text
1. 只 Tap 本地 Supervisor；远程 Pi 走独立 broker，R2 接入同一 Handle。
2. Runtime 接口已实现但 AgentService 仍用内部 agentRuntime；R1b 再切换。
3. Task 完成态未自动收敛（Run 完成只更新 Run）；R1b 定义 Task 生命周期。
4. agent:event 已发出但前端未消费；R1b 做 reducer 拆分与 Task Center。
5. task_schedules / worktree / tool_executions 表未建；R2。
6. R0 剩余：docs/01–05 刷新、current-to-target、P0-1/P0-3、基线截图。
```

## 提交

```text
21ae674 feat(harness): add task/run domain, sqlite store, and usage ledger
a42812e feat(harness): add runtime adapter and pi event tap
1d8adeb feat(harness): wire opt-in R1a data plane
0c8b61b fix(harness): back up legacy state and normalize sqlite DSN path
```
