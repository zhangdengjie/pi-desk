# R0 收口状态

- 日期：2026-11-08
- 分支：`feat/r1a-go-data-plane`
- 基线：`develop` @ `2224f42` + Wails 3.1 合并 `20e2769`
- 结论：**R0 完成**；未关闭的 P0-2（Developer ID/公证）属于发布链路，不在 R0 范围。

## 1. 清单

```text
✅ v1 归档                  refact/GUIDE.v1.MD
✅ ADR 001–008 + index      refact/adr/
✅ Wails 3.1 spike          refact/wails-upgrade-spike.md；分支已并入本分支
✅ bindings 幂等性           beta.16 与 3.1.0 均 diff=0；159 methods
✅ P0-1 DevTools             production tag 关闭；Windows release 移除 devtools tag
✅ P0-3 更新 URL             UpdateManifestURL 默认空；-ldflags -X 注入；空值 disabled
✅ bindings CI 门禁          check:bindings（Taskfile + verify.yml macos job）
✅ docs 入库                 .gitignore 移除 /docs/；verify_refs BAD=0
✅ docs 刷新                 01–06 + README + DEV_RUN；Wails/Go/规模/API 数已更新
✅ current-to-target         refact/current-to-target.md
✅ 沙箱基线截图              /tmp/r0-baseline.png（2872x1792，Wails 3.1.0）
```

## 2. 关键决策

```text
P0-1  DevTools 由 build tag 决定：!production → true，production → false
      不再依赖环境变量；Windows release 的 `production,devtools` 改为 `production`
P0-3  更新 URL 用包级 var + -ldflags -X；默认空 = 关闭检查，避免指向上游
docs  docs/ 整体入库；AGENTS.md / .pi/plans 仍为本地文件
```

## 3. 验证命令

```bash
cd ~/develop/git/github/pi-desk
go build ./...
go build -tags production ./...
TMPDIR=/tmp go test ./...
wails3 task check:bindings
bash ~/.pi/agent/skills/project-analysis-docs/scripts/verify_refs.sh docs .
# → OK=229  CHECK=135  BAD=0
```

沙箱截图：

```bash
./.pi/bin/dev-sandbox.sh
pidesk-shot --raise /tmp/r0-baseline.png
# title='Pi Desk · sandbox'；窗口正常渲染
./.pi/bin/dev-sandbox.sh stop
```

## 4. 备注

- 本地 Wails CLI 已从 beta.26 升到 **v3.1.0**（`~/go/bin/wails3`）；`dev-sandbox.sh` 优先用 `~/go/bin`，所以不再生成 beta 产物。
- `docs/04` 的方法表由 `docs/snippets/gen_api_index.py` 重新生成：147 个绑定函数，生成器报告 159 methods。
- 基线截图保存在 `/tmp/r0-baseline.png`，未入库（581K；需要时再归档）。
- 下一阶段：R1b（`handlePiEvent` reducer 化 → store 拆 → Task Center 灰度）。
