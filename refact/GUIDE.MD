# Pi Desk 下一代：个人 Agent Harness 实施指南（v2.1）

> 版本：v2.1 · 2026-11-08 · 基线：`develop` @ `6372141`
> v1 原文归档：`refact/GUIDE.v1.MD`（未删改，仅供追溯）
> 本文是后续实施的唯一指导文件。与 v1 冲突时，以本文的「决策基线」和「实施红线」为准。

## v2 修订摘要

v1 的架构方向成立：保留 Wails/Vue/Go/Pi RPC，Task 与 Session 分离，SQLite 做本地元数据，事件经过 Go 归一化。但 v1 与仓库现状有 7 处偏差，直接照做会返工：

1. 把已有的 Chat、配置、远程执行当成待建能力。
2. 把「前端 5k 行单 store 的事件解耦」和「`state.json → SQLite` 双真相源迁移」当成加一层。
3. 把定时任务当成已有 Scheduler；实际它在前端 `setInterval` 里。
4. 把 Worktree 当成独立小模块；实际它与 workspace/session/文件树缓存深度耦合。
5. 认为 Go 可以直接执行权限审批；实际 Pi 在自己进程里跑工具。
6. 不知道 SubAgent、Goal、Todo、MCP、Skill、Extension 已经以 Pi 扩展/配置的形式存在。
7. 忽略 Wails beta.16 → 3.x 的升级成本，以及 PAW 改名会触发的数据目录/TCC/更新链迁移。

v2 只做四件事：把已拍板的决策写成硬约束（§0）；用实测数据替换现状描述（§2）；把 6 阶段 8–13 周改成可验收的 R0–R5（§11）；修正上述 7 处设计（散落在 §5–§9）。

## v2.1 修订记录（外部评审采纳）

评审结论：架构方向与 Strangler 策略成立。以下 5 条工程细节在 R0 前补入，3 处表述纠正，另补 2 处实现细节（DSN 路径转义、事件背压一致性）：

1. Worktree 环境隔离：新增 bootstrap 策略（none/symlink/copy/command），默认不复制密钥；见 §6.2。
2. 阶段编号统一：全文统一为 R0 → R1a → R1b → R2 → R3；D4 与 §11 一致。
3. SQLite 并发：读写分离 + 单写连接 + 每连接 PRAGMA；见 §4.2。
4. Catch-up 雪崩：补跑抖动、单次上限、启动通知；见 §5.2。
5. Bindings 校验：生成后 CI 比对 `frontend/bindings`；见 §4.3。

纠正：评审建议中的 `frontend/src/wailsjs` 在本仓库应为 `frontend/bindings`；payload 用 hash/大小而非“签名”；事件截断必须保留终态事件。附录 C 由“未决问题”改为“已裁定细节”。

---

## 0. 决策基线（已拍板，不再讨论）

### D1 产品身份：保留 `pi-desk`，不改工程身份

**决策**：bundle id 继续用 `dev.pi.desk`，应用名继续用 `pi-desk`，数据目录继续用 `~/Library/Application Support/pi-desk`。PAW 只作为 UI 文案/品牌候选，不触发任何迁移。

**理由**：bundle id、数据目录、单实例锁、TCC 录屏授权、更新 URL 全部绑在现有身份上。改名会同时触发：数据迁移、锁名变化、重新授权、签名/公证链路重验。收益只是文案，成本是多天迁移加一轮用户重授权。

**硬约束**：

- 不得修改 `build/config.yml` 的 `productIdentifier` 与 `main.go:93` 的 `UniqueID` 派生方式。
- 不得修改 `internal/appdirs` 的默认目录名。
- 不得修改单实例锁名 `com.pidesk.desktop.lock`。
- 更新 URL 的修复（`docs/05` P0-3）单独做，属于 R0，不属于改名。

### D2 数据真相源：Pi JSONL 是 transcript，SQLite 是索引与运行记录

**决策**：

```text
Pi JSONL（~/.pi/agent/sessions/**.jsonl）  = 对话与消息正文的唯一真相
SQLite（<data-dir>/pi-desk.db）             = task/run/event/usage/索引元数据
state.json                                 = UI 偏好、窗口态、兼容回退（逐步退役）
```

SQLite **不复制消息正文**。消息增量（`message.delta`）不逐字符落库；只持久化运行边界、工具调用、权限决策、用量、错误等终态事件。需要正文时按 `session_path + message_id` 回读 Pi JSONL。

**理由**：Pi 已经负责上下文、分支、压缩和 Session 文件格式；重复存储会带来双写、漂移、体积和迁移四重成本。Harness 需要的是「可查询的运行记录」，不是第二份 transcript。

**硬约束**：

- 不得在 SQLite 里实现 Pi Session 文件格式的替代品。
- 不得让 SQLite 成为 `SendPrompt` 的唯一前置条件；DB 故障时现有聊天必须仍可用（降级为只读运行记录）。
- 任何「消息正文」查询必须走 `sessionindex`/Pi 文件，不得从 `run_events` 反推。

### D3 编排归属：单轮内留 Pi，跨任务归 Go

**决策**：

```text
Pi 扩展（pi-desk-subagents.ts）  = 单轮内的子任务委派（single / parallel / chain）
Go Task Center                   = 跨任务、定时、并行顶层任务、持久化与成本上限
```

两边不互相实现对方职责。R0–R3 不接管 Pi 扩展拉起的子进程，只通过事件观察其工具调用；需要成本/并发控制时，先加观测，再决定是否接管。

**理由**：现有 `subagent` 工具已经能隔离上下文、并行、链式执行，并且有 Agent 定义目录（`~/.pi/agent/agents`、项目 `agents/`）。Go 侧再实现一套会重复发现、重复审批、重复上下文管理。反过来，Pi 扩展也不适合承担「跨天、可恢复、可定时」的任务，因为它随会话生命周期结束。

**硬约束**：

- 不得在 Go 侧实现第二个 Agent Loop。
- 不得让 Go Scheduler 直接调用 `subagent` 工具；顶层任务只通过 `Prompt` 进入 Runtime。
- 不得删除或改写 `pi-desk-subagents.ts` 的现有行为；需要扩展时加参数，不改语义。

### D4 范围：做到 R3 就停，R4/R5 进 backlog

**决策**：

```text
R0  文档与 ADR、Wails 升级 spike
R1a Go 数据面（SQLite / Task / Run / Event tap / Usage）
R1b 前端解耦 + Task Center（灰度）
R2  Worktree 隔离 + 调度器迁 Go
R3  收口与硬化（性能/恢复/文档/回归）
R4  Agent 策略层 + 权限审批（backlog）
R5  ACP / 多 Runtime / Sandbox / 远程对等（backlog）
```

阶段代号以 §11 为准；R1a/R1b 是同一阶段的两次交付，不是两个独立版本。

R3 验收后，至少连续使用 4 周，再决定是否启动 R4。R4/R5 未启动前，不为它们预留抽象或目录。

**理由**：个人 Harness 的价值在「任务可恢复、运行可追踪、工作区可隔离」，不在「支持十种 Runtime」。过度设计 Runtime 抽象是 v1 自己已经警告过的风险。

### D5 实施方式：Strangler，不整体重写

**决策**：新层旁路接入，旧路径保留到验收通过。

```text
新增 Go 侧数据面  → 旧 UI 不改，raw pi:event 继续工作
新增 agent:event → 与 pi:event 并行，前端按域灰度迁移
新增 Task Center → feature flag 控制，关闭时行为与今天一致
新增 Worktree    → 只对显式选择「隔离运行」的任务生效
```

**硬约束**：

- 每个阶段必须有「关闭开关」和「回滚步骤」。
- 不得在一个 PR 里同时改数据层、事件契约和 UI 交互。
- 不得以「以后反正要改」为由删除旧路径；删除必须发生在对应阶段验收之后。

---

## 1. 目标与边界

### 1.1 产品定位

