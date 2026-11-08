# ADR-002: 事件契约与双通道迁移

- Status: Proposed (R0)
- Date: 2026-11-08
- Related: `GUIDE.MD` §7、§0 D5
- Deciders: TBD

## Context

现有 Go 层把 Pi 原始事件包成 `SessionEvent{threadId, generation, event}` 后，以 `pi:event` 透传给前端；`app.ts`（5,115 行）直接解释 `message_update` / `tool_execution_*` 等字段。直接替换会让流式、滚动、工具卡同时回归。

## Decision

采用双通道：

```text
pi:event     旧通道，R0–R2 冻结；payload 形状不变
agent:event  新通道，归一化 + run 上下文；按域灰度
```

事件信封：

```go
type Event struct {
    ID, Type string
    Seq      uint64
    TaskID, RunID, ThreadID, Session, Runtime string
    Generation uint64
    Timestamp  int64
    Payload    json.RawMessage
}
```

持久化规则：

- 终态立即落库：`run.*`、`tool.started/completed/failed`、`permission.*`、`usage.updated`。
- `message.delta` 合并（30–100ms）；不逐字符落库。
- payload 存摘要 + `payload_sha256` + `payload_bytes`；超过 16KB 截断，全文回读 Pi JSONL。
- 落库前脱敏：`Authorization`、`*_TOKEN`、`*_KEY`、已知 env 值。
- 单 Run 上限 10,000 条；先丢 delta/`tool.updated`，终态与权限事件必须保留，写 `run.truncated`。
- 背压：有界队列；`pi:event` 不被持久化阻塞。

## Consequences

正向：旧 UI 不受影响；新通道可独立测试；回滚只需关开关。

负向：短期双写；两套事件类型需要一致性测试；前端迁移期要维护两个 reducer 入口。

## Alternatives

1. 直接替换为 normalized events → 否定：滚动/流式回归风险高。
2. 永远让前端解析原始事件 → 否定：Runtime 抽象无法成立。

## Verification

- golden fixtures：同一段 Pi 事件分别过旧/新通道，工具卡数量、顺序、状态一致。
- `(run_id, seq)` 幂等；乱序/重复事件被丢弃。
- 10k 截断演练：终态与权限事件保留，`run.truncated` 可见。
- 关闭 `useNormalizedEvents` 后与 R0 截图一致。

## Open questions

- `agent:event` 的 Wails 事件名与前端订阅生命周期（R1b 定）。
- 事件 schema 版本字段是否需要在信封中显式化。
