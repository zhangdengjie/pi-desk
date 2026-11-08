# Pi Desk 下一代：个人 AI Agent Harness 完整技术实施方案

先说一个判断：

现在并不是从零开始做 Harness，而是已经有了一套比较完整的桌面端 Agent 宿主基础设施。真正需要做的是从现有 Pi Desk 的功能型 GUI，向一个具备任务编排、Agent 生命周期管理、工具治理和多 Runtime 扩展能力的 AI 工作平台演进。

我建议这次不要继续围绕上游 Pi Desk 的产品形态迭代，而是重新定义自己的产品架构。

下面这份方案按照可以交给 Pi、OpenCode 或其他 Coding Agent 分阶段执行的标准来设计。

---

# 一、项目定位与总体目标

## 1.1 产品定位

暂定名称：

**Personal Agent Workstation（PAW）**

定位：

一个基于本地优先架构的通用 AI Agent Harness。

核心原则：

1. Pi 是第一代默认 Agent Runtime，但不是系统唯一 Runtime。
2. Go 负责系统能力、任务管理、执行环境和调度。
3. Vue 负责桌面交互和可视化。
4. 模型与 Agent Runtime 解耦。
5. 本地优先，云端模型可选。
6. 所有任务、Session、工具调用和执行记录可追踪。
7. 不依赖任何单一模型厂商或 Harness 厂商。

### 目标产品形态

```text
┌──────────────────────────────────────────────┐
│              Personal Agent Workstation     │
├──────────────────────────────────────────────┤
│                                              │
│  Agent Center                                │
│  管理 Agent、Skills、Tools、MCP              │
│                                              │
│  Task Center                                 │
│  任务创建、执行、暂停、恢复、并发             │
│                                              │
│  Workspace Center                            │
│  项目、文件、Git、Terminal                   │
│                                              │
│  Model Center                                │
│  模型、Provider、路由、成本                  │
│                                              │
│  Runtime Center                              │
│  Pi、ACP、其他 Agent Runtime                 │
│                                              │
│  Settings                                    │
│  权限、安全、系统配置                        │
│                                              │
└──────────────────────────────────────────────┘
```

与传统 AI Coding 工具相比，你不再只是提供一个聊天窗口，而是提供一套 Agent 的运行和管理环境。

---

# 二、现有 Pi Desk 项目分析

先明确哪些东西值得保留，哪些需要重新设计。

我从目前仓库 README 和 design.md 中看到的结构是：

```text
pi-desk/
├── cmd/
├── internal/
├── frontend/
├── build/
├── test/
├── main.go
├── go.mod
├── Taskfile.yml
├── README.md
└── design.md
```

目前运行模型：

```text
Vue
  │
  ▼
Wails v3 Service
  │
  ▼
Go Host
  │
  ├── pi --mode rpc
  │
  ├── Local Filesystem / Git / PTY
  │
  └── SSH → Remote Helper
```

已有能力包括：

- Workspace / Session 管理。
- Pi RPC 通信。
- Repository 文件检索和预览。
- Terminal。
- Git 相关能力。
- Extensions 管理。
- 定时任务。
- Prompt 队列。
- 文件引用和图片附件。
- SSH 远程 Workspace。
- 远程任务执行。