Pi Desk 是一个**本地优先的个人 Agent 工作台**：以 Pi 为第一代 Runtime，向上提供任务、运行记录、工作区隔离、模型/能力管理和可追踪的执行历史。

它不是一个通用 Agent 平台，也不是 Pi 的 Fork。产品边界：

- Pi 负责：Agent 循环、模型请求、上下文、工具执行、扩展、Skills、MCP。
- Pi Desk 负责：桌面宿主、任务与运行记录、工作区/终端/Git、事件持久化、UI、权限策略（R4）。
- 两者之间只有一层：Runtime Adapter + 事件契约。

### 1.2 R0–R3 的交付定义

R3 结束时，用户应能：

1. 从聊天创建一个 Task，或在现有会话上「收养」为 Task。
2. 看到 Task 的 Run 历史、工具调用、耗时、Token/成本。
3. 重启 Pi Desk 后，运行记录仍在；消息正文仍从 Pi Session 加载。
4. 让两个 Task 在同一个仓库的独立 Worktree 中并行执行，互不覆盖文件。
5. 设定时任务；Pi Desk 进程存活时按时触发，退出期间的到期任务在下次启动补跑一次。
6. 关闭所有新功能开关后，得到与今天完全一致的聊天体验。

### 1.3 非目标（R0–R3 明确不做）

```text
多窗口 / 多 Runtime / ACP
Sandbox / 容器隔离
云端同步 / 远程 Web UI
PAW 工程改名
模型路由与自动降级
第二套 LLM 客户端
Pi Session 文件格式重写
```

---

## 2. 现状基线（2026-11-08 实测）

### 2.1 规模与入口

```text
分支 / HEAD        develop @ 6372141
Go                 60,063 行（含测试与 remote helper），104 个 *_test.go
前端               55,943 行（含测试），52 个 .vue，106 个 *.test.ts
Wails service      15 个；binding 方法 147 个；service 方法 228 个
持久化             state.json 412KB，version 6，19 workspaces，425 threads
事件链             piruntime.Supervisor → app.Event.Emit("pi:event", SessionEvent)
                   → frontend/src/stores/app.ts（5,115 行）解释原始 Pi 事件
Wails 版本         go.mod = v3.0.0-beta.16；registry 已有 v3.0.0 / v3.1.0
```

数据目录：`~/Library/Application Support/pi-desk/state.json`。沙箱实例通过 `PI_DESK_DATA_DIR` 隔离，锁名带 hash。

### 2.2 能力矩阵

```text
能力                    状态    证据 / 缺口
聊天 / 流式 / 工具卡     ✅      app.ts handlePiEvent
Session 管理             ✅      425 threads；sessionindex 读写 Pi JSONL
历史重载                 ✅      GetMessages / GetState + Pi Session
Token / 成本（事后）     ✅      sessionindex/usage.go 扫 JSONL + UsagePage
定时任务                 ⚠️      前端 setInterval + state.json；进程退出即停（关窗不退出仍跑）
Worktree                 ⚠️      仅 `git worktree list`；无 create/cleanup
Agent 定义 / SubAgent    ✅      Pi 扩展 + ~/.pi/agent/agents + 项目 agents/
MCP / Skill / Extension  ⚠️      有配置编辑服务；无统一策略层
权限审批                 ❌      只有 Pi 的 --approve/--no-approve 全局开关
Task / Run               ❌      只有 thread，没有持久任务与运行实体
事件持久化               ❌      pi:event 透传，无落库、无回放
SQLite                   ❌      无驱动、无 schema、无迁移
调度器（Go 侧）          ❌      只有 3 处零散 ticker
```

### 2.3 保留 / 改造 / 新建

```text
保留（不动内核）
  internal/pirpc          NDJSON 帧与 request-id 匹配
  internal/piruntime      进程监督、generation、退出处理
  internal/sessionindex   JSONL 索引、改写、usage
  internal/workspace      catalog / state.json
  internal/repository     git 只读扫描、diff、预览
  internal/terminal       本地/远端 PTY
  internal/remotessh      SSH runtime + helper
  internal/appservice     15 个 service（R1a 只加事件 tap）

改造（包一层或加能力）
  appservice.AgentService        事件回调处加 tap；不改 Pi 调用路径
  runtime 选择                   从 agentRuntime 抽出统一接口
  前端 app.ts                    handlePiEvent 拆 reducer，再拆 store
  定时任务                        从前端 setInterval 迁到 Go Scheduler
  repository                     worktree create/remove/gc（R2）

新建
  internal/task                  Task/Run 领域与服务
  internal/runtime               Runtime 接口 + Pi Adapter + Mock
  internal/eventbus              归一化、扇出、批量落库
  internal/storage/sqlite        schema + migrations + queries
  internal/usage                 per-run 计量与对账
  internal/worktree              worktree 生命周期（R2）
  internal/policy                权限决策（R4）
```

### 2.4 v1 的 7 处偏差（实施时逐条对照）

1. **Phase 0 已完成大半**：`docs/01`–`05` 是符号级盘点（基准 `9fb21dd`），但行号已漂移（`app.ts` 从 4,196 涨到 5,115）。R0 是刷新，不是重做。
2. **Phase 1 验收项今天已有 5/6 满足**：多 Session、独立中断、重启重载、transcript 不丢、Token 展示都已存在；只缺 Task 实体和 Run 级事件持久化。
3. **Scheduler 不在 Go 侧**：定时任务是前端 `setInterval`（`app.ts:502`）+ `state.json`；「保留并重构」实际是「搬到 Go」。
4. **Worktree 与 workspace 耦合**：repo 扫描已识别 linked worktree，但 workspace、session 目录、文件树展开态都以 `workspaceId`/路径为 key；per-task worktree 会放大 workspace 数量，必须做分组与 GC。
5. **前端不是「没解析 RPC」**：Go 已包裹 `threadId/generation`，但 payload 是 Pi 原始事件；5,115 行 store 承担流式节流、滚动锚定、工具卡、扩展 UI。直接换 normalized events 会重演滚动回归。
6. **权限不能只在 Go 做**：Pi 在自己的进程里执行工具；Go 只能看到事件。审批必须走 Pi 扩展的 `tool_call` hook（可返回 `{block:true}`），再由扩展回连 Go 策略服务。
7. **Agent/SubAgent 已存在**：`pi-desk-subagents.ts` 支持 single/parallel/chain；`goal`/`todo` 也在。R4 前不要重建 Agent 中心，只做策略层的薄封装。

---

## 3. 总体架构

### 3.1 四层与改造点

```text
┌─────────────────────────────────────────────────────────────┐
│ Vue 3 Frontend                                              │
│  Chat（已有） + Task Center（R1b） + Inspector（已有）      │
│  Pinia stores：app.ts 逐步拆为 session/task/workspace/usage │
└───────────────────────┬─────────────────────────────────────┘
                        │ Wails Bridge（147 个 binding）
┌───────────────────────▼─────────────────────────────────────┐
│ Go Application Core                                         │
│  已有：Agent / Catalog / Repository / Terminal / Remote ... │
│  新增：Task Service / Event Bus / Usage / Policy（R4）       │
│  数据：SQLite（元数据） + state.json（偏好）                 │
└───────────────────────┬─────────────────────────────────────┘
                        │ Runtime Interface + Capability Flags
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
   Pi Runtime       Remote Pi         Mock Runtime
   Supervisor       remotessh         （测试）
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ Execution Environment                                       │
│  Local Workspace（filesystem / shell / git / PTY）           │
│  Worktree Isolation（R2）                                    │
│  Remote Workspace（SSH + helper，现有）                      │
│  Sandbox（R5，backlog）                                      │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 一次 Prompt 的完整数据流

```text
Vue SendPrompt
  → AgentService.SendPrompt
  → Runtime.Prompt
  → pi --mode rpc（stdin JSONL）
  → pirpc 读出事件
  → piruntime.Supervisor 包成 SessionEvent{threadId, generation, raw}
  → AgentService 事件回调
      ├─ app.Event.Emit("pi:event", raw)          ← 旧通道，R0–R2 不动
      └─ EventBus.Tap(raw)                        ← 新通道
            → Normalizer
            → Run/Event 更新（异步批量）
            → SQLite
            → app.Event.Emit("agent:event", normalized)
  → Vue：旧通道驱动现有 UI；新通道按域灰度接管
