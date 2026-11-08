# ADR-004: Runtime 接口与能力声明

- Status: Proposed (R0)
- Date: 2026-11-08
- Related: `GUIDE.MD` §5.1、§0 D3
- Deciders: TBD

## Context

现有 `agentRuntime`（`internal/appservice/agent.go:44`）用 `Call(map[string]any)` 暴露 Pi 形状；local 与 remote 已分开，但没有统一能力声明。Pi 的 fork/branch/compact/extension UI 是 UI 的承重功能，不能被通用接口抹掉。

## Decision

薄接口 + 能力声明 + 可选扩展接口：

```go
type Runtime interface {
    Info() RuntimeInfo
    Start(ctx, cfg) (SessionInfo, error)
    Prompt(ctx, sessionID, req) error
    Cancel(ctx, sessionID) error
    Status(ctx, sessionID) (RuntimeStatus, error)
    Events() <-chan RuntimeEvent
    Close() error
}

type Capabilities struct {
    Streaming, SessionResume, SessionFork, SessionBranch, Compaction bool
    ToolApproval, ExtensionUI, SubAgent, NativeMCP, ThinkingStream bool
}
```

- Pi Adapter 包装现有 `piruntime.Supervisor` 与 `pirpc`，不重写进程/协议。
- Remote Pi 实现同一接口，能力集可更小。
- fork/compact/extension UI 用可选接口（`SessionForker` / `Compactor` / `ExtensionUIResponder`），调用方先类型断言。
- 不设计 20+ 方法的万能接口；不为未来十种 Runtime 预留抽象。
- 不做第二套 Agent Loop。

## Consequences

正向：Go 业务与 Pi 解耦；UI 可按能力隐藏入口；remote 可复用同一路径。

负向：可选接口增加调用方分支；能力集需要维护矩阵；remote 事件/能力可能滞后。

## Alternatives

1. 直接采用 ACP 作为唯一接口 → 否定：Pi 的 Session 分支/压缩/扩展 UI 不能等价映射。
2. 继续用 `Call(map[string]any)` → 否定：无类型、无能力声明、换 Runtime 成本高。
3. 一次性实现多 Runtime → 否定：范围蔓延，R3 前不需要。

## Verification

- Mock Runtime 覆盖全部基础方法；Pi Adapter 用 golden events 对齐旧通道。
- 能力矩阵测试：不支持 fork 的 Runtime 不显示 fork 入口。
- remote 会话与本地会话走同一 `TaskService` 记录路径。

## Open questions

- `Status` 的字段是否包含 token/成本（建议只放运行态，成本走 usage）。
- 能力声明是否需要版本号（建议后续加 `CapabilitiesVersion`）。