这些不是简单的聊天 GUI 功能，实际上已经构成了 Harness 的基础设施。[GitHub](https://github.com/zhangdengjie/pi-desk/blob/main/README.md)

## 2.1 现有功能处理建议

| 现有模块 | 处理方式 | 原因 |
|---|---|---|
| Wails v3 | 保留 | 桌面基础设施 |
| Vue 前端 | 保留技术栈，重构 UI | 重新定义交互 |
| Pi RPC Client | 保留并抽象 | 第一代 Runtime |
| Session Manager | 重构 | 从 Session 转为 Task + Session |
| Workspace | 保留并增强 | 多任务隔离 |
| Repository | 保留 | 代码浏览能力 |
| Terminal / PTY | 保留并增强 | Agent 执行环境 |
| Git | 保留并增强 | Worktree、Diff |
| Extensions | 保留并扩展 | Agent 能力管理 |
| Scheduler | 保留并重构 | 统一任务调度 |
| SSH Remote | 保留 | 远程执行能力 |

**特别建议：不要直接推翻当前代码。**

保留已有可靠的底层能力，重新建立应用层架构。

另外，你当前使用的 Wails v3 已经在 2026 年 10 月正式发布 3.0.0。多窗口、Services、系统托盘、原生菜单和事件机制都比较适合这类桌面工作台，不需要退回 v2。[Wails](https://wails.io/blog/wails-v3-released/?utm_source=chatgpt.com)

---

# 三、总体技术架构

这是整个项目最重要的设计。

我建议采用：

**Frontend + Application Core + Agent Runtime + Execution Environment**

四层架构。

## 3.1 总体架构图

```text
┌─────────────────────────────────────────────────────┐
│                   Vue 3 Frontend                    │
│                                                     │
│  ┌──────────┐ ┌──────────┐ ┌────────────────────┐  │
│  │ Dashboard│ │ Task     │ │ Agent              │  │
│  │          │ │ Center   │ │ Center             │  │
│  └──────────┘ └──────────┘ └────────────────────┘  │
│                                                     │
│  ┌──────────┐ ┌──────────┐ ┌────────────────────┐  │
│  │Workspace │ │ Model    │ │ Runtime            │  │
│  │          │ │ Center   │ │ Center             │  │
│  └──────────┘ └──────────┘ └────────────────────┘  │
│                                                     │
│  Pinia + Vue Router + TypeScript                    │
└──────────────────────┬──────────────────────────────┘
                       │
                  Wails Bridge
                       │
┌──────────────────────▼──────────────────────────────┐
│                   Go Application Core               │
│                                                     │
│  Application Services                               │
│  ├── Task Service                                   │
│  ├── Agent Service                                  │
│  ├── Workspace Service                              │
│  ├── Session Service                                │
│  ├── Model Service                                  │
│  ├── Runtime Service                                │
│  ├── Permission Service                             │
│  └── Scheduler Service                              │
│                                                     │
│  Domain Layer                                       │
│  ├── Task                                           │
│  ├── Agent                                          │
│  ├── Workspace                                      │
│  ├── Session                                        │
│  ├── Execution                                      │
│  └── Event                                          │
│                                                     │
│  Infrastructure                                     │
│  ├── SQLite                                         │
│  ├── Event Bus                                      │
│  ├── Process Manager                                │
│  ├── PTY Manager                                    │
│  ├── Git Manager                                    │
│  ├── File Manager                                   │
│  └── Secret Manager                                 │
└──────────────────────┬──────────────────────────────┘
                       │
                Agent Runtime API
                       │
       ┌───────────────┼────────────────┐
       │               │                │
┌──────▼──────┐ ┌──────▼──────┐ ┌───────▼──────┐
│ Pi Runtime  │ │ ACP Runtime │ │ Custom Agent │
│             │ │             │ │ Runtime      │
│ Pi RPC      │ │ ACP Client  │ │              │
└──────┬──────┘ └──────┬──────┘ └───────┬──────┘
       │               │                │
       └───────────────┼────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                 Execution Environment               │
│                                                     │
│  Local Workspace                                    │
│  ├── Filesystem                                     │
│  ├── Shell                                          │
│  ├── Git                                            │
│  └── ADB                                            │
│                                                     │
│  Remote Workspace                                   │
│  ├── SSH                                            │
│  └── Remote Helper                                  │
│                                                     │
│  Sandbox                                            │
│  └── Isolated Execution                             │
└─────────────────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                    Model Layer                      │
│                                                     │
│  Local                                             │
│  ├── Ollama                                         │
│  └── OpenAI Compatible API                          │
│                                                     │
│  Cloud                                             │
│  ├── OpenCode Go                                    │
│  ├── Gemini                                         │
│  ├── Claude                                         │
│  └── OpenAI                                         │
└─────────────────────────────────────────────────────┘
```

这里有一个重要原则：

**Go Application Core 不直接依赖 Pi。**

Go 只依赖统一的 Agent Runtime Interface。

这样以后即使 Pi 改变架构，或者你想使用其他 Runtime，也不需要重写整个应用。

---

# 四、技术选型

建议固定一套技术栈，避免开发过程中反复更换。

## 4.1 后端

| 技术 | 选型 | 用途 |
|---|---|---|
| 语言 | Go | 核心业务 |
| 桌面框架 | Wails v3 | 桌面容器 |
| 数据库 | SQLite | 本地数据 |
| ORM | sqlc 或现代轻量 SQL 层 | 数据访问 |
| 日志 | slog | 统一日志 |
| 配置 | koanf | 配置管理 |
| 进程管理 | os/exec | Agent Runtime |
| PTY | creack/pty | 终端 |
| Git | go-git + 原生 Git CLI | Git 管理 |
| 调度 | 自研 Scheduler | Agent 任务 |
| 文件监听 | fsnotify | Workspace 监听 |

数据库我更倾向于 SQLite，而不是 ObjectBox。

原因：

- 本地任务系统需要事务。
- 需要多表关联。
- 需要查询任务、Session、事件。
- 需要支持迁移。
- 数据结构比较复杂。

SQLite 足够胜任。

建议使用 WAL 模式。

## 4.2 前端

| 技术 | 选型 |
|---|---|
| Vue | Vue 3 |
| 语言 | TypeScript |
| 构建 | Vite |
| 状态管理 | Pinia |
| 路由 | Vue Router |
| UI | 自定义组件 + 少量组件库 |
| 图标 | Lucide |
| Markdown | markdown-it |
| 代码高亮 | Shiki |
| Diff | Monaco Diff Editor |
| 终端 | xterm.js |
| 虚拟列表 | Vue Virtual Scroller |

建议保留你现有 design.md 的设计方向。

我认为你现在的设计比较适合开发者工作台：

- 44px 顶部栏。
- 264px 任务侧栏。
- 中间对话区域。
- 360px Inspector。
- 深浅色主题。
- 技术感、低干扰。

这些可以作为新版 UI 的初始设计规范。

## 4.3 Runtime

第一阶段：

```text
Pi Runtime
    │
    ▼
pi --mode rpc
    │
    ▼
JSONL stdin/stdout
    │
    ▼
Go Pi Adapter
```

这里我建议继续使用 RPC，而不是立即改成 SDK。

原因是：

Pi SDK 是 TypeScript 接口，嵌入 Node.js/Bun 进程更自然；你的主后端是 Go，如果采用 SDK，需要额外引入 Node 宿主或桥接层。

Pi RPC 则可以让 Go 直接管理 Pi 子进程。

Pi 官方文档同时提供 SDK 和 CLI Integration，RPC 模式适合语言无关的宿主集成。[Pi](https://pi.dev/docs/latest/sdk?utm_source=chatgpt.com)

参考：

- [Pi SDK 文档](https://pi.dev/docs/latest/sdk?utm_source=chatgpt.com)
- [Pi Extensions 文档](https://pi.dev/docs/latest/extensions?utm_source=chatgpt.com)

---

# 五、核心模块详细设计

这部分是具体开发的主体。

## 5.1 Agent Runtime Manager

这是整个系统最重要的抽象。

建议设计统一接口：

```go
type AgentRuntime interface {

    // Runtime 基础信息
    Info() RuntimeInfo

    // 初始化
    Start(ctx context.Context, config RuntimeConfig) error

    // 创建 Session
    CreateSession(ctx context.Context, req CreateSessionRequest) (SessionInfo, error)

    // 恢复 Session
    ResumeSession(ctx context.Context, sessionID string) error

    // 发送消息
    Prompt(ctx context.Context, req PromptRequest) error

    // 中断执行
    Cancel(ctx context.Context, sessionID string) error

    // 获取运行状态
    Status(ctx context.Context, sessionID string) (RuntimeStatus, error)

    // 订阅事件
    Subscribe(ctx context.Context) (<-chan RuntimeEvent, error)

    // 关闭
    Close() error
}
```

然后实现：

```text
internal/runtime/
├── interface.go
├── manager.go
│
├── pi/
│   ├── adapter.go
│   ├── client.go
│   ├── protocol.go
│   ├── process.go
│   ├── events.go
│   └── session.go
│
├── acp/
│   ├── adapter.go
│   └── client.go
│
└── mock/
    └── adapter.go
```

第一阶段只实现 Pi。

ACP 作为后续扩展。

为什么选择 ACP？

ACP 是一种让 Agent 与 Client 通过 JSON-RPC 进行通信的协议，包含 Session 创建、恢复、Prompt、进度通知、权限请求和取消等机制。它适合未来统一接入不同 Agent。[GitHub](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/overview.mdx?utm_source=chatgpt.com)

但是不要强迫 Pi 也必须通过 ACP 运行。

Pi RPC 和 ACP 应当分别实现 Adapter，最后映射到你的内部统一事件模型。

---

## 5.2 Task Center

这是新版 Harness 最应该投入精力的模块。

我认为它甚至比聊天 UI 更重要。

需要区分三个概念：

| 概念 | 作用 |
|---|---|
| Task | 用户希望完成的一项工作 |
| Agent Run | 某个 Agent 对 Task 的一次执行 |
| Session | Agent 的对话上下文 |

它们不是同一个东西。

例如：

用户创建任务：

```text
Task:
优化 Android BLE 数据处理
```

系统可以创建：

```text
Task ID: task_001

Agent Runs:
├── Run 001
│   └── Coding Agent
│       └── Session A
│
├── Run 002
│   └── Review Agent
│       └── Session B
│
└── Run 003
    └── Test Agent
        └── Session C
```

每个 Run 可以使用不同模型、不同 Session。

### Task 状态机

建议：

```text
CREATED
   │
   ▼
QUEUED
   │
   ▼
RUNNING
   │
   ├──── WAITING_APPROVAL
   │          │
   │          ▼
   │       RUNNING
   │
   ├──── WAITING_INPUT
   │          │
   │          ▼
   │       RUNNING
   │
   ├──── PAUSED
   │       │
   │       ▼
   │    RUNNING
   │
   ├──── FAILED
   │
   ├──── CANCELLED
   │
   ▼
COMPLETED
```

这里一定要区分：

- Task 状态。
- Agent Run 状态。
- Runtime 状态。

否则后期做多 Agent 时容易出现状态混乱。

### Task Center UI

建议采用类似 Codex 的任务工作区：

```text
┌───────────────────────────────────────────────┐
│ Tasks                             + New Task  │
├───────────────────────────────────────────────┤
│                                               │
│ Running                                       │
│ ├── Android BLE 优化              ● Running   │
│ ├── Jenkins 构建失败分析          ● Running   │
│                                               │
│ Waiting                                       │
│ ├── 代码重构                    ◉ Approval    │
│                                               │
│ Completed                                     │
│ ├── API 文档生成                  ✓ Done      │
│ └── 单元测试生成                  ✓ Done      │
│                                               │
└───────────────────────────────────────────────┘
```

每个 Task 点击后进入独立工作空间。

---

## 5.3 Agent Center

Agent 是预定义的工作角色。

建议数据结构：

```go
type Agent struct {
    ID          string
    Name        string
    Description string

    RuntimeID   string
    ModelID     string

    SystemPrompt string

    Skills      []string
    Tools       []string
    MCPServers  []string

    Permissions PermissionPolicy

    MaxSteps    int
    MaxTokens   int

    Enabled     bool
}
```

预设 Agent：

| Agent | 主要用途 |
|---|---|
| General | 日常任务 |
| Coding | 代码开发 |
| Research | 技术研究 |
| Android | Android 开发 |
| DevOps | Jenkins、Docker、Linux |
| Testing | 自动化测试 |
| Reviewer | 代码审查 |

这里建议不要把 Agent 与 Model 绑定得太死。

Agent 定义工作角色，Model 定义执行能力。

同一个 Agent 可以随时切换模型。

### Agent 配置示例

```json
{
  "id": "android-developer",
  "name": "Android Developer",
  "runtime": "pi",
  "model": "qwen3-coder",
  "systemPrompt": "You are an Android development expert.",
  "skills": [
    "android-development",
    "kotlin",
    "gradle"
  ],
  "tools": [
    "filesystem",
    "terminal",
    "git",
    "adb"
  ],
  "permissions": {
    "filesystem": "workspace",
    "terminal": "approval",
    "network": "restricted"
  }
}
```

注意：这是你的应用层 Agent 配置，不应该直接等同于 Pi 的原生配置格式。

由 Runtime Adapter 负责转换。

---

# 六、Model Center：统一模型管理

结合你目前的使用情况，我建议这一层单独建设。

你已经使用过：

- Ollama。
- Qwen。
- Gemma。
- Gemini。
- OpenCode Go。
- Claude 等模型。

所以模型系统不应该依赖 Pi 内部的模型配置结构。

## 6.1 模型架构

```text
Model Center
     │
     ▼
Model Registry
     │
     ├── Provider Registry
     │      ├── Ollama
     │      ├── OpenAI Compatible
     │      ├── Anthropic
     │      ├── Google
     │      └── OpenCode
     │
     ▼
Model Catalog
     │
     ├── Model ID
     ├── Context Window
     ├── Max Output
     ├── Thinking Support
     ├── Input Price
     └── Output Price
```

需要注意：

Model Center 管理的是模型元数据和 Provider 配置。

真正发起模型请求时，第一阶段仍然由 Pi Runtime 使用它自己的 Provider 系统。

不要自己再实现一套完整的 LLM API 调用逻辑。

## 6.2 模型路由

后续可以支持：

```text
Task
  │
  ▼
Model Router
  │
  ├── 简单任务 → 本地 Qwen
  │
  ├── 普通编码 → 低成本云模型
  │
  ├── 复杂推理 → 高能力模型
  │
  └── 代码审查 → 独立模型
```

路由策略可以基于：

- 任务类型。
- Context Window。
- 模型能力。
- 用户指定。
- 成本预算。
- 当前 Provider 可用性。

这里特别建议加入预算限制。

例如：

```json
{
  "maxInputTokens": 100000,
  "maxOutputTokens": 20000,
  "maxCost": 0.5,
  "allowFallback": true
}
```

你之前使用 OpenCode Go 的时候，11 次请求已经累计产生 103,642 输入 Token，缓存读取 277,089 Token。

这说明你的 Harness 需要特别重视上下文管理和 Token 消耗统计。

建议每次 Agent Run 都记录：

```text
Input Tokens
Output Tokens
Cache Read Tokens
Cache Write Tokens
Estimated Cost
Provider
Model
```

不要只记录最终对话的 Token。

---

# 七、Execution Environment：执行环境管理

这是从普通 GUI 进化到真正 Harness 的关键。

## 7.1 Workspace

建议 Workspace 结构：

```text
Workspace
│
├── Local Workspace
│   ├── Repository
│   ├── Git
│   └── Terminal
│
├── Remote Workspace
│   ├── SSH
│   └── Remote Helper
│
└── Isolated Workspace
    ├── Git Worktree
    └── Sandbox
```

每个 Task 必须明确关联 Workspace。

不能允许 Agent 随意切换工作目录。

## 7.2 Worktree

建议引入 Git Worktree。

例如：

```text
project/
│
├── main
│
├── .worktrees/
│   ├── task-001/
│   ├── task-002/
│   └── task-003/
```

每个并行 Task 使用独立 Worktree。

好处：

- 避免多 Agent 修改同一个文件。
- 可以独立提交代码。
- 可以独立查看 Diff。
- 可以随时丢弃失败任务。
- 可以进行代码审查。

## 7.3 Terminal

建议继续使用 Go PTY。

每个 Terminal 需要有：

```go
type TerminalSession struct {
    ID          string
    WorkspaceID string
    TaskID      string

    Cwd         string
    PID         int

    Status      string
}
```

终端能力：

- 创建。
- 输入。
- 输出流。
- 调整尺寸。
- 中止。
- 关闭。
- Session 恢复能力（通过进程/终端生命周期管理实现，不能简单假设 PTY 自身可以恢复）。

前端继续使用 xterm.js。

## 7.4 权限与 Sandbox

这里不要忽略。

Pi 的默认 Bash、文件编辑和扩展能力拥有较高系统权限。Pi 官方也明确提醒，扩展运行时可以访问操作系统资源，沙箱需要由宿主负责。[Pi](https://pi.dev/docs/latest/extensions?utm_source=chatgpt.com)

建议定义三种权限模式：

| 模式 | 说明 |
|---|---|
| Trusted | 用户完全信任的 Workspace |
| Approval | Shell、写文件等敏感操作需要审批 |
| Restricted | 受限文件系统和执行环境 |

权限粒度：

```text
Filesystem
├── Read
├── Write
├── Delete

Terminal
├── Execute
├── Network
├── Elevated Privileges

Git
├── Read
├── Commit
├── Push

Network
├── Allowlist
└── Deny
```

不要仅仅依赖 Agent 的 System Prompt 约束权限。

真正的权限判断应该由 Go Host 执行。

建议第一阶段实现：

1. Workspace 路径限制。
2. 危险 Shell 命令审批。
3. 文件写入审批。
4. 项目级信任。
5. 敏感文件保护。
6. Agent 运行日志。

后续再增加容器或系统级 Sandbox。

---

# 八、事件系统：连接所有模块

这是我建议你从现有 Pi RPC 通信架构中重点升级的部分。

不要让 Vue 直接理解 Pi 的原始 RPC 消息。

应该设计统一 Event Bus。

## 8.1 内部事件结构

```go
type AgentEvent struct {
    ID          string

    TaskID      string
    RunID       string
    SessionID   string

    Runtime     string

    Type        string

    Timestamp   int64

    Payload     json.RawMessage
}
```

事件类型：

```text
task.created
task.queued
task.started
task.completed
task.failed

agent.started
agent.stopped
agent.thinking

message.started
message.delta
message.completed

tool.started
tool.progress
tool.completed
tool.failed

permission.requested
permission.approved
permission.rejected

session.created
session.resumed
session.updated

terminal.output
terminal.exit

workspace.changed
git.diff.updated
```

## 8.2 事件流转

```text
Pi RPC
   │
   ▼
Pi Event Parser
   │
   ▼
Runtime Event
   │
   ▼
Event Normalizer
   │
   ▼
Application Event Bus
   │
   ├── SQLite Persistence
   │
   ├── Task State Machine
   │
   ├── Usage Tracker
   │
   └── Wails Event Bridge
            │
            ▼
          Vue UI
```

重点：

**所有事件都必须先经过 Go Application Core。**

不要出现：

```text
Pi RPC → Vue
```

这种直接通信方式。

否则未来更换 Runtime 时，前端会受到很大影响。

## 8.3 事件可靠性

建议：

- Event ID 全局唯一。
- 任务事件持久化。
- UI 可以重新加载事件。
- 高频 Token Delta 可以合并。
- 工具执行结果必须保留。
- Event Bus 支持背压。
- UI 断开不影响 Agent 执行。

特别是 Token Delta，不需要每个字符都写 SQLite。

可以按 30～100ms 合并文本更新，而关键状态事件立即持久化。

---

# 九、数据库设计

建议 SQLite。

核心表：

```text
providers
models

agents
agent_skills
agent_tools

workspaces
workspace_trust

tasks
task_runs

sessions
session_bindings

agent_events

tool_executions
permission_requests

terminal_sessions

mcp_servers

schedules

usage_records

settings
```

### 重点表结构

**tasks**

| 字段 | 类型 |
|---|---|
| id | TEXT |
| title | TEXT |
| description | TEXT |
| status | TEXT |
| workspace_id | TEXT |
| agent_id | TEXT |
| priority | INTEGER |
| created_at | INTEGER |
| updated_at | INTEGER |

**task_runs**

| 字段 | 类型 |
|---|---|
| id | TEXT |
| task_id | TEXT |
| runtime_id | TEXT |
| session_id | TEXT |
| model_id | TEXT |
| status | TEXT |
| started_at | INTEGER |
| finished_at | INTEGER |

**agent_events**

| 字段 | 类型 |
|---|---|
| id | TEXT |
| task_id | TEXT |
| run_id | TEXT |
| session_id | TEXT |
| event_type | TEXT |
| payload | TEXT |
| created_at | INTEGER |

**usage_records**

| 字段 | 类型 |
|---|---|
| id | TEXT |
| run_id | TEXT |
| provider | TEXT |
| model | TEXT |
| input_tokens | INTEGER |
| output_tokens | INTEGER |
| cache_read_tokens | INTEGER |
| cache_write_tokens | INTEGER |
| estimated_cost | REAL |

建议所有时间统一存储 Unix 毫秒。

Session 的原始对话仍然由 Pi 自己管理。

你的 SQLite 保存 Session 元数据、索引、关联和运行记录。

不要在第一阶段重新实现 Pi Session 文件格式。

---

# 十、MCP、Skills 和 Tools 系统

这三者必须区分。

| 类型 | 定位 |
|---|---|
| Tool | Agent 可以执行的具体操作 |
| MCP | 外部工具服务接入协议 |
| Skill | Agent 完成特定任务的方法和知识 |

建议统一管理：

```text
Capability Center
│
├── Built-in Tools
│   ├── Filesystem
│   ├── Terminal
│   ├── Git
│   ├── ADB
│   └── Jenkins
│
├── MCP Servers
│   ├── Filesystem MCP
│   ├── Git MCP
│   └── Custom MCP
│
└── Skills
    ├── Android Development
    ├── Kotlin
    ├── Jenkins
    ├── Appium
    └── Linux Troubleshooting
```

### 一个重要设计

不要把所有工具全部暴露给所有 Agent。

例如：

Android Agent：

```text
filesystem
terminal
git
adb
gradle
```

Research Agent：

```text
browser
filesystem-read
web-search
```

DevOps Agent：

```text
terminal
docker
jenkins
ssh
```

由 Agent 配置决定工具集合。

Pi 的 Extension 系统可以注册自定义工具、监听生命周期事件、注入上下文以及实现权限门控，因此应优先利用现有能力，而不是重复造一套 Pi 内部机制。[Pi](https://pi.dev/docs/latest/extensions?utm_source=chatgpt.com)

---

# 十一、前端 UI 设计

我建议采用四个主要工作区域。

## 11.1 主界面

```text
┌──────────────────────────────────────────────────────────┐
│ PAW      Workspace: Android App       Model: Qwen  ▼     │
├────────────┬──────────────────────────────┬──────────────┤
│            │                              │              │
│ Dashboard  │                              │ Inspector    │
│            │                              │              │
│ Tasks      │                              │ Files        │
│            │        Conversation           │              │
│ Agents     │                              │ Context      │
│            │                              │              │
│ Workspaces │                              │ Git Diff     │
│            │                              │              │
│ Models     │                              │ Terminal     │
│            │                              │              │
│ Settings   │                              │              │
│            │                              │              │
├────────────┴──────────────────────────────┴──────────────┤
│ Agent: Coding   ● Running     Tokens: 12500   Cost: 0.02 │
└──────────────────────────────────────────────────────────┘
```

## 11.2 Task Detail

点击任务进入详情：

```text
┌─────────────────────────────────────────────────────────┐
│ Android BLE 优化                        ● Running       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ Conversation                                            │
│                                                         │
│ User:                                                   │
│ 分析当前 BLE 数据接收流程并优化                          │
│                                                         │
│ Agent:                                                  │
│ 正在分析 BLE 数据处理代码...                             │
│                                                         │
│ Tool:                                                   │
│ read RealDataService.kt                                 │
│                                                         │
│ Tool:                                                   │
│ grep BluetoothGattCallback                              │
│                                                         │
│ Agent:                                                  │
│ 找到了三个可能存在的问题...                              │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ Input                                                   │
│                                                         │
│ + File    + Image    @Agent    Model    Send            │
└─────────────────────────────────────────────────────────┘
```

## 11.3 Tool Inspector

工具调用应该是可展开的结构化组件。

例如：

```text
┌──────────────────────────────────────────┐
│ Terminal                                 │
│                                          │
│ $ ./gradlew assembleDebug                │
│                                          │
│ > Task :app:compileDebugKotlin            │
│ > Task :app:mergeDebugResources           │
│                                          │
│ BUILD SUCCESSFUL                         │
│                                          │
│ Exit Code: 0                             │
│ Duration: 18.2s                          │
└──────────────────────────────────────────┘
```

## 11.4 Agent Dashboard

```text
Agents

Coding Agent       ● Running
Research Agent     ○ Idle
Android Agent      ● Running
DevOps Agent       ○ Idle
Testing Agent      ◉ Waiting
```

这里要区分：

Agent 是配置和能力定义。

Run 是实际执行实例。

不要把 Agent 列表直接做成 Session 列表。

---

# 十二、项目代码目录规划

建议最终形成如下结构。

```text
paw/
│
├── cmd/
│   └── paw/
│       └── main.go
│
├── internal/
│
│   ├── app/
│   │   ├── bootstrap.go
│   │   └── lifecycle.go
│
│   ├── domain/
│   │   ├── task/
│   │   ├── agent/
│   │   ├── session/
│   │   ├── workspace/
│   │   ├── runtime/
│   │   └── event/
│
│   ├── service/
│   │   ├── task_service.go
│   │   ├── agent_service.go
│   │   ├── workspace_service.go
│   │   ├── session_service.go
│   │   ├── model_service.go
│   │   ├── runtime_service.go
│   │   └── scheduler_service.go
│
│   ├── runtime/
│   │   ├── interface.go
│   │   ├── manager.go
│   │   ├── pi/
│   │   ├── acp/
│   │   └── mock/
│
│   ├── execution/
│   │   ├── terminal/
│   │   ├── filesystem/
│   │   ├── git/
│   │   ├── worktree/
│   │   ├── sandbox/
│   │   └── ssh/
│
│   ├── capability/
│   │   ├── tools/
│   │   ├── mcp/
│   │   └── skills/
│
│   ├── security/
│   │   ├── permission/
│   │   ├── approval/
│   │   └── secrets/
│
│   ├── storage/
│   │   ├── sqlite/
│   │   └── migrations/
│
│   ├── eventbus/
│   │
│   ├── scheduler/
│   │
│   └── platform/
│
├── frontend/
│   └── src/
│       ├── api/
│       ├── components/
│       ├── composables/
│       ├── layouts/
│       ├── pages/
│       ├── stores/
│       ├── types/
│       └── styles/
│
├── build/
├── refact/
│   ├── architecture.md
│   ├── database.md
│   ├── runtime-protocol.md
│   ├── security.md
│   └── development.md
│
├── test/
│   ├── integration/
│   └── fixtures/
│
├── go.mod
├── Taskfile.yml
└── README.md
```

注意：

这是一种目标目录结构，不建议第一天就全部创建。

应该随着模块实现逐步形成。

---

# 十三、开发实施计划

这里给出可以直接执行的开发顺序。

我建议分为六个阶段。

## Phase 0：现有项目梳理

预计：2～3 天。

目标：建立新版架构基础。

任务：

1. 分析现有 pi-desk 所有 Go 包。
2. 分析 Vue 组件。
3. 整理已有 RPC 协议。
4. 整理 Session 生命周期。
5. 整理 Workspace 和 PTY 实现。
6. 整理定时任务实现。
7. 输出新旧模块映射文档。

交付物：

```text
refact/
├── current-architecture.md
├── module-mapping.md
├── target-architecture.md
└── migration-plan.md
```

验收标准：

已有功能全部有明确的保留、重构或废弃结论。

## Phase 1：Harness Core

预计：1～2 周。

这是最重要的阶段。

开发内容：

| 功能 | 优先级 |
|---|---|
| Runtime Interface | P0 |
| Pi Adapter | P0 |
| Process Manager | P0 |
| Event Normalizer | P0 |
| SQLite | P0 |
| Task Model | P0 |
| Session Model | P0 |
| Task State Machine | P0 |
| Vue Chat | P0 |
| Event Bridge | P0 |
| Model Selector | P1 |
| Token Usage | P1 |

阶段目标：

完成：

```text
创建任务
  ↓
选择 Agent
  ↓
选择 Model
  ↓
创建 Session
  ↓
启动 Pi
  ↓
发送 Prompt
  ↓
接收流式事件
  ↓
展示工具调用
  ↓
保存事件
  ↓
任务完成
```

验收：

- 能创建多个 Task。
- 能创建多个 Pi Session。
- 能独立中断任务。
- 重启程序后能重新加载历史。
- 事件不会因为 Vue 页面刷新而丢失。
- 可以显示 Token 使用情况。

**完成这个阶段，就已经有一个真正可用的个人 Harness。**

## Phase 2：Workspace 与执行环境

预计：1～2 周。

开发：

- Workspace Manager。
- Repository。
- 文件预览。
- Terminal。
- Git。
- Diff。
- Worktree。
- 文件引用。
- 图片附件。

目标：

让 Agent 不只是聊天，而是能够在独立工作区内完成完整开发任务。

验收：

同时执行两个不同 Task，不能出现工作目录或文件修改冲突。

## Phase 3：Agent 与 Capability Center

预计：1～2 周。

开发：

- Agent 配置管理。
- Skills 管理。
- MCP 管理。
- Tools 注册。
- 权限管理。
- Approval UI。
- Agent 模板。

目标：

不同 Agent 可以使用不同模型、工具和权限。

验收：

创建 Android Agent 和 DevOps Agent，能够分别执行对应的任务。

## Phase 4：高级 Agent 编排

预计：2～3 周。

开发：

- Sub Agent。
- Multi-Agent。
- Task Dependency。
- Agent Handoff。
- 并行执行。
- 自动重试。
- 失败恢复。
- 定时任务。
- 成本限制。

例如：

```text
Task: Android 项目版本升级

              Main Agent
                  │
        ┌─────────┼─────────┐
        │         │         │
        ▼         ▼         ▼
    Analysis   Dependency   Compatibility
     Agent      Agent         Agent
        │         │         │
        └─────────┼─────────┘
                  │
                  ▼
              Main Agent
                  │
                  ▼
             Final Report
```

这里要强调：

第一阶段的 Sub Agent 不一定要引入复杂的多 Agent 框架。

可以由 Go Task Scheduler 管理多个独立 Pi Runtime Session。

由主 Agent 通过工具调用触发子任务。

这样能够更好地控制任务生命周期、并发和成本。

## Phase 5：多 Runtime 和远程能力

预计：2～3 周。

开发：

- ACP Adapter。
- 其他 Agent Runtime Adapter。
- Remote Runtime。
- SSH Workspace 增强。
- 远程 Agent 管理。
- Sandbox。
- Runtime Health Check。

完成后：

```text
PAW
 │
 ├── Pi
 │
 ├── ACP Agents
 │
 ├── Custom Runtime
 │
 └── Remote Agents
```

这样未来就不会被 Pi 上游的产品方向限制。

---

# 十四、几个关键技术决策

这些问题最好现在就确定，不然后面很容易返工。

| 问题 | 我的建议 |
|---|---|
| 是否 Fork Pi | 不要 |
| 是否直接使用 Pi RPC | 是 |
| 是否自己实现 Agent Loop | 不要 |
| 是否重新实现模型 API | 不要 |
| 是否统一 Runtime 接口 | 必须 |
| 是否使用 SQLite | 是 |
| 是否需要 Task 和 Session 分离 | 必须 |
| 是否需要事件持久化 | 必须 |
| 是否支持多 Agent | 架构预留，后期实现 |
| 是否支持 Worktree | 第二阶段 |
| 是否支持 ACP | 后期 |
| 是否支持远程 Web UI | 暂不做 |
| 是否需要云端服务 | 暂不做 |

尤其需要强调：

**不要把 Pi 的 JSONL Session 当成你的整个数据库。**

Pi 负责 Agent 对话上下文。

你的 Harness 负责：

- Task。
- Run。
- Agent。
- Workspace。
- Permission。
- Event。
- Usage。
- Scheduling。

这是两个不同的管理层次。

---

# 十五、建议采用的开发规范

由于你准备使用 Pi / OpenCode 进行开发，我建议项目本身也具备比较明确的 Agent 开发规范。

根目录：

```text
AGENTS.md
```

内容应该约束：

1. Go 业务逻辑不能直接依赖 Wails Runtime。
2. Runtime Adapter 不允许直接操作 Vue。
3. 所有 Agent 事件必须经过 Event Bus。
4. 所有 Task 状态变化必须通过 State Machine。
5. 所有数据库结构变化必须使用 Migration。
6. 新增功能必须包含测试。
7. 不允许绕过 Permission Service 执行敏感操作。
8. 不允许在业务代码中直接读取模型 API Key。
9. 前端不得直接解析 Pi 原始 RPC。
10. 所有跨模块调用优先依赖 Interface。

测试建议：

| 测试 | 工具 |
|---|---|
| Go 单元测试 | go test |
| Go 并发测试 | race detector |
| Vue 单元测试 | Vitest |
| UI 测试 | Playwright |
| Runtime 集成测试 | Mock Pi / 真实 Pi |
| 数据库测试 | SQLite 临时数据库 |
| E2E | Wails 桌面环境 |

建议特别构建一个 Mock Runtime。

这样测试任务调度、事件处理、UI 时，不需要每次都消耗真实模型 Token。

---

# 十六、最终技术架构建议

把整个产品归纳一下：

| 层次 | 技术 | 职责 |
|---|---|---|
| Desktop | Wails v3 | 桌面容器 |
| Frontend | Vue 3 | UI |
| Application | Go | 业务核心 |
| Storage | SQLite | 持久化 |
| Runtime | Pi RPC | Agent 执行 |
| Protocol | ACP | 未来扩展 |
| Model | Pi Provider | 模型接入 |
| Execution | Go + PTY | 系统执行 |
| Git | Git CLI | 版本管理 |
| Sandbox | 独立执行环境 | 安全隔离 |
| Events | Go Event Bus | 事件调度 |
| Scheduler | Go | 任务管理 |

相关官方技术资料：

- [Pi Runtime SDK](https://pi.dev/docs/latest/sdk?utm_source=chatgpt.com)
- [Pi Extension System](https://pi.dev/docs/latest/extensions?utm_source=chatgpt.com)
- [Wails v3 架构](https://v3.wails.io/contributing/architecture/?utm_source=chatgpt.com)
- [ACP Protocol](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/overview.mdx?utm_source=chatgpt.com)

---

# 十七、我认为最适合你的实际落地顺序

上面是完整架构，但我不建议一次性开发全部功能。

尤其不要一开始就做多 Agent、ACP、Sandbox。

否则很容易花大量时间构建基础设施，却没有一个稳定可用的产品。

我建议：

| 顺序 | 目标 | 最终结果 |
|---|---|---|
| 1 | Pi Runtime 抽象 | 不依赖具体 Pi 实现 |
| 2 | Task + Session | 完整任务生命周期 |
| 3 | Event Bus | 统一事件体系 |
| 4 | Chat UI | 完整 Agent 交互 |
| 5 | Workspace | 真正操作代码 |
| 6 | Terminal + Git | 开发闭环 |
| 7 | Model Center | 模型管理 |
| 8 | Agent Center | 不同工作角色 |
| 9 | MCP + Skills | 能力扩展 |
| 10 | Permission | 执行安全 |
| 11 | Multi-Agent | 复杂任务编排 |
| 12 | ACP | 多 Runtime |
| 13 | Sandbox | 隔离执行 |

## 一个特别值得注意的地方：不要过度设计 Runtime 抽象

第一阶段只需要保证 Pi Adapter 与 Go 业务逻辑解耦。

不要为了未来支持十种 Agent，提前设计一个包含几十个方法的万能接口。

不同 Runtime 的能力存在差异。

例如，Pi 的 Session 分支、上下文压缩和 Extension 机制，并不一定能被其他 Runtime 完全等价实现。

建议采用：

**统一基础接口 + Runtime Capability 声明 + 特定 Runtime 扩展接口。**

例如：

```go
type RuntimeCapabilities struct {
    Streaming       bool
    SessionResume   bool
    SessionFork     bool
    ToolApproval    bool
    SubAgent        bool
    NativeMCP       bool
    ThinkingStream  bool
}
```

这样前端就能知道当前 Runtime 支持什么能力，而不是假设所有 Runtime 都一样。

---

# 十八、下一步：进入实际开发

我建议不要马上开始让 Coding Agent 写代码。

先完成一个非常重要的工作：

**基于现有 pi-desk 生成一份完整的代码资产盘点和重构映射。**

原因是你已经有：

- Wails v3。
- Go Host。
- Pi RPC。
- SSH Remote。
- PTY。
- Git。
- Repository。
- Scheduler。

这些模块如果重新实现，会浪费很多时间。

我建议接下来分成三个交付物：

| 文档 | 内容 |
|---|---|
| `ARCHITECTURE.md` | 新 Harness 完整架构 |
| `IMPLEMENTATION.md` | 模块拆分、接口、数据库、事件协议 |
| `ROADMAP.md` | 每个开发阶段的具体任务和验收标准 |

其中 `IMPLEMENTATION.md` 应该尽可能细化到 Go Package、Type、Interface、API 和数据库字段。

**我的建议是：先做代码资产盘点，然后直接开始 Phase 1，而不是先做一个全新的空项目。**

这样既能保留 Pi Desk 已有的技术积累，也能真正摆脱上游产品形态变化对你的限制。
