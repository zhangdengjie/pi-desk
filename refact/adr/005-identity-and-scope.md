# ADR-005: 产品身份与 R0–R3 范围

- Status: Proposed (R0)
- Date: 2026-11-08
- Related: `GUIDE.MD` §0 D1/D4、§1
- Deciders: TBD

## Context

Bundle id、数据目录、单实例锁、TCC 录屏授权、更新 URL 都绑在 `dev.pi.desk` / `pi-desk` 上。PAW 改名只带来文案收益，却会触发数据迁移、重新授权、签名/公证链重验。

## Decision

```text
Bundle ID     继续 dev.pi.desk
应用名        继续 pi-desk
数据目录      ~/Library/Application Support/pi-desk
单实例锁      com.pidesk.desktop.lock
PAW           仅作为 UI 文案/品牌候选，不触发迁移
```

范围：

```text
R0  文档/ADR/Wails spike
R1a Go 数据面
R1b 前端解耦 + Task Center
R2  Worktree + 调度器迁 Go
R3  收口与硬化
R4  Agent 策略 + 权限（backlog）
R5  ACP/多 Runtime/Sandbox（backlog）
```

R3 后连续使用 4 周，再决定 R4；未启动前不为 R4/R5 预留抽象或目录。

## Consequences

正向：零迁移成本；TCC/签名/更新链不变；团队对阶段有唯一口径。

负向：品牌层面继续使用 Pi Desk 命名；若未来必须改名，仍需一次迁移（届时单独立项）。

## Alternatives

1. 现在改名 PAW → 否定：迁移+重授权成本高，收益仅文案。
2. 同时做 R4/R5 → 否定：范围蔓延，个人 Harness 先用起来。

## Verification

- `build/config.yml` 的 `productIdentifier` 未变；`main.go:93` 的 `UniqueID` 派生未变。
- 数据目录、锁名、更新 URL 的 diff 审查。
- R3 验收后写一份「是否启动 R4」的决策记录。

## Open questions

- UI 文案是否逐步使用 PAW（不影响工程身份）。
- 更新 URL 的构建期注入方案（R0 单独修）。