```

关键点：**Go 已经是唯一通路**，v1 担心的「Pi RPC 直连 Vue」并不存在。缺的是归一化、持久化和可回放，不是再加一层代理。

### 3.3 改造原则

1. **旁路接入**：新逻辑挂在现有回调旁边，不替换。
2. **旧通道冻结**：`pi:event` 的 payload 形状在 R0–R3 不变；需要修正时加版本号。
3. **按域迁移**：tool → run/task → message，逐域切换，不一次性切。
4. **可回滚**：每个阶段一个开关；关闭后行为与今天一致。
5. **先观测后接管**：SubAgent、权限、成本都先记录，再决定是否控制。

---

## 4. 技术选型（v2 收敛版）

```text
领域 | 选型 | 约束
桌面 | Wails v3 | 现 beta.16；R0 spike 3.1，不合并
前端 | Vue 3.5 + Pinia + Vite | 现有栈不动
存储 | SQLite（modernc.org/sqlite） | 纯 Go、无 cgo、WAL
迁移 | 内嵌 SQL + schema_version | 启动串行执行，失败即停
日志 | log/slog | 不引第三方
配置 | 现有 userconfig | 不引 koanf
进程 | os/exec + 现有 Supervisor | 不重写
PTY | 现有 go-pty | 不换
Git | 原生 git CLI | 不引 go-git
ID | 时间有序字符串 | 不引 ULID 库
事件 | 进程内 channel + 批量落库 | 不引消息队列
测试 | go test + vitest | 沿用现有
```

**明确不引入**（R0–R3）：

```text
koanf        现有 userconfig + JSON 足够；多一层配置会多一个真相源
go-git       现有 gitexec 已覆盖；两套 Git 实现会漂移
fsnotify     仓库刷新目前按需；没有明确的监听需求前不加
ORM          表少、查询固定；手写 SQL + 迁移更可控
消息队列     单进程；channel + SQLite 足够
```

### 4.1 Wails 升级（R0 spike，不合并）

现状 `v3.0.0-beta.16`，registry 已有 `v3.0.0` 与 `v3.1.0`。升级是 R0 的独立 spike：

- 分支：`spike/wails-3.1`，不合并到 `develop`。
- 范围：`go.mod`、CI 的 `wails3` CLI 版本、bindings 重新生成、事件/窗口 API 回归。
- 验收：`go test ./...`、`npm run build`、沙箱起窗、`pidesk-shot` 截图无差异。
- 产出：`refact/wails-upgrade-spike.md`，列 breaking changes 与是否需要独立阶段。
- 结果（2026-11-08）：`go build ./...`、`TMPDIR=/tmp go test ./...`、`npm run build` 均通过；Go 指令升到 1.26.0，新增 `frontend/bindings/events/index.ts`；详见 `refact/wails-upgrade-spike.md`。

升级前不得改 service 接口；否则无法区分「升级坏」还是「改动坏」。

### 4.2 SQLite 参数与并发

SQLite 的 PRAGMA 是**每连接**生效的。用 `database/sql` 连接池时，只在启动时 `db.Exec("PRAGMA ...")` 不能保证池里其他连接也带上这些设置；`modernc.org/sqlite` 用 DSN 的 `_pragma` 参数：

```go
base := (&url.URL{Scheme: "file", Path: dbPath}).String() // 处理 macOS 路径中的空格

// 写连接：单连接，避免 SQLite 并发写锁
writeDSN := base + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)"
writeDB, _ := sql.Open("sqlite", writeDSN)
writeDB.SetMaxOpenConns(1)
writeDB.SetMaxIdleConns(1)

// 读连接：可并发，只读
readDSN := base + "?mode=ro&_pragma=busy_timeout(5000)&_pragma=query_only(1)"
readDB, _ := sql.Open("sqlite", readDSN)
readDB.SetMaxOpenConns(4)
```

约束：

- `dbPath` 可能含空格（macOS `Application Support`）：用 `url.URL{Scheme:"file", Path: dbPath}` 构造，不要裸拼。
- 写路径只走 `writeDB`，单连接/单写 goroutine；禁止并发写。
- 读路径走 `readDB`；需要读己之写时显式走 `writeDB`，不依赖连接池的一致视图。
- 事务内只用 `tx`；禁止在 `tx` 里调用 `writeDB.Exec`（会另开连接，可能自锁）。
- 备份用 `VACUUM INTO '<path>'` 或 SQLite backup API，不要在 WAL 活跃时 `cp` 主文件。
- 并发验收：50 个 goroutine 各写 100 条，`-race` 下无 `database is locked`、无丢更新。

DB 文件放在 `appdirs` 解析出的数据目录，必须支持 `PI_DESK_DATA_DIR` 沙箱；文件权限 `0600`，目录 `0700`。

### 4.3 Bindings 生成与 CI 校验

- 生成命令：`wails3 generate bindings -f '' -clean=true -ts -i`。
- 生成目录是 `frontend/bindings`（不是 `frontend/src/wailsjs`）。
- 新增/修改 service 方法后必须重新生成并提交；禁止手改生成文件。
- CI/本地检查（两步）：

```bash
wails3 generate bindings -f '' -clean=true -ts -i
git diff --exit-code -- frontend/bindings
```

- 该检查放在 R0 的基线脚本里；先确认当前仓库生成是幂等的，若 CLI 产生非确定性 diff，先把差异收敛再启用。

---

## 5. 核心模块

### 5.1 Runtime 抽象（薄接口 + 能力声明）

现有 `agentRuntime`（`internal/appservice/agent.go:44`）已经分开了 local 与 remote，但 `Call(map[string]any)` 是 Pi 形状。R1a 只做两件事：抽接口、加能力声明；**不重写 Supervisor**。

```go
type Runtime interface {
    Info() RuntimeInfo
    Start(ctx context.Context, cfg StartConfig) (SessionInfo, error)
    Prompt(ctx context.Context, sessionID string, req PromptRequest) error
    Cancel(ctx context.Context, sessionID string) error
    Status(ctx context.Context, sessionID string) (RuntimeStatus, error)
    Events() <-chan RuntimeEvent
    Close() error
}

type Capabilities struct {
    Streaming      bool
    SessionResume  bool
    SessionFork    bool
    SessionBranch  bool
    Compaction     bool
    ToolApproval   bool
    ExtensionUI    bool
    SubAgent       bool
    NativeMCP      bool
    ThinkingStream bool
}

// 可选扩展接口：调用方先做类型断言，再决定 UI 是否显示入口
type SessionForker interface {
    Fork(ctx context.Context, sessionID, messageID string) (SessionInfo, error)
}
type Compactor interface {
    Compact(ctx context.Context, sessionID string, req CompactRequest) error
}
type ExtensionUIResponder interface {
    RespondUI(ctx context.Context, requestID string, resp UIResponse) error
}
```

约束：

- Pi Adapter 内部继续用 `piruntime.Supervisor` 与 `pirpc`；不复制事件解析。
- Remote Pi 也实现同一接口；能力集可以更小，前端按 `Capabilities` 隐藏入口。
- `Mock Runtime` 只用于测试，不进入生产路径；事件夹具放 `test/fixtures/events/`。
- 不要为「未来十种 Runtime」设计万能接口；新增能力用可选接口。

### 5.2 Task Center

#### 实体

| 实体 | 含义 | 生命周期 |
|---|---|---|
| Task | 用户希望完成的一项工作 | 跨重启、可暂停/恢复 |
| Run | 某 Agent 的一次执行 | 一次启动到结束 |
| Session | Pi 的对话上下文 | 由 Pi 管理 |

三者不是同一个东西。一个 Task 可以有多个 Run；一个 Run 绑定一个 Session；Session 可以独立于 Task 存在（现有聊天就是这种）。

#### 状态机

```text
Task:
CREATED → QUEUED → RUNNING
                     ├─ WAITING_APPROVAL → RUNNING
                     ├─ WAITING_INPUT    → RUNNING
                     ├─ PAUSED           → RUNNING
                     ├─ FAILED
                     ├─ CANCELLED
                     └─ COMPLETED

