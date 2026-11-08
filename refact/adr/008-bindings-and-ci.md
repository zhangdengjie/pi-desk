# ADR-008: Bindings 生成与 CI 校验

- Status: Proposed (R0)
- Date: 2026-11-08
- Related: `GUIDE.MD` §4.3、§12 红线 17
- Deciders: TBD

## Context

前端通过 `frontend/bindings` 调用 Go service。改了 service 方法却忘记重新生成 bindings，前端可能仍能 build，直到运行期或他人分支才报错。Wails 生成器可能随版本改变产物（v3.1 新增 `bindings/events/index.ts`）。

## Decision

```text
生成命令    wails3 generate bindings -f '' -clean=true -ts -i
生成目录    frontend/bindings
提交策略    生成文件入库；禁止手改
CI 校验     生成后 git diff --exit-code -- frontend/bindings
批量策略    同一 PR 内批量改 service，最后统一生成一次
```

基线已验证（beta.16）：15 services / 159 methods，生成后 diff 为 0。v3.1 生成后现有文件无 diff，仅新增 `frontend/bindings/events/index.ts`。

## Consequences

正向：类型漂移在 CI 被拦截；生成文件可审查；升级 Wails 时差异可见。

负向：CI 多一步生成（需要 Go + Wails CLI）；生成器非确定性时会产生噪声 diff；生成目录变更需要同步文档。

## Alternatives

1. 不提交生成文件，构建时生成 → 否定：CI/IDE 类型解析不稳定，审查不可见。
2. 手改 bindings → 否定：下次生成即丢失。
3. 只在 release 前生成 → 否定：漂移发现太晚。

## Verification

- R0：beta.16 生成幂等（已完成，diff=0）。
- 每个改 service 的 PR：CI diff 为 0。
- Wails 升级：记录生成器差异（v3.1 新增 events 目录）。
- 新增方法后前端 `vue-tsc` 通过。

## Open questions

- CI 生成步骤是否缓存 Go/Wails CLI（R0 基线脚本定）。
- `frontend/bindings/events/index.ts` 是否需要在应用启动时注册（R1b 评估）。
