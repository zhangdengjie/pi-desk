# Pi Desk · 仓库分析文档集

> 基准：`feat/r1a-go-data-plane` @ `abc2726`（2026-11-08）· 校验：`bash ~/.pi/agent/skills/project-analysis-docs/scripts/verify_refs.sh docs .`（要求 `BAD=0`）

**一句话定性**：Pi Desk = **Wails v3 桌面壳 + Go 服务层 + Vue3 前端**三件套，本质是 **Pi coding agent 的多线程 GUI 编排器** —— 它自己不实现 agent，而是给每个会话拉起一个 `pi --mode rpc` 子进程，用 stdin/stdout 的 NDJSON 帧驱动它，并把 workspace / session / 文件 / 终端 / 浏览器 / SSH 远端六类能力包成 **14 个自家 Wails service**（+ 框架自带的 `notifications` = 注册 15 个）暴露给前端。R1a 起增加旁路数据面：`pi:event` 不变，新增 `agent:event` 与 SQLite Task/Run 记录。

## 30 秒速览

| 维度 | 事实 | 怎么复算 |
|---|---|---|
| 规模 | Go **276 文件 / 63,326 行**（含测试；剔掉 `_test.go` = 165 / 39,492） | `find . -name '*.go' \| wc -l`（再加 `-not -name '*_test.go'` 得前者） |
| 前端 | 手写 TS（排除 test）**82 / 14,497**；components **53 个 `.vue` / 18,339 行**；CSS **6 / 14,386**；生成绑定 **152 个函数** | `find frontend/src -name '*.ts' -not -name '*.test.ts' \| wc -l`；`ls frontend/src/components/*.vue \| wc -l` |
| 提交史 | 386 个 commit，HEAD `abc2726` | `git rev-list --count HEAD` |
| 桌面框架 | `github.com/wailsapp/wails/v3 v3.1.0`（stable 线） | `grep wails go.mod` |
| Go / Node | `go 1.26.0` · CI 钉 `node 22.19.0` | `head -3 go.mod`；`.github/workflows/verify.yml` |
| 前端栈 | Vue 3.5.41 + pinia 4.0.2 + vue-i18n 11.4.8 + Tailwind 4.3.3 + Vite 8.0.5 + Vitest 4.1.10 | `cat frontend/package.json` |
| 对外接口 | **152 个绑定函数 / 164 个生成方法 / 15 个自家 service + `notifications` = 16**；事件通道 `pi:event` + R1a `agent:event` | `grep -h 'export function' frontend/bindings/pi-desk/internal/appservice/*.ts \| wc -l` |
| 状态文件 | `state.json`（version 6）**整文件覆盖写**；R1a 只读导入到 SQLite | `internal/workspace/catalog.go:20` `:632` |
| 上帝文件 | `frontend/src/stores/app.ts` **5,107 行 / 252 个 action** | `wc -l frontend/src/stores/app.ts` |
| 测试 | **111** 个 `*_test.go` + **109** 个 `frontend/src/**/*.test.ts`（另 3 个 fuzz target 在 CI 各跑 10s） | `find . -name '*_test.go' \| wc -l`；`find frontend/src -name '*.test.ts' \| wc -l` |

## 文档索引

| 文件 | 讲什么 | 什么时候读 |
|---|---|---|
| `docs/01-技术架构.md` | 分层图、运行形态、`main.go` 启动顺序、配置与目录、`state.json`、构建发布链 | 想知道"这东西怎么跑起来的" |
| `docs/02-功能模块地图.md` | 24 个 Go 包 + 前端目录职责表；功能→文件→入口；定时器全表；RPC/SSH 子系统 | 想知道"这个功能在哪" |
| `docs/03-开发指南.md` | 跑起来/构建/沙箱实例命令、改动配方、测试分层、排障表 | 动手改代码前 |
| `docs/04-API清单.md` | 152 个绑定函数、事件帧、domain 请求类型、环境变量全表、内嵌 Pi 扩展 | 加接口 / 查参数 |
| `docs/05-技术债与风险清单.md` | P0 发布阻塞、结构性债、外部依赖风险、工程缺口 | 排期 / 评审 / 上线前 |
| `docs/06-数据通道选型.md` | Wails RPC 桥 vs asset server 的调用链、实测落差与代价 | 要传大字节 / 犹豫加 HTTP 路由时 |
| `docs/DEV_RUN.md` | 本地开发/构建实操、沙箱、签名、`pidesk-shot` 验收 | 跑 dev / 打包 / 排障 |

> `06` 是 2026-09-30 为「transcript 该不该走 asset server」补的决策记录，不参与 01–05 的编号重排。
> `docs/` 已从 `.gitignore` 移除并入库；`AGENTS.md`、`.pi/plans/` 仍是本地文件。

## 自检记录

```bash
bash ~/.pi/agent/skills/project-analysis-docs/scripts/verify_refs.sh docs .
# R0 收口时重跑；目标 BAD=0
```

| 抽验项 | 当前数 | 复算 |
|---|---|---|
| Go 规模 | 273 / 62,987（含测试）；实现 163 / 39,239 | `find . -name '*.go' -exec wc -l {} +` |
| 组件数 | 52 个 `.vue` | `ls frontend/src/components/*.vue \| wc -l` |
| CSS 规模 | 6 个 `.css` / 14,386 行 | `find frontend/src -name '*.css' -exec wc -l {} +` |
| 绑定函数 | 152（生成器报告 164 methods） | `grep -h 'export function' frontend/bindings/pi-desk/internal/appservice/*.ts \| wc -l` |
| store action | 252 | `grep -cE '^    (async )?[A-Za-z0-9_]+\\(' frontend/src/stores/app.ts` |
| 出站命令帧 | 26 | `docs/04` §4 的复算脚本 |

⚠️ `docs/DEV_RUN.md` 里有指向 Pi 发行包与 Wails 源码的引用，本仓库内不可解析；`verify_refs` 的 `BAD=0` 只对本仓库路径成立。