Run:
QUEUED → RUNNING → COMPLETED / FAILED / CANCELLED
              └─ WAITING_APPROVAL / WAITING_INPUT（与 Task 同步）
```

规则：

- Task 状态由 Run 状态聚合，但允许用户手动取消/暂停。
- 状态变化只能通过 `TaskService.Transition`，禁止在 handler 里直接改字段。
- 每次转换写一条 `run_events`（终态）+ 更新 `tasks.updated_at`。
- `generation` 校验沿用 Supervisor 的语义；旧 generation 的事件丢弃。

#### 调度

- Go 侧 ticker（30s）扫描 `task_schedules.next_run_at`。
- 单实例锁保证只有一个调度器；沙箱实例有独立锁与独立 DB。
- 退出期间的到期任务：每个 schedule 只补跑一次（不是每个错过的周期都补），`catch_up=true` 默认；`false` 则标记 `missed` 并跳过。
- 补跑防雪崩：启动后按 30s 抖动依次触发；单次启动最多补跑 3 个任务（`max_catch_up_per_start`），其余排队并通知；补跑同样受 `max_parallel_runs` 与成本上限约束。
- 持久化 `last_catch_up_at`；启动中途崩溃不会在下次启动重复补跑同一批任务。
- 时区：存 UTC 毫秒 + 原始时区字符串；UI 按本地时间展示。
- 并发上限：全局 `max_parallel_runs`（默认 2）+ 每 workspace 1 个写任务；读任务可并行。
- 失败重试：默认 0 次，Task 级可配置；重试生成新 Run，不覆盖旧 Run。

#### 旧线程收养

- `origin=legacy` 的 Task 由 `state.json` 的 thread 导入，`session_path` 指向现有 Pi Session。
- 不改变现有聊天行为；首次发 Prompt 时自动静默收养，不弹窗打扰。
- Run 边界：一次用户 Prompt → `agent_settled` 为一个 Run；同一 Task 的后续 Prompt 生成新 Run，不覆盖旧 Run。
- UI 只提供「转换为命名任务」入口，不强制。
- 导入幂等键：`legacy_thread_id` 唯一索引。
- 旧 thread 的 `trust/workspaceId/title/status` 映射到 Task 字段；不复制消息。

#### Task Center UI

```text
Tasks                              + New Task
─────────────────────────────────────────────
Running
  Android BLE 优化                 ● Running
Waiting
  代码重构                         ◉ Approval
Completed
  API 文档生成                     ✓ Done
