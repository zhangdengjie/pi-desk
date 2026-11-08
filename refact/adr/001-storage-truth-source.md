# ADR-001: 存储真相源

- Status: Proposed (R0)
- Date: 2026-11-08
- Related: `GUIDE.MD` §0 D2、§8
- Deciders: TBD

## Context

Pi Desk 现有两类数据：`state.json`（workspace/thread/偏好）与 Pi 的 JSONL Session。引入 Task/Run 后，如果 SQLite 再存一份消息正文，会出现三份真相源、双写漂移、体积膨胀和迁移困难。

## Decision

```text
Pi JSONL    = 对话与消息正文的唯一真相
SQLite      = Task / Run / Event / Usage / 索引元数据
state.json  = UI 偏好、窗口态、兼容回退（逐步退役）
```

- SQLite 不复制消息正文；需要正文时按 `session_path` 从 Pi JSONL 回读。
- `run_events` 只存运行边界、工具调用、权限决策、用量、错误等终态；delta 合并，不逐字符落库。
- DB 故障时聊天继续（走 Pi），Task Center 降级为「记录不可用」，不阻塞发送。
- 禁止同一字段双写（例如任务标题同时写 SQLite 与 state.json）。

## Consequences

正向：避免第二套 transcript；保留 Pi 的分支/压缩/扩展能力；迁移面可控。

负向：跨库查询需要先查 SQLite 再回读 JSONL；历史统计仍需 `sessionindex` 对账；`state.json` 退役需要多个版本。

## Alternatives

1. SQLite 接管全部消息正文 → 否定：双写、迁移、体积、与 Pi 版本耦合。
2. 继续只用 `state.json` → 否定：无事务、无查询、覆盖写不安全。
3. 外部数据库（Postgres）→ 否定：本地优先、单机桌面不需要。

## Verification

- `state.json` 导入 dry-run + 幂等 + 备份；失败回滚事务。
- 重启后 Task/Run 可查；消息正文仍从 Pi Session 加载。
- 断开/删除 DB 后，现有聊天仍可发送与接收。
- 代码审查：`grep` 确认没有第二处写任务标题/状态。

## Open questions

- `run_events` 的 payload 摘要上限（已定 16KB，见 ADR-002）。
- `state.json` 最终退役版本号与回退窗口。
