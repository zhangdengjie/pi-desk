# 现有资产 → 目标架构映射（R0）

> 基准：`feat/r1a-go-data-plane` @ `abc2726`（2026-11-08）
> 目标：把现有 Pi Desk 资产映射到 GUIDE 的四层（Frontend / Application Core / Runtime / Execution），
> 逐项给出「保留 / 改造 / 新建 / 延后」，避免 R1b 起重写已有能力。
> 关联：`GUIDE.MD` §3/§11、`refact/adr/*`、`refact/r1a-status.md`。

## 1. Go 包映射（24 个 internal + 2 个 cmd）

```text
现有包                     目标层            处置      阶段    说明
internal/appservice        Application       改造      R1a    15 个 service 保留；加事件 sink
internal/workspace         Application       保留      —      state.json/catalog/trust
internal/repository        Execution         保留      R2     worktree create/remove/gc
internal/sessionindex      Application       保留      —      Pi JSONL 索引/用量/改写
internal/terminal          Execution         保留      R2     本地/远端 PTY；绑定 task/run
internal/browser           Execution         保留      —      受管 Chromium/CDP
internal/clipboard         Execution         保留      —      剪贴板文件
internal/gitexec           Execution         保留      —      git 命令统一上限
internal/processutil       Platform          保留      —      进程树 kill
internal/workspaceapp      Platform          保留      —      App 打开 workspace
internal/userconfig        Application       保留      —      ~/.pi-desk/config.json
internal/appdirs           Platform          保留      —      可写目录/沙箱
internal/domain            Domain            保留      —      跨边界 DTO
internal/piruntime         Runtime           保留      R1b    进程监督；被 Runtime 接口包装
internal/pirpc             Runtime           保留      —      NDJSON 帧
internal/remotessh         Runtime           保留      R5     SSH runtime/helper lease
internal/remotehelper      Runtime           保留      R5     远端 helper 二进制
internal/remoteprotocol    Runtime           保留      R5     宿主↔helper 帧协议
internal/task              Domain/Application 新建      R1a    Task/Run 状态机/导入（已落地）
internal/storage           Infrastructure    新建      R1a    SQLite 迁移/CRUD（已落地）
internal/eventbus          Infrastructure    新建      R1a    pi:event tap/归一化/落库（已落地）
internal/runtime           Runtime           新建      R1a    薄接口/capability/PiAdapter（已落地）
internal/usage             Application       新建      R1a    per-Run 用量（已落地）
internal/buildinfo         Platform          新建      R0    production 下关 DevTools（已落地）
cmd/pi-desk-remote-helper  Runtime           保留      R5     远端 helper 入口
cmd/pi-desk-remote-artifacts Runtime         保留      —      构建期产物
```

## 2. 前端映射

```text
现有目录/文件                目标位置              处置      阶段    说明
frontend/src/stores/app.ts   stores/session.ts     改造      R1b    handlePiEvent → 纯 reducer
                              stores/tasks.ts       新建      R1b    Task/Run 查询与命令
                              stores/usage.ts       新建      R1b    用量视图
                              stores/workspace.ts   改造      R1b    从 app.ts 拆出
frontend/src/stores/events/  stores/events/*.ts    新建      R1b    message/tool/run reducer
frontend/src/components/     components/TaskCenter 新建      R1b    列表/详情/RunTimeline
frontend/src/components/     components/           保留      —      ConversationPane 等 52 个 .vue
frontend/src/services/       services/*.ts         保留      —      1:1 绑定包装，19 个文件
frontend/src/utils/          utils/*.ts            保留      —      滚动/吐字/测试
frontend/src/styles/         styles/*.css          保留      —      CSS 拥有几何量
frontend/src/i18n.ts         i18n.ts               保留      —      新增文案走 tr()
frontend/bindings/           bindings/             保留      —     生成物；check:bindings 门禁
```

## 3. 目标层归属

```text
Frontend           Vue 3 + Pinia + Vite；Chat 保留，Task Center 增量
Application Core   appservice + task + usage + eventbus + sessionindex + workspace
Domain             domain + task 的实体/状态机
Infrastructure     storage/sqlite
Runtime            runtime 接口 + piruntime/pirpc + remotessh/remotehelper/remoteprotocol
Execution          repository + terminal + browser + clipboard + gitexec + workspaceapp
Platform           main.go + appdirs + processutil + buildinfo
```

## 4. 明确不做 / 延后

```text
- 不重写 Chat UI、Markdown 渲染、滚动/吐字、终端、浏览器、远程 SSH。
- 不接管 Pi 的单轮 SubAgent（pi-desk-subagents.ts）；Go 只做跨任务/定时。
- R2 前不建 task_schedules/worktree/permission_request 表。
- R4 前不建 Agent Center UI；R5 前不做 ACP/Sandbox。
- 不修改 bundle id / 数据目录 / 单实例锁名。
```

## 5. 覆盖检查

```text
internal/*         24/24 已映射
cmd/*               2/2 已映射
frontend/src/*      8 个顶层目录均已映射
遗留                app.ts 的拆分、Task Center、worktree、权限分别留给 R1b/R2/R4
```

> 新增包时先更新本文件，再写代码；每次阶段结束用 `verify_refs.sh docs .` + 本表的 `grep` 复核。