```

点击进入详情：Run 列表、当前会话、工具调用、用量、Worktree 路径、取消/重试/归档。

### 5.3 Agent Center（策略层，不是第二套执行器）

```go
type AgentProfile struct {
    ID             string
    Name           string
    Description    string
    Runtime        string            // "pi" | "remote-pi"
    DefaultModel   string
    SystemPrompt   string            // 或 file: 引用
    Skills         []string
    Tools          []string
    MCPServers     []string
    Permission     PermissionPolicy
    Limits         Limits
    Enabled        bool
}
```

与现有 Pi 资产的关系：

```text
Pi 的 ~/.pi/agent/agents/*.md    = 执行器侧的 Agent 定义（保留）
项目 agents/                     = 仓库内 Agent 定义（保留）
Pi 的 skills / extensions / MCP  = 执行能力（保留）
Go 的 AgentProfile               = 策略/默认值/UI 展示（R4 新增）
```

约束：

- Go 不复制 Agent 的 prompt 文件；只存引用（`agent://name` 或路径）。
- Go 不自行发现/加载 Skills；只做 allowlist 与展示。
- 同一 Agent 可切模型；模型不写死在 Agent 里。
- Agent Center UI 留到 R4；R4 只做「选择/编辑策略」，不做「新建执行引擎」。

预设（R4）：General / Coding / Research / Android / DevOps / Testing / Reviewer。

### 5.4 Model Center（元数据 + 计量，不做第二套 LLM 客户端）

- 现有 `ModelConfigService` 继续编辑 `~/.pi/agent/models.json`；这是唯一配置源。
- SQLite 只缓存模型元数据（context window、价格、能力）与 run 级 usage；缓存可失效重拉。
- 模型请求仍由 Pi 发起；Go 不发 HTTP。
- 用量口径：

```text
run 级：从 Pi 事件/GetSessionStats 聚合，写 usage_records
历史级：sessionindex/usage.go 扫 JSONL，用于回溯与对账
对账：同一 session_path + 时间窗，两边差异写入日志，不自动改数
```

- 密钥：不写 SQLite、不进日志；继续用 `models.json` 的 `$VAR` + 启动预检；Keychain 是后续项。

### 5.5 Capability Center（Go 管策略，Pi 管执行）

现有服务已经是起点：

```text
PiExtensionService   扩展安装/移除/启停/包管理
McpConfigService     MCP server 配置
ManagedSkillService  Skill 管理
PromptTemplateService 提示词模板
```

R4 只加一层「能力策略」：哪些 Agent 可见、哪些需要审批、哪些默认禁用。安装/卸载仍走现有服务，不静默写用户配置。

---

## 6. 执行环境

### 6.1 Workspace

- `workspaceId` 是稳定主键；工作区路径必须 `Abs + EvalSymlinks` 后比较。
- Worktree 子工作区新增 `parentWorkspaceId`，信任从父工作区继承（只读派生，不新增真相源）。
- Agent 的 cwd 只能落在 Task 绑定的 workspace 内；Terminal 的 cwd 同样受限（R2）。
- 远程 workspace 在 R2 不支持 worktree 隔离，必须显式报错，不静默降级。

### 6.2 Worktree（R2）

```text
<repo>/.worktrees/task-<shortid>/     ← git worktree 目录
branch: pidesk/task-<shortid>          ← 每个 Task 独立分支
base:   当前 HEAD 或用户指定 ref
```

流程：

1. 校验 repo root、目标路径不在 repo 内、分支名不冲突。
2. `git worktree add -b pidesk/task-<id> <path> <base>`。
3. 把 `<repo>/.worktrees/` 写入 `.git/info/exclude`（不改仓库 `.gitignore`）。
4. 注册子 workspace（`kind=worktree`, `parentWorkspaceId`），继承信任。
5. 删除前检查 dirty/untracked；不干净则标记 `orphaned`，交给用户处理。
6. Task 归档后 GC；启动时扫描孤儿 worktree，列在设置页。

环境隔离（必须处理）：

`git worktree` 只复制已跟踪文件；`node_modules/`、`.venv/`、`target/`、`.env*` 不会自动出现。创建后按 workspace 配置执行 bootstrap：

```json
{
  "worktreeBootstrap": {
    "mode": "command",
    "share": ["node_modules", ".venv"],
    "copy": [".env.example"],
    "command": "npm ci"
  }
}
```

模式：

```text
none     默认：不共享、不复制；任务自己负责安装依赖
symlink  把 share 列表软链到父仓库（快；但 npm/pip 可能写坏共享目录，只适合只读/测试）
copy     把 copy 列表复制到新 worktree（慢；只允许显式 allowlist）
command  执行 bootstrap_command（最可靠；失败则 Run 失败并给出可操作错误）
```

约束：

- 默认 `none`；不自动复制 `.env`、密钥、证书；需要时由用户显式加入 `copy`。
- `symlink` 前提示风险；同一依赖目录不要在两个 worktree 里同时执行安装命令。
- bootstrap 失败必须让 Run 失败并提示缺什么，不允许「带着空 node_modules 继续跑」。
- 删除 worktree 时不跟随软链；复制进去的 `.env` 随目录删除。
- 首次为一个 workspace 创建 worktree 时询问 bootstrap 策略，之后复用，不重复打扰。
- 分支已存在时：同 Task 复用；不同 Task 冲突则加 `-<attempt>` 后缀。
- 删除前除 dirty 检查外，还要检查未合并提交；有提交则保留分支并提示导出 patch，不自动删分支。

UI：

- 侧栏按父 workspace 分组，默认折叠 worktree 子项，避免 19 → 19+N 的视觉爆炸。
- 文件树展开态继续按 `workspaceId` 存；worktree 子项有独立 key。
- Diff/Terminal 默认指向当前 Run 的 worktree。

### 6.3 Terminal / Git / Diff

- Terminal 会话记录 `task_id/run_id/workspace_id/cwd`；cwd 越界拒绝。
- Git 操作继续走 CLI；R2 只加 `worktree add/remove/list/prune` 与 dirty 检查，不引 go-git。
- Diff 只读；提交/推送仍由用户或 Pi 工具执行，不在 UI 里加隐式写操作。
- 远程终端与远程 Git 保持现有行为；worktree 相关入口在远程 workspace 隐藏。

### 6.4 权限（R4，设计现在定）

三种模式：

```text
Trusted     工作区内工具直接执行；危险命令仍记录
Approval    Shell/写文件/网络等敏感工具需用户确认
Restricted  只读文件 + 白名单命令；其余拒绝
```

执行路径（关键）：

```text
Pi 进程内 tool_call
  → pi-desk-policy.ts（扩展）拦截
  → 本地 socket + token 回连 Go PolicyService
  → Go 按 workspace/agent/tool/input 决策
  → 返回 allow / deny / ask
  → ask 时扩展调 ctx.ui.confirm（或由 Go 推给 Vue 弹窗）
  → 决策写 permission_requests + run_events
```

约束：

- 不能只靠 Go 拦截：Pi 的工具在自己进程里执行，Go 看不到调用前的输入。
- 扩展必须 fail-closed：socket 超时/异常时，Approval/Restricted 模式拒绝执行。
- `--approve` 是全局信任开关，不是策略引擎；R4 不依赖它做细粒度判断。
- 扩展本身是受信代码，拥有完整系统权限；安装前必须提示（现有扩展安装流程已有确认）。
- 审计：每次决策记录 tool name、input 摘要、决策者、耗时；不记录密钥。

### 6.5 Sandbox（R5，backlog）

容器/沙箱执行需要独立进程管理、文件系统映射、网络策略与 macOS 签名权限；R0–R3 不做。权限模式的「Restricted」先做到路径与命令白名单，不承诺系统级隔离。

---

## 7. 事件系统

### 7.1 管道

```text
Pi raw event
  → Supervisor（已有：threadId + generation）
  → EventBus.Tap（新增，非阻塞）
      ├─ Normalizer（类型映射 + run 上下文）
      ├─ 批量写入 SQLite（终态立即，delta 合并）
      └─ app.Event.Emit("agent:event", normalized)
  → Vue（按域灰度）
```

### 7.2 事件契约

```go
type Event struct {
    ID         string          `json:"id"`
    Seq        uint64          `json:"seq"`
    Type       string          `json:"type"`
    TaskID     string          `json:"taskId,omitempty"`
    RunID      string          `json:"runId,omitempty"`
    ThreadID   string          `json:"threadId,omitempty"`
    Session    string          `json:"sessionPath,omitempty"`
    Generation uint64          `json:"generation,omitempty"`
    Runtime    string          `json:"runtime"`
    Timestamp  int64           `json:"ts"`
    Payload    json.RawMessage `json:"payload"`
}
```

类型（R1a 最小集）：

```text
run.started        run.completed      run.failed       run.cancelled    run.truncated
message.started    message.delta      message.completed
tool.started       tool.updated       tool.completed   tool.failed
permission.requested / approved / rejected
usage.updated
session.linked     session.resumed
```

规则：

- `ID` 全局唯一；`Seq` 按 run 单调递增；重复 `(run_id, seq)` 幂等丢弃。
- `Payload` 保留 Pi 原始字段的稳定子集；不稳定字段放 `raw` 并标注版本。
- 事件类型只增不改；废弃用 `deprecated` 字段，不删除。

### 7.3 顺序、幂等、背压

- 单 run 内严格顺序：Normalizer 按 `(run_id)` 单 goroutine 处理。
- 跨 run 不保证顺序；UI 按 run 分组渲染。
- `generation` 不匹配的事件直接丢弃（沿用 Supervisor 语义）。
- 背压策略：有界队列；先丢 `message.delta` 与 `tool.updated`，永不丢 `run.*`、`permission.*`、`tool.started/completed/failed`。
- `pi:event` 的发送不得被持久化阻塞；持久化走独立队列。

### 7.4 持久化与回放

```text
立即落库：run.started/completed/failed/cancelled、tool.started/completed/failed、permission.*、usage.updated
合并落库：message.delta（30–100ms 合并，只存最后一条快照或计数）
不落库：  纯 UI 状态（滚动位置、展开态）
```

回放：

- `TaskService.GetRunEvents(runID, afterSeq)` 返回增量。
- UI 刷新后先拉终态事件，再从 Pi JSONL 拉消息正文。
- 保留策略：终态事件永久；delta 合并记录保留 7 天；原始 `raw` 默认不落库。
- payload 粒度：只存摘要 + `payload_sha256` + `payload_bytes`；hash 在截断前对完整 payload 计算，工具输入/输出超过 16KB 截断，全文按 `session_path` 从 Pi JSONL 回读。hash 用于完整性与去重，不是密码学签名。
- 脱敏：工具输入里的 `Authorization`、`*_TOKEN`、`*_KEY`、已知 env 值在落库前替换为 `[redacted]`；无法判定的字段只存 hash。
- 单 Run 事件上限 10,000 条：超限先丢 `message.delta` 与 `tool.updated` 中间态；`run.*`、`permission.*`、`tool.started/completed/failed` 终态必须保留；写一条 `run.truncated` 并在 UI 提示。

### 7.5 双通道迁移

```text
R1a：pi:event（旧，冻结）+ agent:event（新，仅记录）
R1b：工具卡先切 agent:event；消息/流式最后切；默认新通道
R2：旧通道保留一个版本，供回滚；R3 再评估移除
```

验收信号：同一会话在两条通道下的工具卡数量、顺序、状态一致；切换开关不引起滚动跳动。

---

## 8. 数据库设计

### 8.1 表清单

```text
schema_version
tasks
task_runs
run_events
tool_executions
permission_requests
usage_records
task_schedules
agent_profiles          （R4）
settings
```

不建：`sessions`（Pi 管理）、`messages`（Pi JSONL）、`providers/models`（`models.json` 是真相源，可加缓存表但不作为配置源）。

### 8.2 关键表

```sql
CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL,
  workspace_id      TEXT NOT NULL,
  agent_profile_id  TEXT,
  origin            TEXT NOT NULL,          -- chat | legacy | scheduled | manual
  priority          INTEGER NOT NULL DEFAULT 0,
  legacy_thread_id  TEXT UNIQUE,
  metadata          TEXT NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL,       -- Unix ms
  updated_at        INTEGER NOT NULL,
  completed_at      INTEGER
);

CREATE TABLE task_runs (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  runtime        TEXT NOT NULL,
  session_path   TEXT,
  model_provider TEXT,
  model_id       TEXT,
  status         TEXT NOT NULL,
  attempt        INTEGER NOT NULL DEFAULT 1,
  generation     INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  started_at     INTEGER,
  finished_at    INTEGER
);

CREATE TABLE run_events (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  type           TEXT NOT NULL,
  payload        TEXT NOT NULL DEFAULT '{}', -- 摘要/截断后的 JSON
  payload_sha256 TEXT,                       -- 完整 payload 的 hash（非签名）
  payload_bytes  INTEGER NOT NULL DEFAULT 0,
  redacted       INTEGER NOT NULL DEFAULT 0,
  truncated      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  UNIQUE(run_id, seq)
);

CREATE TABLE usage_records (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  provider          TEXT,
  model             TEXT,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost    REAL NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE TABLE task_schedules (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                -- once | hourly | daily | weekdays | weekly
  time_of_day TEXT,                         -- HH:MM
  weekday     INTEGER,
  run_at      INTEGER,
  timezone    TEXT NOT NULL DEFAULT 'local',
  enabled     INTEGER NOT NULL DEFAULT 1,
  catch_up    INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_catch_up_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

索引：`tasks(status, updated_at)`、`task_runs(task_id, started_at)`、`run_events(run_id, seq)`、`task_schedules(enabled, next_run_at)`、`usage_records(run_id)`。

### 8.3 真相源规则

```text
消息正文       Pi JSONL
Session 列表   Pi JSONL + sessionindex
Task/Run       SQLite
运行事件       SQLite（终态）
用量           SQLite（run 级）+ sessionindex（历史对账）
模型配置       ~/.pi/agent/models.json
UI 偏好        state.json
```

远程 workspace 的 Task/Run 也落本地 DB，标 `runtime=remote-pi`；事件走同一 EventBus。若远端事件缺少 run 边界，用 Prompt 发出/结束合成边界，后续再补协议。

DB 故障时：聊天继续（走 Pi），Task Center 显示「记录不可用」，不阻塞发送。

### 8.4 `state.json` 导入与退役

R1a 做一次性导入（幂等、可 dry-run）：

```text
workspaces[]      → tasks 的 workspace 引用（不复制路径，只存 id）
desktop.threads[] → tasks（origin=legacy, legacy_thread_id 唯一）
desktop.scheduledTasks[] → task_schedules + tasks（origin=scheduled）
preferences/window → 继续留在 state.json，不导入
```

顺序：

1. 备份 `state.json` 到 `<data-dir>/backup/state-<ts>.json`。
2. 建库 + 迁移。
3. 导入；失败则回滚事务，保留原文件。
4. 写 `settings.imported_at`；再次启动跳过。
5. R1b 之前，`state.json` 仍是 UI 偏好的写路径；R1b 之后新任务只写 SQLite。

禁止：导入时删除 `state.json`；禁止双写同一字段（例如任务标题同时写两处）。

### 8.5 参数与保留

- WAL；`busy_timeout=5000`；`synchronous=NORMAL`；`foreign_keys=ON`；PRAGMA 走 DSN（§4.2）。
- 单文件上限预警 512MB；超过时提示归档旧 `run_events`。
- 单 Run 事件上限 10,000 条；截断规则见 §7.4。
- 备份：每日首次启动用 `VACUUM INTO` 生成一份快照（保留 7 份），失败不阻塞启动。

---

## 9. 前端

### 9.1 现状约束

```text
app.ts 5,115 行；handlePiEvent ≈362 行（docs/05 S-1 的基线已过期）
52 个 .vue 组件；3 个页面：task / scheduledTasks / usage
无 vue-router；单窗口；Pinia；i18n 已有
样式：layout.css 9k 行 + workbench.css 1.7k 行，Tailwind important 层
```

### 9.2 目标结构

```text
stores/
├── app.ts            [迁移期 facade] 逐步缩薄，保留对外 action 名称
├── events/           [新增] handlePiEvent 的纯 reducer
│   ├── message.ts
│   ├── tool.ts
│   ├── run.ts
│   └── index.ts
├── tasks.ts          [新增] Task/Run 查询与命令
├── usage.ts          [新增] 用量视图
└── workspace.ts      [逐步从 app.ts 拆出]
```

### 9.3 拆分顺序

1. **纯 reducer 化**：把 `handlePiEvent` 按事件类型拆成纯函数，输入输出都是状态；先把现有测试跑绿。
2. **域 store**：消息/工具/运行先搬；`app.ts` 保留 facade，避免全仓改 import。
3. **Task store**：只读查询 + 命令；不接管现有聊天状态。
4. **页面**：Task Center 作为新页面接入现有 `activePage`；暂不引入 router。
5. **灰度**：`useNormalizedEvents` 开关；关闭时完全走旧路径。

### 9.4 Task Center UI

复用现有 `ConversationPane` 渲染 Run 的会话；新增：

```text
TaskList.vue       列表 + 状态过滤
TaskDetail.vue     Run 切换、取消/重试/归档
RunTimeline.vue    工具调用 + 用量 + 错误
ScheduleEditor.vue 定时任务（R2 接 Go）
```

### 9.5 前端红线

- 新增 UI 文案一律走 `tr()`，不写死中文/英文。
- 旋转 loading 用 `v-spin` / `LoadingRing`，不写 CSS `animation: spin`。
- CSS 拥有几何量；模板不挂 `display`/`padding` utility 去覆盖 CSS。
- 多根组件必须 `inheritAttrs:false + v-bind="$attrs"`。
- 不为 UI 偏好新增 RPC 方法；走现有 preferences / opaque JSON。

---

## 10. 目录规划

```text
internal/
├── appservice/        [已有] 15 services；R1a 只加 event tap
├── pirpc/             [已有] NDJSON 帧
├── piruntime/         [已有] 进程监督
├── sessionindex/      [已有] JSONL 索引/usage
├── workspace/         [已有] catalog/state.json
├── repository/        [已有] git 只读
├── terminal/          [已有] PTY
├── remotessh/         [已有] SSH runtime
├── task/              [新增] domain + service + state machine
├── runtime/           [新增] interface + pi adapter + mock
├── eventbus/          [新增] normalize + fanout + persist
├── storage/sqlite/    [新增] migrations + queries
├── usage/             [新增] per-run accounting
├── worktree/          [新增] R2
└── policy/            [新增] R4

frontend/src/
├── stores/app.ts      [已有] 迁移期 facade
├── stores/events/     [新增] 纯 reducer
├── stores/tasks.ts    [新增]
├── stores/usage.ts    [新增]
├── components/TaskCenter/ [新增]
└── services/          [已有] binding 包装

refact/
├── GUIDE.MD           [本文]
├── GUIDE.v1.MD        [归档]
├── adr/               [R0 新增]
├── current-to-target.md
└── wails-upgrade-spike.md
```

原则：按阶段创建，不一次性铺满；不重命名现有包（避免无意义 diff 与 import 迁移）。

---

## 11. 实施计划 R0–R5

### R0：基线与 ADR（3–5 天）

**目标**：把「改哪里、以什么为准、怎么回滚」写清楚，不写业务代码。

工作项：

1. 归档 v1（已完成：`refact/GUIDE.v1.MD`）。
2. 刷新 `docs/01`–`05`：跑 `verify_refs.sh`，修漂移行号；标注「基准已从 `9fb21dd` 前进到 `6372141`」。
3. 写 ADR：
   - `adr/001-storage-truth-source.md`（D2）
   - `adr/002-event-contract.md`（§7）
   - `adr/003-task-run-semantics.md`（§5.2）
   - `adr/004-runtime-capabilities.md`（§5.1）
   - `adr/005-identity-and-scope.md`（D1/D4）
   - `adr/006-worktree-bootstrap.md`（§6.2）
   - `adr/007-sqlite-concurrency.md`（§4.2）
   - `adr/008-bindings-and-ci.md`（§4.3）
4. Wails 3.1 spike（独立分支，不合并；2026-11-08 已完成，见 `refact/wails-upgrade-spike.md`）。
5. 基线验证：`go test ./...`、`cd frontend && npm run build`、沙箱起窗 + 截图。
6. 写 `refact/current-to-target.md`：逐包标注保留/改造/新建。
7. 验证 bindings 生成幂等：生成后 `git diff --exit-code -- frontend/bindings`。

交付物：ADR 8 份、刷新后的 docs、升级 spike 报告、基线截图。

验收：

```bash
go test ./... && (cd frontend && npm run build)
git diff --exit-code -- frontend/bindings
./.pi/bin/dev-sandbox.sh
pidesk-shot --raise /tmp/r0-baseline.png
```

回滚：无代码改动，无需回滚。

### R1a：Go 数据面（2–3 周）

**目标**：在不改前端的前提下，把 Task/Run/Event/Usage 落到 SQLite，并抽出 Runtime 接口。

工作项：

1. `internal/storage/sqlite`：读写连接池（§4.2）、迁移、查询；DB 路径走 `appdirs`；沙箱可用。
2. `internal/task`：Task/Run 实体、状态机、服务；单元测试覆盖非法转换。
3. `internal/eventbus`：从 `AgentService` 事件回调 tap；Normalizer 最小集；payload 摘要/hash/截断/脱敏（§7.4）；异步批量落库。
4. `internal/runtime`：接口 + Pi Adapter（包装 Supervisor）+ Mock；能力声明。
5. `internal/usage`：run 级聚合；与 `sessionindex/usage.go` 对账日志。
6. `state.json` 导入：dry-run、备份、幂等。
7. 新事件通道 `agent:event` 并行发出；前端不消费。

验收：

```bash
go test ./... -race
# 起 3 个会话 → 3 个 run；重启 → 查询历史仍在
# 关闭开关 → 现有 UI 行为不变（A/B 截图）
# kill -9 后重开 → DB 可读，无损坏
# 并发写：50 goroutine × 100 条，-race 无 database is locked、无丢更新
```

回滚：开关关闭 → 不 tap、不写库；删除 DB；`state.json` 未被修改。

### R1b：前端解耦 + Task Center（3–4 周）

**目标**：把 5k 行 store 拆到可维护，并交付只读/基本操作的 Task Center。

工作项：

1. `handlePiEvent` → 纯 reducer（message/tool/run），现有测试全绿。
2. 域 store 拆分；`app.ts` 保留 facade。
3. Task Center 页面：列表、详情、Run 历史、用量、取消/重试/归档。
4. legacy thread 收养入口；不影响现有聊天。
5. `useNormalizedEvents` 开关；先工具卡，再运行态，最后消息。

验收：

```bash
cd frontend && npm run build && npm run test
# 开关关：与 R0 截图一致；开关开：工具卡数量/顺序/状态一致
# 滚动回归：现有 scroll/spin 测试 + 沙箱手动检查
```

回滚：开关关闭；Task Center 页面隐藏；store 拆分保留（纯内部重构）。

### R2：Worktree 隔离 + 调度器迁 Go（3–4 周）

前置：R1b 验收。若排期紧张，调度器可拆到 R3；Worktree 优先，因为它决定并行任务是否安全。

**目标**：两个 Task 可以并行改同一仓库；定时任务不再依赖前端定时器。

工作项：

1. `internal/worktree`：create/list/remove/prune、dirty 检查、分支命名、`.git/info/exclude`、bootstrap 策略（§6.2）。
2. 子 workspace 注册与分组；信任继承；文件树/会话按 workspaceId 隔离。
3. Terminal/Git/Diff 绑定 task/run/workspace；cwd 越界拒绝。
4. 前端 `scheduledTasks` → Go Scheduler；导入现有 `state.json` 任务。
5. 调度语义：进程存活时触发；退出期间到期任务下次启动补跑一次；补跑按 30s 抖动、单次最多 3 个、超出排队并通知；UI 显示 `missed`。
6. 远程 workspace 明确不支持 worktree（报错 + 文档）。

验收：

```bash
# 同一 repo 两个任务并行 → 两个 worktree，文件互不覆盖
# 删除任务 → clean 则移除；dirty 则标记 orphaned
# 缺 node_modules/.env 时 bootstrap 失败 → Run 失败并提示缺什么
# 退出 Pi Desk，跨过定时点，重启 → 补跑一次且只补一次
# 5 个任务同时到期 → 启动后错峰补跑，最多 3 个/批
```

回滚：worktree 入口隐藏；调度器开关回前端（保留旧代码一个版本）。

### R3：收口与硬化（2–3 周）

**目标**：达到日常可用，准备停下来评估。

工作项：

1. 性能：事件 tap < 5ms/条；批量落库 100ms；DB 查询 P95 < 50ms。
2. 稳定性：DB 损坏恢复、备份/还原、迁移失败回滚。
3. 观测：`/diagnostics` 增加 DB/Task/Event 状态；日志脱敏。
4. 文档：`refact/architecture.md`、`database.md`、`event-contract.md`、`operations.md`。
5. 回归：`go test ./... -race`、`npm run check`、沙箱 A/B、滚动/流式回归。
6. 事件截断与保留：10k/run、delta 7 天、终态永久；演练一次截断与 `run.truncated`。
7. bindings CI 检查接入（§4.3）。
8. 评估：连续使用 4 周，记录痛点，再决定 R4。

验收：上述指标 + 无 P0 数据丢失/卡死；关闭全部开关可回到 R0 行为。

### R4：Agent 策略 + 权限审批（backlog，3–4 周）

前置：R3 后 4 周日常使用 + 明确痛点。

范围：`AgentProfile`、能力 allowlist、`pi-desk-policy.ts` + Go PolicyService、审批 UI、审计。不做第二套 Agent Loop。

### R5：多 Runtime / ACP / Sandbox / 远程对等（backlog，4–8 周）

前置：R4 验收 + 明确的多 Runtime 需求。ACP 适配优先；Sandbox 最后。远程 worktree 对等、远程事件归一化单独评估。

---

## 12. 实施红线（18 条）

1. Go 业务层不得直接依赖 Wails Runtime；沿用现有 service 边界。
2. Runtime Adapter 不得操作 Vue；所有 UI 通过事件/查询。
3. 所有 Agent 事件必须先经过 Go；前端不得新增直连 Pi 的路径。
4. Task 状态变化只能走状态机；禁止在 handler 里直接改字段。
5. 数据库结构变化必须用迁移；禁止运行时 `ALTER` 猜字段。
6. 新增功能必须有测试；事件归一化必须有 golden fixture。
7. 不得绕过权限策略执行敏感操作（R4 后）。
8. 不得在代码、SQLite、日志里存 API Key；继续用 `models.json` + 环境变量。
9. 前端不得解析新增的 Pi 原始字段；旧 `pi:event` 冻结，新逻辑走 `agent:event`。
10. 跨模块调用优先接口；不得让 `internal/task` 反向依赖 `appservice`。
11. 不得修改 bundle id / 数据目录 / 单实例锁名（D1）。
12. 新增或修改 service 方法必须批量处理后重新生成 bindings，并提交生成文件。
13. Worktree 创建不得越出 repo root；删除前必须 dirty 检查。
14. 每个阶段必须有开关与回滚步骤；没有回滚方案的 PR 不合入。
15. SQLite 写路径只能走单写连接/单写 goroutine；禁止并发写与事务内另开连接。
16. Worktree 默认不复制/软链 `.env` 与密钥；只按显式 allowlist。
17. Bindings 生成后必须提交；CI 比对 `frontend/bindings`，有差异即失败。
18. `run_events` 截断只允许丢 delta/中间态；终态与权限事件必须保留。

---

## 13. 风险与缓解

| 风险 | 触发信号 | 缓解 |
|---|---|---|
| 双真相源漂移 | 同一任务两处标题/状态不一致 | D2 + 单向导入 + 禁止双写 |
| 事件替换引发滚动回归 | 切换开关后跳动/重复 | 双通道 + 逐域灰度 + golden |
| Wails 升级破坏面大 | 窗口/事件/bindings 回归 | 独立 spike，不合并 |
| Worktree 数量爆炸 | 侧栏 19→N、扫描变慢 | 父子分组 + 懒加载 + GC |
| Worktree 依赖缺失 | Agent 报找不到模块/命令 | bootstrap 策略 + 失败即停 |
| Catch-up 雪崩 | 启动瞬间多个任务并发 | 抖动 + 单次上限 + 通知 |
| SQLite 写锁 | database is locked | 单写连接 + busy_timeout |
| Bindings 漂移 | 前端类型/调用报错 | 生成 + CI diff 阻断 |
| Pi RPC 漂移 | 新 Pi 版本事件字段变 | 能力声明 + 活体测试 |
| SQLite 损坏 | 启动报 malformed | WAL + 备份 + 恢复流程 |
| 调度语义误解 | 用户以为退出也跑 | UI 明示进程存活 + catch-up |
| 权限无法完全拦截 | 扩展未装/超时 | fail-closed + 明示覆盖范围 |
| 范围蔓延 | R4 功能提前进 R1b/R2 | D4 + backlog 门禁 |
| 远程链路不同步 | helper manifest 失效 | 改协议后重生成 artifacts |

远程链路的构建顺序见 `docs/01` §6：改协议后先重生成 helper artifacts，再构建主程序。

补充高风险项（来自 `docs/05`）：生产包 DevTools 未关（P0-1）、更新 URL 指向别人仓库（P0-3）、`state.json` 覆盖写（P0-5）、CI 不跑 `develop`（E-5）。R0 先修 P0-1/P0-3；P0-5 由 D2 的迁移路径缓解，但写路径本身不在 R0–R3 重写。

---

## 14. 验收与证据规范

每个阶段至少三档证据：

```text
A 探针：窗口正在跑哪版代码
  curl -s http://localhost:9245/src/stores/app.ts | head
  # 或 /src/components/...；dev 模式从 vite 取模块

B 帧级：几何/命中/渲染
  pidesk-shot --raise /tmp/<stage>.png
  .pi/bin/hitprobe/（elementFromPoint / caret / scroll）

C 交互：点击/输入/拖拽
  只有用户能做；agent 必须明确写「C 待验 + 动作 + 期望信号」
```

命令基线：

```bash
go test ./... -race
cd frontend && npm run build && npm run test
wails3 generate bindings -f '' -clean=true -ts -i
git diff --exit-code -- frontend/bindings
./.pi/bin/dev-sandbox.sh          # 需要时起；收尾 stop
./.pi/bin/dev-sandbox.sh stop
```

证据格式：命令 + 关键输出 + 截图路径 + 结论。禁止「读源码推断」当验收。

---

## 15. R0 立即可执行清单

```text
[ ] 确认 refact/GUIDE.v1.MD 已归档（已完成）
[ ] 跑 verify_refs.sh，修 docs/01–05 的漂移行号
[ ] 写 adr/001–008
[ ] 定 SQLite 读写连接池与 PRAGMA（adr/007）
[ ] 定 Worktree bootstrap 策略（adr/006）
[ ] 加 bindings 生成/比对脚本（adr/008）
[ ] 开 spike/wails-3.1 分支，升级并记录 breaking changes
[ ] 跑基线：go test ./... / npm run build / 沙箱截图
[ ] 写 current-to-target.md（逐包保留/改造/新建）
[ ] 定 feature flag 机制（建议：userconfig 的 experimental 段 + env 覆盖）
[ ] 修 P0-1（生产 DevTools）与 P0-3（更新 URL 可配置）
[ ] 决定 refact/ 与 docs/ 是否进 git（docs/ 目前被 .gitignore 忽略）
```

---

## 附录 A：v1 → v2 章节映射

```text
v1 §1 定位            → v2 §1（收敛范围）
v1 §2 现状            → v2 §2（实测替换）
v1 §3 总体架构        → v2 §3（标注改造点）
v1 §4 技术选型        → v2 §4（删 koanf/go-git/fsnotify）
v1 §5.1 Runtime       → v2 §5.1（薄接口 + 能力）
v1 §5.2 Task Center   → v2 §5.2（加导入/调度/并发）
v1 §5.3 Agent Center  → v2 §5.3（策略层，共存）
v1 §6 Model Center    → v2 §5.4（不做第二套客户端）
v1 §7 执行环境        → v2 §6（Worktree 耦合/权限 hook）
v1 §8 事件系统        → v2 §7（双通道/背压/回放）
v1 §9 数据库          → v2 §8（真相源规则/导入）
v1 §10 MCP/Skills     → v2 §5.5（Go 策略 + Pi 执行）
v1 §11 UI             → v2 §9（增量，不重写）
v1 §12 目录           → v2 §10（按阶段创建）
v1 §13 六阶段         → v2 §11（R0–R5）
v1 §14 技术决策       → v2 §0 + §4
v1 §15 开发规范       → v2 §12（18 条红线）
v1 §16 最终架构       → v2 §3
v1 §17 落地顺序       → v2 §11
v1 §18 下一步         → v2 §15
```

## 附录 B：关键证据索引

```text
internal/piruntime/supervisor.go:23          SessionEvent{threadId, raw event}
internal/appservice/agent.go:44              agentRuntime 接口
internal/appservice/agent.go:101-105         事件回调 → app.Event.Emit("pi:event")
internal/sessionindex/usage.go               JSONL 扫描式 usage
frontend/src/stores/app.ts                  5,115 行；handlePiEvent
frontend/src/utils/scheduledTasks.ts         前端调度模型
frontend/src/stores/app.ts:502               scheduledTaskTimer
internal/repository/repository.go:189        git worktree list（只读）
internal/appservice/resources/pi-desk-subagents.ts:408  subagent 工具
internal/appservice/extensionconfig.go       扩展安装/包管理
internal/appservice/mcpconfig.go             MCP 配置
internal/appservice/modelconfig.go           models.json 编辑
go.mod                                       wails v3.0.0-beta.16
docs/05-技术债与风险清单.md                   P0-1/3/5、S-1/4、E-5
Pi docs/extensions.md:985                    tool_call 可 block
```

## 附录 C：已裁定的实现细节（v2.1）

以下 5 条已在评审中拍板，R0 不再重复讨论；实现时直接按此执行。

1. `run_events` payload 粒度
   - 存摘要 + `payload_sha256` + `payload_bytes`，不存工具输入/输出全文。
   - 单条 payload 超过 16KB 截断；全文按 `session_path` 从 Pi JSONL 回读。
   - 落库前脱敏：`Authorization`、`*_TOKEN`、`*_KEY`、已知 env 值替换为 `[redacted]`。
   - hash 用于完整性与去重，不是密码学签名。

2. 旧 thread 收养
   - 首次发 Prompt 自动静默收养，创建 Task + Run；不弹窗打扰。
   - Run 边界：一次 Prompt → `agent_settled`；后续 Prompt 生成新 Run，不覆盖旧 Run。
   - UI 只提供「转换为命名任务」入口，不强制。

3. 定时任务时区
   - 存储统一 UTC 毫秒；Schedule 语义按本地时区解析。
   - R2 不做每任务时区切换；数据结构保留 `timezone` 字段。
   - 必须覆盖 DST 边界测试（春季跳变、秋季重叠）。

4. 远程 workspace 的记录
   - Task/Run 落本地 DB，标 `runtime=remote-pi`；事件走同一 EventBus。
   - 远端事件缺 run 边界时，用 Prompt 发出/结束合成；不阻塞本地记录。
   - Worktree 隔离不支持远程；入口隐藏并给出说明。

5. 保留与截断
   - 终态事件永久；delta 合并记录 7 天；原始 `raw` 默认不落库。
   - 单 Run 上限 10,000 条事件；先丢 delta/中间态，保留终态与权限事件。
   - 触发截断写 `run.truncated`，UI 提示；DB 单文件 512MB 预警。
