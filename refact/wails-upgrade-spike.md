# Wails v3.1 升级 Spike

- 日期：2026-11-08
- 基线：`develop` @ `6372141`
- 分支 / 工作树：`spike/wails-3.1` @ `/tmp/pidesk-wails-spike`（commit `c964f37`）
- 环境：Go 1.26.1 darwin/arm64 · Node 24.5.0 · npm 11.5.1
- 结论：**升级可行，不合并**；建议在 R1a 前作为独立提交合入，避免与数据面改动混在一起。

## 1. 基线（beta.16）

```text
CLI 安装    GOBIN=/tmp/pidesk-wails-cli/beta16 go install .../wails3@v3.0.0-beta.16
生成        15 Services / 159 Methods / 7 Enums / 159 Models
幂等性      wails3 generate bindings -f '' -clean=true -ts -i
            git diff --exit-code -- frontend/bindings → 0
```

基线结论：当前 `frontend/bindings` 干净，且 beta.16 生成器是幂等的。

## 2. 升级内容

```text
Go module   github.com/wailsapp/wails/v3 v3.0.0-beta.16 → v3.1.0
Go 指令     go 1.25.0 → go 1.26.0（Wails 3.1 要求）
依赖变化    + github.com/ebitengine/purego v0.11.1
            + golang.org/x/term v0.46.0
            - github.com/adrg/xdg
            - github.com/mattn/go-colorable / go-isatty
            升级 x/crypto / x/image / x/mod / x/sys
前端         @wailsio/runtime 3.0.0-beta.16 → 3.1.0（spike 中验证）
版本显示     internal/appservice/desktop.go + 4 个前端测试 → v3.1.0
CI 固定      .github/workflows/verify.yml 3 处 wails3@v3.0.0-beta.16 → v3.1.0
Bindings    现有文件无改动；新增 frontend/bindings/events/index.ts
```

## 3. 验证结果

```text
go build ./...                 ✅ 通过（仅 macOS 链接警告）
go test ./...                  ✅ 通过（需 TMPDIR=/tmp，见 §4）
frontend npm run build         ✅ 通过（vue-tsc + vite）
frontend npm run test          ✅ 106 files / 1269 tests passed
bindings 生成                  ✅ 现有文件无 diff；新增 events/index.ts
```

`go test ./...` 在默认 `TMPDIR` 下有 1 个失败：`TestRemoteAdapterRoutesSkillsAndReportsCommandResults`，原因是临时目录路径超过 Unix socket 路径上限（`listen EINVAL ... broker.sock`）。A/B 实测：

```text
beta.16 + 默认 TMPDIR   FAIL
beta.16 + TMPDIR=/tmp   PASS
v3.1    + TMPDIR=/tmp   PASS
```

结论：与 Wails 版本无关，是既存测试环境问题；CI 或本地跑全量测试时应设 `TMPDIR=/tmp`（或缩短临时目录）。

## 4. 必改项

1. **Go 1.26**：`go.mod` 指令升到 1.26.0；CI 用 `go-version-file: go.mod` 会自动跟随，但开发者本机需 1.26+（spike 已完成）。
2. **CLI 版本**：`.github/workflows/verify.yml` 有 3 处 `wails3@v3.0.0-beta.16`，已改为 `v3.1.0`（spike 已完成）。
3. **前端 runtime**：`@wailsio/runtime` 已同步升到 `3.1.0`（spike 已完成）。
4. **生成文件**：`frontend/bindings/events/index.ts` 是 3.1 新增产物，升级提交已带上。
5. **版本显示**：`internal/appservice/desktop.go:31` 与 4 个前端测试硬编码的 `v3.0.0-beta.16` 已改为 `v3.1.0`（spike 已完成）。
6. **测试环境**：全量 `go test` 使用 `TMPDIR=/tmp`，否则既存 socket 路径失败会误报。

## 5. 非阻塞警告

- 链接器提示 `object file ... built for newer 'macOS' version (15.0) than being linked (11.0)`：升级后出现，未导致构建失败；合入前确认最低部署目标（`MACOSX_DEPLOYMENT_TARGET`）是否需要调整。
- `ld: warning: ignoring duplicate libraries: '-lobjc'`：非阻塞。

## 6. 复现命令

```bash
# 基线
GOBIN=/tmp/pidesk-wails-cli/beta16 go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.16
/tmp/pidesk-wails-cli/beta16/wails3 generate bindings -f '' -clean=true -ts -i
git diff --exit-code -- frontend/bindings

# spike
git worktree add -b spike/wails-3.1 /tmp/pidesk-wails-spike HEAD
cd /tmp/pidesk-wails-spike
cp -R <main>/frontend/dist frontend/dist
mkdir -p build/remote-helper/artifacts
cp -R <main>/build/remote-helper/artifacts/. build/remote-helper/artifacts/
go get github.com/wailsapp/wails/v3@v3.1.0
go mod tidy
go build ./...
TMPDIR=/tmp go test ./...
(cd frontend && npm install @wailsio/runtime@3.1.0 --save-exact && npm run build)
```

## 7. 建议

- 升级本身没有业务代码破坏，主要成本是 Go 版本、CLI 版本、生成器产物和前端 runtime。
- 建议把升级作为 R0 的独立提交（`chore(wails): upgrade to v3.1.0`），先合并再开 R1a；这样 R1a 的 bindings 变更只来自新增 service，不会与升级 diff 混在一起。
- 本次 spike 不合并；工作树 `/tmp/pidesk-wails-spike` 保留到决策完成。
