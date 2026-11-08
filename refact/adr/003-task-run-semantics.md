# ADR-003: Task / Run / Session 语义与状态机

- Status: Proposed (R0)
- Date: 2026-11-08
- Related: `GUIDE.MD` §5.2、§8.2
- Deciders: TBD

## Context

现有模型只有 thread（≈ Session 绑定），没有持久任务与运行记录。多 Agent、定时任务、重试和成本统计都需要区分「意图」「一次执行」「对话上下文」。

## Decision

```text
Task     用户希望完成的一项工作；跨重启、可暂停/恢复
Run      某个 Agent 对 Task 的一次执行；一次启动到结束
Session  Pi 的对话上下文；由 Pi 管理
```

状态机：

```text
Task: CREATED → QUEUED → RUNNING → COMPLETED / FAILED / CANCELLED
                              ├─ WAITING_APPROVAL → RUNNING
                              ├─ WAITING_INPUT    → RUNNING
                              └─ PAUSED           → RUNNING

Run:  QUEUED → RUNNING → COMPLETED / FAILED / CANCELLED
                   └─ WAITING_APPROVAL / WAITING_INPUT
```

规则：

- 状态变化只能通过 `TaskService.Transition`；禁止 handler 直接改字段。
- Task 状态由 Run 聚合，但允许用户手动暂停/取消。
- 重试生成新 Run（`attempt+1`），不覆盖旧 Run。
- 旧 thread 首次发 Prompt 自动静默收养，`origin=legacy`；Run 边界 = 一次 Prompt → `agent_settled`。
- 调度：每个 schedule 只补跑一次；30s 抖动；单次最多 3 个；`last_catch_up_at` 防重复。

## Consequences

正向：任务可恢复、可审计；定时/重试/成本有明确归属；UI 不再把 Agent 当 Session。

负向：多一层实体与状态同步；旧 thread 收养需要映射；Run 边界在异常退出时可能不完整。

## Alternatives

1. thread == Task == Run → 否定：无法表达重试与多 Run。
2. Run == Session → 否定：Session 可跨多个 Prompt。
3. 只做 Task 不做 Run → 否定：成本/重试/审计无法归集。

## Verification

- 非法状态转换单测（例如 COMPLETED → RUNNING 拒绝）。
- 重启后 Task/Run 仍在；旧 thread 收养幂等。
- 定时任务跨过 5 个周期 → 只补 1 次；5 个任务同时到期 → 错峰。
- 取消/重试生成新 Run，旧 Run 保留。

## Open questions

- 异常退出（kill -9）时 Run 的 `finished_at` 与状态如何收敛（建议启动时标记 `interrupted`）。
- Task 归档后是否保留 Run 事件（建议保留终态）。
