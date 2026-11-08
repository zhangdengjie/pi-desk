# Pi Desk 本地开发 / 构建手册

> 本文已随 `docs/` 入库；本地路径与实验记录保留。
> 适用主机：macOS (darwin/arm64)。记录时间：2026-09-21。

---

## 0. 环境要求（已验证版本）

| 工具 | 本机版本 | 要求 | 检查命令 |
|---|---|---|---|
| Go | 1.26.1 | `go.mod` 声明 `go 1.26.0` | `go version` |
| Node / npm | v24.5.0 / 11.5.1 | CI 用 22.19.0，node 24 实测可用 | `node -v && npm -v` |
| Wails CLI | **必须 v3.1.0** | 与 `go.mod` 中 `wails/v3 v3.1.0` 严格同版本 | `wails3 version` |
| Pi CLI | 0.86.1 | 运行期必需（App 起 `pi --mode rpc`） | `pi --version` |
| Docker | 未装 | 仅交叉编译 / SSH 验收需要 | `docker info` |

一次性安装 Wails CLI（注意 PATH）：

```bash
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0
export PATH="$HOME/go/bin:$PATH"      # 每个新终端都要，或写进 ~/.zshrc
```

---

## 1. 日常开发（热重载）

```bash
cd /Users/zhangdengjie/develop/git/github/pi-desk
wails3 dev -config ./build/config.yml -port 9245
```

改动即重编：Go 文件由 `wails3 dev` 监听，Vue/TS 由 Vite 热更新（端口 9245，可用 `WAILS_VITE_PORT` 覆盖，见 `Taskfile.yml:7`）。

`dev_mode` 配置在 `build/config.yml`：`debounce: 1000`，忽略 `node_modules` / `frontend` / `bin`，执行链为
`wails3 build DEV=true`（blocking）→ `common:dev:frontend`（background）→ `task run`（primary）。

换包管理器（默认 npm）：`PACKAGE_MANAGER=bun wails3 task ...`（见 `Taskfile.yml:6`）。

---

## 2. 构建

```bash
# 生产二进制 → bin/pi-desk
wails3 build

# .app bundle（含 ad-hoc codesign）→ bin/pi-desk.app
wails3 task darwin:package

# .dmg（会先 package）
wails3 task darwin:package:dmg

# universal（arm64 + amd64 合并）
wails3 task darwin:build:universal
```

`wails3 build` 的完整链路（`build/darwin/Taskfile.yml` `build:native` 的 deps）：

1) `go mod tidy`
2) 生成 SSH remote helper 产物 → `build/remote-helper/artifacts/{helper-linux-{amd64,arm64},helper-darwin-{amd64,arm64},manifest.json}`
3) `wails3 generate bindings -ts -i` → `frontend/bindings/`
4) `npm run build`（含 `vue-tsc --noEmit` typecheck）→ `frontend/dist/`
5) `wails3 generate icons` → `build/darwin/icons.icns` / `Assets.car`
6) `go build -tags production -trimpath -buildvcs=false -ldflags="-w -s" -o bin/pi-desk`

---

## 3. 运行

三种启动方式，实测都可用（macOS 14+ / arm64）：

```bash
# 方式 A：构建完直接跑（自动包成 bin/pi-desk.dev.app 并 codesign）
wails3 build && wails3 task run

# 方式 B：前台跑 .app 内二进制（stderr 直接在终端可见，排障首选）
./bin/pi-desk.app/Contents/MacOS/pi-desk

# 方式 C：open（后台起，日志进 unified log）
open bin/pi-desk.app
log show --last 5m --predicate 'process == "pi-desk"' --style compact | tail -30

# 停止（⚠️ 别这么干 —— 会连你正在用的那个实例一起扁，见 §3.1）
pkill -f "MacOS/pi-desk"
```

→ 确认进程与它的 PATH：`P=$(ps ax -o pid,command | grep '[M]acOS/pi-desk' | awk '{print $1}' | head -1); ps eww -p $P -o command= | tr ' ' '\n' | grep ^PATH=`
  （**别用 pgrep 找宿主进程**：pgrep/pkill 从不列出自己所在的祖先链，见 §3.1.3 末）

### 3.1 单实例锁（2026-09-23 起）

`main.go` 的 `application.Options.SingleInstance` 让第二个 Pi Desk 进程**直接退出**，并把已有窗口唤到
前台。原因：`state.json` 是整文件覆盖写，而 catalog 只在首次 `loadLocked()` 读盘 → 两个实例各持一份
内存目录，互相吞掉 workspace 注册（症状 `workspace is not registered`）。

- 锁文件：`$TMPDIR/com.pidesk.desktop.lock`，`flock(LOCK_EX|LOCK_NB)`（wails 3.1.0
  `pkg/application/single_instance_darwin.go`（约 89-102 行）→ 崩溃由内核释放，无残留需清理
- 需要同时开两个（对比分支 / 复现旧 bug）：
  `PI_DESK_ALLOW_MULTI_INSTANCE=1 ./bin/pi-desk.app/Contents/MacOS/pi-desk`
  ⚠️ 这会和你正在用的实例抢同一份 `state.json`，**只在先把真实例退掉之后**用
- 数实例仍然是有效的验收手段（确认锁生效）：
  `ps ax -o pid,lstart,comm | grep 'MacOS/pi-desk' | grep -v grep` → 只应有一行

#### 3.1.0 ⚠️ `wails3 dev` 也被这把锁挡（2026-09-25 14:26 实测）

`wails3 dev` 的最后一步 `wails3 task run` 拉起 `bin/pi-desk.dev.app/Contents/MacOS/pi-desk`。没设
`PI_DESK_DATA_DIR` 时它的 `statePath` 与 `/Applications/pi-desk.app` 相同 → `UniqueID` 相同 → 只要正式版在跑，
dev 实例就走到 `single_instance_darwin.go`（约 74 行）`notify()`，发完唤起通知后 **:82 `os.Exit(ExitCode)`（默认 0）**。

**所以症状是「窗口起不来」但没有任何报错**：日志停在
`INF AssetServer Info: middleware=true handler=true`，`wails3 dev` 本身不退出（vite 照常占着端口），
被顶到前台的其实是**正式版**的窗口。构建是成功的 —— 先看 `bin/pi-desk.dev.app/Contents/MacOS/pi-desk` 的 mtime。

三条复算（顺序即排查顺序，10 秒）：

```bash
lsof "$TMPDIR/com.pidesk.desktop.lock"                      # 有输出 = 锁被别的实例占着（本次是 pid 8255）
cd ~/develop/git/github/pi-desk && ./bin/pi-desk.dev.app/Contents/MacOS/pi-desk; echo "EXIT=$?"   # 三行 INF 后 EXIT=0 = 被拒，不是崩
PI_DESK_DATA_DIR=/tmp/probe ./bin/pi-desk.dev.app/Contents/MacOS/pi-desk &   # 能活 = 根因确认为锁；记得 kill
```

两条出路：

| | 做法 | 代价 |
|---|---|---|
| **A 推荐** | 先退正式版：`osascript -e 'quit app "Pi Desk"'` → 重跑 `./.pi/bin/dev-sandbox.sh`（自带 PATH/端口/身份接线） | ⚠️ 会中断它的会话，**先看有没有活着的 `pi` 子进程：`ps ax -o pid=,ppid= | awk -v p=<pid> '$2==p{print $1}'`**（pgrep -P 在会话里查不到宿主的孩子） |
| B 共存 | `PI_DESK_DATA_DIR=/tmp/pidesk-dev wails3 dev -config ./build/config.yml -port 9245` | catalog 为空 → 满屏「工作区访问已禁用」（见 §3.1.1），只能验 UI，不能验功能 |

**B 的两个前置**（都是当场踩的，缺一就白跑一轮构建）：

1. `export PATH="$HOME/go/bin:/usr/local/go/bin:$PATH"` —— `executes` 走 `/bin/sh -c`，PATH 不全会先炸
   `wails3: command not found` → `exit status 127`，补上后接着炸 `"go": executable file not found in $PATH` → `exit status 1`
2. 先杀上一轮 dev：vite 带 `--strictPort`，`9245` 被残留进程占住则新 dev 直接失败
   `pkill -f 'wails3 dev'; lsof -ti tcp:9245 || echo free`

→ 应看到：`ps ax -o pid,etime,command | grep 'pi-desk.dev.app/Contents/MacOS'` 有行且**持续存活**；
`pidesk-shot --list` 里出现该 pid 的 windowId（⚠️ 只有 windowId、title 全空 = 拍图的进程没录屏授权，
不代表窗口没起）。

**不要用** `PI_DESK_ALLOW_MULTI_INSTANCE=1` 跑 dev —— 它会和正在用的实例抢同一份 `state.json`，就是上面那段
「互相吞 workspace 注册」的复现条件。

#### 3.1.0.1 一键脚本 `.pi/bin/dev-sandbox.sh`（2026-09-25 加）

上面两条出路 + 三个坑（PATH / 残留 vite / seed）全封在这个脚本里，**别再手敲命令块**。
脚本在 `.pi/bin/`，已写进 `.git/info/exclude`（本仓库禁止改 `.gitignore`，见 `AGENTS.md` §5）。

| 命令 | 行为 |
|---|---|
| `./.pi/bin/dev-sandbox.sh` | 起沙箱 dev；首次（`$DATA/state.json` 不存在）从真 `state.json` seed 一份**快照** |
| `--fresh` | 起沙箱 dev，不 seed → catalog 空，只验 UI，**不碰真实工作区** |
| `--reseed` | 用真 `state.json` 覆盖沙箱状态再起 |
| `--real` | 不用沙箱（走默认锁）；**正式版还在跑就直接拒绝启动**，避免又被静默顶掉 |
| `stop` | 只停 `wails3 dev` + dev 实例，**不动** `/Applications/pi-desk.app` |
| `status` | 正式版 pid / dev pid / 锁持有者 / 沙箱 state.json 有无 / 9245 是否空闲 |
| `-h` | 用法（`-h` 打印的就是脚本头注释 5–20 行） |

约定与 `pidesk-shot` 对齐：沙箱根 `PIDESK_SANDBOX_DIR`（默认 `/tmp/pidesk-sandbox`）、数据目录 `$root/data`
→ `pidesk-shot`（默认 sandbox 模式）认得出脚本起的实例（它按 `ps eww` 里的 `PI_DESK_DATA_DIR` 筛进程）。
端口用 `PI_DESK_VITE_PORT` 覆盖。seed 发生在 exec 之前，日志里没 `seeded` 字样 = 拷贝失败，不是没跑。

⚠️ **沙箱 catalog 非空 = 它能访问你的真实工作区目录**，在里面起会话会真拉起 `pi`、真烧额度；只想看布局用 `--fresh`。

**写脚本时踩的坑（值得记住）**：脚本用 `set -u`，而 `echo "…$DATA" 后面紧跟中文括号`——在 UTF-8 locale 下
macOS 自带 bash 3.2 会把中文字节**并进变量名** → 报 `DATA?: unbound variable`（报错文本里的中文被终端吞掉，
看起来像"变量根本没定义"，能误导很久）。`LC_CTYPE=C` 下**不报**，所以拿 C locale 自测是假绿灯：

```bash
LC_ALL=en_US.UTF-8 /bin/bash -c 'set -u; V=hello; echo "$V（中文"'   # V?: unbound variable
LC_ALL=C          /bin/bash -c 'set -u; V=hello; echo "$V（中文"'   # hello（中文
```

规矩：脚本里一律写 `${VAR}（`。体检（应 0 命中）：

```bash
perl -ne 'print "$.:$_" if /\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7F])/' .pi/bin/dev-sandbox.sh
```

#### 3.1.1 隔离验证实例（`PI_DESK_DATA_DIR`，不动你正在用的那个）

设了 `PI_DESK_DATA_DIR` 的进程把 **state.json / 托管浏览器 profile / remote-anchors** 全搬进该目录，
单实例锁的名字改成 `com.pidesk.desktop-<statePath hash 前 12 位>.lock`，所以它既不会被你的实例挡住、
也吞不掉你的 workspace 注册。窗口标题与托盘显示 `Pi Desk · sandbox`，启动日志一行
`pi-desk: sandbox instance, writable state under <dir>`。实现见 `internal/appdirs`。

```bash
D=/tmp/pidesk-sandbox && A=$D/Sandbox.app && mkdir -p "$A/Contents/MacOS" "$A/Contents/Resources"
go build -o "$A/Contents/MacOS/pi-desk" .
cp build/darwin/Info.dev.plist "$A/Contents/Info.plist"   # 裸二进制没有 bundle id，通知服务会直接退出
cp build/darwin/icons.icns "$A/Contents/Resources/" 2>/dev/null
codesign --force --deep --sign - "$A"
PI_DESK_DATA_DIR=$D/data "$A/Contents/MacOS/pi-desk" > "$D/sandbox.log" 2>&1 &
```

→ 应看到：`ps ax -o pid,command | grep 'MacOS/pi-desk' | grep -v grep` **两行**；
`ls $D/data/` 有自己的 `state.json`；
`stat -f "%z %m" ~/Library/Application\ Support/pi-desk/state.json` 与开工前一致。

收尾：`kill $(ps ax -o pid,command | grep '[S]andbox.app/Contents/MacOS/pi-desk' | awk '{print $1}')` —— 只杀沙箱，
别 `pkill -f MacOS/pi-desk`（那会连正式版一起扁，AGENTS.md §2）。

⚠️ **身份分离（2026-09-25）**：`build/darwin/Info.dev.plist` 的 `CFBundleIdentifier` 已从 `dev.pi.desk` 改为
`dev.pi.desk.dev`（`CFBundleName` → `Pi Desk dev`）。之前 release、`pi-desk.dev.app`、沙箱三份共用一个 bundle id
且都是 adhoc 签名 → TCC（录屏/通知）只认其中一份，另一份永远拿不到权限，列表里还只出现一行「pi-desk」。

限制（实测于 2026-09-23）：沙箱**读**真 `~/.pi`（会话索引、模型配置照旧可见，索引只读不写），
所以界面里会列出你全部工作区目录与历史会话（数据来自 `sessionindex` 扫盘，不是 catalog：
`frontend/src/stores/app.ts:3706` → `CatalogService.ListSessions` 空路径 → `internal/sessionindex/index.go`
的 `List` 遍历整个会话根），但 catalog 是空的 → 默认 `工作区访问已禁用`，改不到你真那份 state.json。

#### 3.1.2 让 agent 自己看界面（`~/.pi/agent/bin/pidesk-shot`）

wails 3.1.0 **没有**窗口捕获 API（`grep -rn "CaptureContents" pkg/application/*.go` → 0 命中）。
工具走 macOS 自带的按窗口合成：`CGWindowListCopyWindowInfo` 拿 windowId → `screencapture -o -x -l<id>`。

```bash
pidesk-shot --list                     # 先看候选窗口（title 列非空 = 本进程有录屏权限）
pidesk-shot /tmp/x.png                 # 只拍沙箱实例（带 PI_DESK_DATA_DIR 的那个）
pidesk-shot --boot /tmp/x.png          # 没沙箱就从当前 checkout 自己起一个（二进制比 checkout 旧会先重编）
pidesk-shot --raise /tmp/x.png         # **先把目标提到前台再拍** —— 日常用这个
pidesk-shot --pid 54539 /tmp/x.png     # 显式拍另一份（例如你真在用的）
pidesk-shot --anyway /tmp/x.png        # 绕过前台闸门（拿到的是旧帧，不得当验收证据）
```

**两道硬前提，缺一不可**：

1. **目标窗口必须在前台**（`pidesk-front <pid>` 拦，不过就 exit 3）。后台 Wails 窗口停在**最后一次绘制的帧**，
   拍出来一张看起来正常、其实是旧图的东西 —— 比拍不到更坑。解法是 **`--raise`**：它走 `open -a <bundle path>`
   经 LaunchServices 激活，**不需要 Apple 事件权限**（osascript 那条在非 GUI shell 里必死 `-1743`），
   raise 后 `sleep 1.5` 等 WebView 重绘一帧再拍。没 `--raise` 之前这一步得你手动点窗口。
2. **宿主 App 要有「录屏与系统录音」权限**。探针一条命令：`pidesk-shot --list` 的 **title 列全空 = 没权限**
   （`CGWindowListCopyWindowInfo` 对无权限进程隐藏窗口名，`screencapture -l` 也在同一个检查上失败）。
   宿主链查法：`ps -o ppid= -$$` 一路往上直到某个 `.app/Contents/MacOS` —— 要勾的是它。
   注意 TCC 在**启动时**读一次：勾完要 Cmd+Q 整个退出重开，关窗口不算。

→ 应看到：`captured pid=… title='Pi Desk · sandbox' -> /var/folders/…/pidesk-shot-*.png` + `pixelWidth/pixelHeight`；
拍完即删，不要把图留在仓库里。

录像版：`pidesk-record --pid <pid> --raise --seconds 6 --fps 5`（流式输出逐帧验证，带 `.stats.tsv` 帧大小差）；
同样有前台闸门与 `--raise`，而且**逐帧复检** —— 中途被抢走焦点它会立即收尾，不会把旧帧当成「流式不更新」。
（2026-09-25 12:44 实测：录到 3.5s 时把焦点抢给沙箱 → 第 18 帧即收尾并报 `lost the front at frame 18`。）

##### 权限拒不了但拍不到：同一个 bundle id 被十几份 App 抢（2026-09-25 实测）

症状：设置里「pi-desk」的录屏开关是**开着**的，但 `--list` 的 title 全空、`screencapture -l` 报
`could not create image from window`，**Cmd+Q 重开也没用**。

查谁在抢这个名字（一条命令）：

```bash
LSR=/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister
$LSR -dump | awk '/^----$/{p=""} /path:/{p=$0} /CFBundleIdentifier = "dev.pi.desk"/{print p}' | sed 's/path: *//' | sort -u
```

本机实测到 **11 份**：`/Applications` + 仓库里 `bin/pi-desk.app` `bin/pi-desk.dev.app` `build/bin/pi-desk.app`
+ 3 个已卸载但仍在注册的镜像残留（`/Volumes/pi-desk{, 1, 2}`）+ 3 个已删的 `/tmp` 沙箱。
→ TCC 那一行可以绑到**任何一份**（包括已不存在的路径），所以“勾了”不等于“这个进程有权限”。
（2026-09-25 已按下面 2、3 清完并闭环：`dev.pi.desk` 只剩 `/Applications/pi-desk.app` 一份，
12:28 复测 `--list` 的 title 已非空、`pidesk-shot --pid <前台>` 拍出 2878×1798 真像素。
旧授权行当时绑在已删除的路径上，所以“开关开着 + 重开了”仍拍不到 —— 清完必须**重新落一次授权**：
`tccutil reset ScreenCapture dev.pi.desk` 会让系统重新弹框，点「打开系统设置」→ 开 → 「退出并重新打开」。）

修法（按代价从低到高）：
1. 设置面板左下角 `+` 显式加 `/Applications/pi-desk.app` → Cmd+Q 重开 → `pidesk-shot --list` 看 title
2. 删陈旧构建产物 + 注销幽灵：`lsregister -u <不存在的路径>`（或整体重建：`lsregister -kill -r -domain local -domain system -domain user`）
3. 清掉那条说不清归属的授权重弹框：`tccutil reset ScreenCapture dev.pi.desk`（**会撤销现有授权**，下次拍会弹系统框问你，点允许后需重开 App）

根治：`Info.dev.plist` 已改 `dev.pi.desk.dev`（commit `0057711`），dev/沙箱实例从此不再与发布版抢名字。
核对运行中的两份各是谁：`lsappinfo info -app <pid> | grep -E 'bundleID|bundle path'`。

#### 3.1.3 固定签名身份：让 adhoc 不再每次重编译掉录屏授权（2026-09-27 实测闭环）

**根因（一行命令可复算）**：adhoc 签名没有证书，macOS 只能把 designated requirement（DR）记成裸 cdhash：

```bash
codesign -d -r- /Applications/pi-desk.app 2>&1 | grep designated
# designated => cdhash H"f04c1002d5ad55e7528abd753261920bb741a00e"     ← 每次重编译都变
```

TCC 每次授权存的就是这条 DR。cdhash 变 → 旧记录**匹配不上但不删**，于是既不弹框也没权限（= §2.5 那个「每次升级重问」的实质）。

**修法**：用一张本机自签名代码签名证书签，DR 变成与二进制内容无关的形式：

```
designated => identifier "dev.pi.desk" and certificate root = H"3368ead3affad5f78280ea37d02c6f741892f9a8"
```

**实测证据（两个不同二进制，同一 DR）**：

| bundle | cdhash | flags | DR |
|---|---|---|---|
| `bin/pi-desk.app`（旧 adhoc） | `f04c1002…` | `0x2(adhoc)` | `cdhash H"f04c…"` |
| `/tmp/pidesk-e2e/e.app` 第 1 次签 | `a002bd19…` | `0x0(none)` | `certificate root = H"3368ead3…"` |
| 同一个 bundle 换**真重编译**的二进制再签 | `3345dc8c…` | `0x0(none)` | `certificate root = H"3368ead3…"`（完全相同） |

### 一次性配置（已做完，换机器/重建时照这里走）

```bash
cd ~/develop/git/github/pi-desk && ./.pi/bin/pidesk-mkcert.sh          # 建证书 + 导入 login keychain + 信任
security find-identity -v -p codesigning | grep 'Pi Desk Local Dev'    # → 1) 3368EAD3… "Pi Desk Local Dev"
```

脚本里三个必须记住的坑（都是当场踩出来的）：

1. **不需要 sudo**：`security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db` 就够，
   不用写 `/Library/Keychains/System.keychain`（那条 `sudo` 命令是多余的）
2. **OpenSSL 3.5 默认写出的 PKCS#12 macOS 读不了** → `MAC verification failed during PKCS12 import (wrong password?)`。
   必须 `-macalg sha1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES` 退回 legacy 算法
3. **`security import -a` 不是 app**，是「扩展属性 name value」；给 codesign 开 ACL 用 `-T /usr/bin/codesign`，
   否则会弹「codesign 想要访问 密钥」（点了 Always Allow 也行，但 CI/脚本会卡住）

证书文件在 `~/.pi/codesign/`（key/cer/p12 全 600），口令 `pidesk`，2036-09-24 到期。`--force` 可重建，
⚠️ 换证书 = 所有已给的 TCC 授权全部作废（DR 里的 cert hash 变了）。

### 日常用法（4 个脚本全部带 `-h | --help`）

```bash
./.pi/bin/pidesk-sign.sh --list                       # 身份 + 各 bundle 现状
./.pi/bin/pidesk-sign.sh bin/pi-desk.app              # 重签 + 自动验 DR
cd ~/develop/git/github/pi-desk && ./.pi/bin/pidesk-adopt-identity.sh   # ⚠️ 在 Terminal.app 里跑
```

`pidesk-sign.sh` 有硬安全栏：**目标 bundle 有活进程时拒绝原地重签**（codesign 改写被 mmap 的主二进制
= SIGKILL；正式版在跑时那个 pid 通常就是你当前会话的父进程）。实测 exit 3 并打印 pid。

`pidesk-adopt-identity.sh` 的四步 = 退正式版 → 签 → 换进 `/Applications` → `tccutil reset ScreenCapture dev.pi.desk`
→ 重开。**最后必须手动点一次「允许」**（这是唯一的一次性人工代价），之后 Cmd+Q 重开一次授权才生效。

### 出包：`pidesk-dmg.sh`（双击即装）

不能直接用上游的 `wails3 task darwin:package:dmg`，因为它的依赖链里 adhoc 在打包**之前**（日志真实两行）：

```
[darwin:codesign:adhoc] codesign --force --deep --sign - "bin/pi-desk.app"
task: [darwin:create:dmg] wails3 tool package --format dmg --name "pi-desk" --out "bin" ...
```

而 `wails3 tool package --format dmg` 不重签，只把 `bin/pi-desk.app` 原样搬进镜像（挂载实测 dmg 内那份
CDHash 与 bin 里一致）→ dmg 里装到的就是 adhoc 那份。所以正确顺序只能是：package → 重签 → `create:dmg`。

```bash
./.pi/bin/pidesk-dmg.sh                    # 构建 → 重签 → 出 dmg → 挂载验 DR → 归档
./.pi/bin/pidesk-dmg.sh --skip-build       # 只换签名重出 dmg（[~26s]）
./.pi/bin/pidesk-dmg.sh --universal        # arm64 + amd64
./.pi/bin/pidesk-dmg.sh --adhoc            # 反向对照，复现根因用
./.pi/bin/pidesk-dmg.sh --artifacts        # 强制重建 remote-helper 产物（同步上游后）
```

实测（arm64）：全链路 24s（缓存热）、`--skip-build` 26s；产物 `bin/dist/pi-desk-1.0.3-arm64.dmg` 15M，
另有 `bin/dist/latest.dmg` 软链；dmg 自带 `Applications` 软链，拖拽即装。
**验收不是看构建日志，而是脚本自己 `hdiutil attach` 后读 dmg 里那份的 DR**；不对就 exit 5 不产出。
收尾它会对比 `/Applications/pi-desk.app` 的 DR，仍为 adhoc 就打印那条一次性的 `tccutil reset ScreenCapture dev.pi.desk`。

⚠️ 未跑过的分支：`pidesk-mkcert.sh --force`（重建证书 = 旧授权全作废）与 `--universal`（两份交叉编译）。

### 日常构建循环（2026-09-27 改版）

一句话规则：**只要装进去的那份是同一张证书签的，覆盖安装 + 重编译 = 永不再弹权限框**。
授权认的是 DR（`identifier + certificate root`），不是文件内容。

三条 adhoc 出口的现状与分别：

| 出口 | bundle id | 谁拿授权 | 现状 |
|---|---|---|---|
| `/Applications/pi-desk.app` | `dev.pi.desk` | 正式版；**会话里跑 `pidesk-shot` 的 responsible process 就是它** | ✅ 已绑证书 |
| `pidesk-shot --boot` → `/tmp/pidesk-sandbox/Sandbox.app` | `dev.pi.desk.dev` | 沙箱实例自己 | ✅ 已改（`~/.pi/agent/bin/pidesk-shot:98`，身份优先、无身份退回 adhoc；备份 `/tmp/pidesk-shot.bak.*`） |
| `wails3 dev` → `bin/pi-desk.dev.app` | `dev.pi.desk.dev` | dev 实例自己 | ❌ 仍需 `build/darwin/Taskfile.yml:197` 那 2 行（未改） |

两个容易搞混的点：

- 拍图权限到底算谁的？`pidesk-shot` 内部跑 `screencapture`，TCC 算到 **responsible process** 头上：
  在 Pi Desk 会话里跑 = 算 `dev.pi.desk`（正式版）；在 Terminal.app 里跑 = 算 Terminal。
  所以只要正式版本身签对了，agent 拍图就不该再被问 —— 沙箱那份的身份只影响沙箱自己的录屏/通知。
- **弹框只在真正调截屏 API 时出现**。`pidesk-shot --list`（`CGWindowListCopyWindowInfo`）只会把 title
  列磨空，不弹框 → 所以 `tccutil reset` 后“没弹框”= 还没人真的截过图，不是授权丢了。逼出弹框：
  `pidesk-shot --pid <pid> --raise /tmp/x.png`。

重编译后的验收循环（不需重新授权就通过）：

```bash
./.pi/bin/pidesk-dmg.sh --skip-build          # 重签 + 重出 dmg，[~26s]
codesign -d -r- /Applications/pi-desk.app | grep designated   # 永久 = certificate root
# 装上去、重开后：
PID=$(ps ax -o pid,command | grep 'MacOS/pi-desk' | grep -v grep | awk '{print $1}' | head -1)
pidesk-shot --pid "$PID" --list | tail -2      # title 非空 = 权限跟着新二进制走
```

⚠️ **拿 pid 一律用 `ps ax -o pid,command | grep`，不要用 `pgrep`**：macOS 的 `pgrep/pkill`
**从不列出自己所在的祖先链** → 在 Pi Desk 会话里查宿主那个 pi-desk 必定漏（实测只返回沙箱 58326，
漏掉宿主 58204），而 `ps ax` 正常。在 Terminal.app 里两者等价。详见下面「pgrep/pkill 的真实规则」段。

### 已做：`wails3 dev` / `darwin:package` 也走固定身份（2026-09-27 20:30）

`build/darwin/Taskfile.yml` 两处 adhoc 硬编码已改成 env 优先（共 2 行命令 + 4 行注释，默认行为不变）：

| 位置 | 用途 | 现在 |
|---|---|---|
| `codesign:adhoc`（`create:app:bundle` 调） | `darwin:package` | `--sign '{{.PIDESK_SIGN_ID \| default "-"}}'` |
| `darwin:run` 内联 | `wails3 dev` 的 primary 进程 | 同上 |

**两种跑法都实测过**（env 变量能穿透到 Task 模板）：

```bash
env -u PIDESK_SIGN_ID wails3 task darwin:create:app:bundle
# [darwin:codesign:adhoc] codesign --force --deep --sign '-' "bin/pi-desk.app"
# designated => cdhash H"f04c1002…"          flags=0x2(adhoc)      ← 默认不变 ✅

PIDESK_SIGN_ID="Pi Desk Local Dev" wails3 task darwin:create:app:bundle
# codesign --force --deep --sign 'Pi Desk Local Dev' "bin/pi-desk.app"
# designated => identifier "dev.pi.desk" and certificate root = H"3368ead3…"  flags=0x0(none) ✅

PIDESK_SIGN_ID="Pi Desk Local Dev" PI_DESK_DATA_DIR=/tmp/pidesk-sandbox/data wails3 task darwin:run
# dev.app → identifier "dev.pi.desk.dev" and certificate root = H"3368ead3…"  flags=0x0(none) ✅
```

接线：`.pi/bin/dev-sandbox.sh` 开头会自动 `export PIDESK_SIGN_ID`（身份存在才设），并打印
`dev-sandbox: 签名身份 Pi Desk Local Dev（dev.app 的 DR 会绑证书）`。不想用：`PIDESK_SIGN_ID= ./.pi/bin/dev-sandbox.sh`（空值→ Taskfile 退回 adhoc）。

⚠️ **还差一次人工授权**：`dev.pi.desk.dev`（dev.app 与 `pidesk-shot --boot` 的沙箱）以前一直是 adhoc，
所以它从来没有过自己的录屏授权；现在签名稳定了，**第一次**拍到它时补一次
`tccutil reset ScreenCapture dev.pi.desk.dev` → 弹框点允许 → 重开，以后不再问。
正式版 `dev.pi.desk` 已于 20:13 完成同样的一步。

### 未验证分支 → 已全部跑过

| 分支 | 结果 |
|---|---|
| `pidesk-dmg.sh --universal` | ✅ 真出 fat 包：`lipo -info` = `x86_64 arm64`（bin 里与 dmg 里各验一次），28M vs arm64 13M，`--verify --deep --strict` 过 |
| `pidesk-mkcert.sh --force` | ✅ 拿探针身份 `Pi Desk Mkcert Probe` 跑的：旧 SHA1 `EF2B772C…` → 新 `CF671940…`，旧身份确实被删、新身份可用；真身份 `3368EAD3…` 全程未动，探针已清理 |
| 新增守卫 | `--universal --skip-build` 现在直接拒绍（exit 2）—— 不然会给出一个**贴错名字的单架构包** |
| 文件命名 | 改成按 CN 生成 slug：`~/.pi/codesign/pi-desk-local-dev.{key,cer,p12}` + `cert-pi-desk-local-dev.cnf`；旧名 `pidesk-dev.*`/`cert.cnf` 是当前在用证书的首版备份，**别删**（弄丢 p12 就得重建证书 = 重新授权） |
| 可测性 | `PIDESK_MKCERT_CN="…"` 可建第二个身份（验创建/删除路径不碰真身份） |

### 谁真正需要「屏幕录制」授权（别给 dev 实例白跑一次）

正式版 `dev.pi.desk` 已授权（20:13 实测 title 非空）。`dev.pi.desk.dev`（dev.app / `pidesk-shot --boot` 的沙箱）
**只在「会话跑在该实例里」时才需要自己的授权**，因为：

```bash
strings -a bin/pi-desk.app/Contents/MacOS/pi-desk | grep -icE \
  "CGRequestScreenCaptureAccess|SCShareableContent|CGWindowListCreateImage|ScreenCaptureKit|screencapture"
# 0  ← app 自己从不截屏
```

`pidesk-shot` 调的是 `/usr/sbin/screencapture`，TCC 把授权算到 **responsible process**（宿主 app）头上。
所以：在正式版会话里让 agent 拍图 = 用正式版的权限（已通）；在 dev 实例里开会话拍图 = 才需要 dev 的那一次。

### dev 实例的两个新坑（2026-09-27 20:35-20:50 实测）

**坑 1：`dev-sandbox.sh` 与 `pidesk-shot --boot` 抢同一把锁。** 两者默认都是 `/tmp/pidesk-sandbox`，
于是 `PI_DESK_DATA_DIR` 相同 → `InstanceIDFor` 算出同一个锁名 → 第二个实例走
`single_instance_darwin.go` 的 `os.Exit(0)`，**构建成功、vite 照常起、窗口起不来、零报错**（§3.1.0 那个症状的第二个成因）。
锁名可复算（用的是**未解 symlink** 的路径）：

```bash
python3 -c "import hashlib;print(hashlib.sha256(b'/tmp/pidesk-sandbox/data/state.json').hexdigest()[:12])"
# 77b91e5f4ac8  ← 实测就是沙箱 pid 58326 持有的 com.pidesk.desktop-77b91e5f4ac8.lock
```

已修：`dev-sandbox.sh` 启动前自己算锁名并 `lsof` 查持有者，命中就报出 pid + 两条出路（实测输出正确）。
并行跑法：`PIDESK_SANDBOX_DIR=/tmp/pidesk-dev ./.pi/bin/dev-sandbox.sh`。

**坑 2：`--universal` 会把 dev 构建毒掉。** 它留下 fat 形态的 `bin/pi-desk`，而 go 拒绝往 fat 文件上写单架构产物：

```
pi-desk: go build pi-desk: build output "bin/pi-desk" already exists and is not an object file
ERROR task: Failed to run task "build": exit status 1     ← wails3 dev 的 blocking build 直接死
```

已修两头：`pidesk-dmg.sh` 打完通用包就删这个中间产物；`dev-sandbox.sh` 启动前发现 `lipo -archs` 输出含空格（多 arch）就删掉重建。

**坑 3（工具用法，不是代码）：`pkill -f 'wails3 dev'` 会自杀。** 我把它和它要杀的字符串写在同一条命令里，
自己的 `bash -c` argv 里就含那个字面量 → pkill 把工具 shell 自己扁了（exit 143）。
`dev-sandbox.sh` 的 `stop` 已改成 `ps ax -o pid=,comm= | awk '$2 ~ /wails3$/'` + `kill`，别再往回改。

**仍未拿到**：dev 实例窗口的一张真图。两次 `PIDESK_SANDBOX_DIR=/tmp/pidesk-dev ./.pi/bin/dev-sandbox.sh --fresh`
在 90s 内没起出窗口，日志停在 `dev-sandbox: 签名身份 …` 那一行，原因未查（每次要烧 90s，先停手）。
但签名侧已经证明：`wails3 task darwin:run` 出来的 `bin/pi-desk.dev.app` = `flags=0x0(none)` +
`identifier "dev.pi.desk.dev" and certificate root = H"3368ead3…"`。

### pgrep/pkill 的真实规则（纠正本节早先写错的“Seatbelt”结论）

不是沙箱屏蔽，而是 **macOS 的 pgrep/pkill 从不列出自己所在的祖先链**（man 页：own pid 与其 parents never listed）：

```
pgrep -f 'MacOS/pi-desk'  → 只给 58326（沙箱），漏了 58204   ← 58204 就是宿主本尊，我的祖先
ps ax -o pid,command | grep '[M]acOS/pi-desk' → 58204 + 58326 都在
pkill -0 -f Sandbox.app → rc=0（非祖先进程完全正常）
```

→ 结论：**查「宿主那个 Pi Desk」必须用 `ps`；查沙箱/dev 实例用 pgrep 没问题**。
已改：`pidesk-adopt-identity.sh` 的 `child_pids()`、`dev-sandbox.sh` 的 `wails_dev_pids()`/`kill_wails_dev()`
全部换成 ps 法（实测 `dev-sandbox.sh status` 与 `--real` 守卫分支输出正确）。

### 3.2 改了扩展/技能/设置后怎么生效

Pi 的 `/reload` **在桌面端调不到**：它只实现在交互式 TUI（`interactive-mode.js`（约 2556 行））和扩展的命令
上下文（`rpc-mode.js`（约 233 行 commandContextActions`），RPC 的入站命令表（`rpc-mode.js`（约 298-542 行））里没有
reload 帧 —— 往输入框打 `/reload` 只是把这五个字当正文发给模型。

替代：任务菜单 → **「重载 Pi 资源」**（`reloadThreadResources`）= 关掉该任务的 Pi 进程，再用同一个
`sessionFile` 重启 → 扩展 / 技能 / prompt 模板 / 主题 / settings / context files 全部重新加载，历史不丢。

---

## 4. 测试与验收

```bash
go test ./...                                   # Go 单测（含 main_test.go）
cd frontend && npm run check                     # typecheck + vitest + build + smoke:dist
wails3 task verify:pi-live                       # 真机联调已安装的 pi CLI / SSH / 终端 / 会话索引
wails3 task verify:ssh-live                      # Docker 隔离的 SSH helper/lease 验收矩阵（需 Docker + npm）
```

`verify:pi-live` 需要 `pi --version` 可用；它会跑 `internal/piruntime`、`internal/remotessh`、`internal/terminal`、`internal/sessionindex` 的 live 测试（见 `Taskfile.yml` `verify:pi-live`）。

---

## 5. 六个坑

1) **App 找 `pi` 只靠 PATH，没有兜底路径**（实测修正，见第 7 节）。`internal/piruntime/locator.go:91-106` 的 `Resolve()` 仅 `LookPath("pi")`，失败即返回 error，不猜 `~/.npm-global`、不读 `/etc/paths`。因此谁启动它就听谁的 PATH：
   - 终端 `open` / 直接跑二进制 → 继承当前 shell 的 PATH（含 `/opt/homebrew/bin`，✅ 可用）
   - Finder / Dock 启动 → 用 launchd 用户域 PATH，本机 `launchctl getenv PATH` = `/opt/homebrew/bin:...:/sbin`（✅ 可用）
   - 从净化环境启动（`env -i`、cron/CI、某些 launcher、被改过 PATH 的 LaunchAgent）→ ❌ 找不到 `pi`，UI 里表现为 runtime 起不来
   一次性把所有上下文都修好：`sudo launchctl config user path /opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`（需重启生效）
2. **`go build` 单独跑会失败**。`main.go:28`/`:31`/`:34` 三处 `//go:embed` 依赖 `frontend/dist`、`build/windows/icon.ico`、`build/remote-helper/artifacts`，前两者与 helper 产物都在 `.gitignore` 中，必须由 `wails3 build` 先生成。
3. **Pi 版本上限（注意是排他的）**。校验在 `internal/remotessh/artifact.go:159`：`min <= v && v < max` —— `-pi-max` 是**开区间上界**。
   - 2026-09-22 之前写死 `-pi-min 0.84.2 -pi-max 0.86.0` → 实际只放行 `0.84.2 … <0.86.0`，**连 0.86.0 本身都被拒**（当时文档说「提到 0.86.1 就行」是错的，那样 0.86.1 仍然被拒）。症状：本地 workspace 正常，远程 SSH workspace 被 manifest 校验拒掉。
   - 现在：`build/Taskfile.yml:33` = `-pi-min 0.84.2 -pi-max 0.88.0`（含 0.86.x / 0.87.x；本机 `pi --version` = 0.87.0）。默认值同步改在 `cmd/pi-desk-remote-artifacts/main.go:34`。
   - 改完必须重生 manifest（`task` 本机未装，直接跑 target 里的命令即可，约 2s，产物在 gitignore 里）：
     ```bash
     go run ./cmd/pi-desk-remote-artifacts -output build/remote-helper/artifacts \
       -build-identity pi-desk-v1.0.3-p1 -pi-min 0.84.2 -pi-max 0.88.0
     python3 -c "import json;a=json.load(open('build/remote-helper/artifacts/manifest.json'))['artifacts'];print(sorted({(x['os'],x['piVersionMin'],x['piVersionMax']) for x in a}))"
     wails3 build   # 重新 embed 产物
     ```
   - ⚠️ 抬上限等于**声明**与那些 pi 版本协议兼容；`remoteprotocol.Version` 仍是 1，但没有跨版本的兼容测试兜底（`SelectHelperArtifact` 注释：No … fallback exists）。真用远程前先跑一次 SSH workspace 冒烟。
4. **构建产物全部忽略**：`bin/`、`frontend/dist/`、`frontend/node_modules/`、`build/remote-helper/artifacts/helper-*`、`manifest.json` 不进 git；清仓库只需 `rm -rf bin frontend/dist frontend/node_modules`。
5. **每次 `wails3 build` 会脏改 `frontend/package-lock.json`**（实测：本机 npm 11.5.1 删掉 54 行 `libc: [glibc|musl]` 字段，lockfile 是 npm 10 生成的）。提交前先 `git checkout -- frontend/package-lock.json`，否则 diff 里混入无关噪声。
6. **`wails3 dev` 崩了会留孤儿 vite 占住 9245**（实测 2026-09-22：`ERROR listen tcp 127.0.0.1:9245: bind: address already in use`，而 `ps aux | grep wails` 什么都看不到）。真凶是一个叫 `node` 的子进程（PPID=1，已活 11h），因为名字不含 wails 所以常被漏掉；`lsof -i:9245` 不带 `-nP` 会先做反向 DNS，慢且容易看起来为空。
   ```bash
   lsof -nP -iTCP:9245                      # 看谁占着（必带 -nP）
   lsof -nP -tiTCP:9245 -sTCP:LISTEN | xargs kill   # 清场
   ps ax -o pid,etime,comm | grep -E "wails3|vite" | grep -v grep   # 确认无残留
   # 不想杀就换端口（Taskfile 读 WAILS_VITE_PORT，见 Taskfile.yml:7）
   WAILS_VITE_PORT=9246 wails3 dev -config ./build/config.yml -port 9246
   ```

---

## 6. 运行模型（排障定位用）

```text
Vue -> Wails service -> Go host -> pi --mode rpc
                         |-> local filesystem/Git/PTY
                         |-> SSH -> remote-helper -> remote root
```

- 起进程的代码：`internal/piruntime/process.go:142`（`args := []string{"--mode", "rpc"}`）
- 定位 pi 可执行文件：`internal/piruntime/locator.go:91-106` `Resolve()` → 只有 `LookPath("pi")`，无兜底路径
- App 读写 Pi 自身目录，走 env `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`（默认 `~/.pi`）
- 窗口默认 1440x900、最小 980x680（`main.go` `defaultWindowWidth`）；关窗不退出，收进系统托盘

---

## 7. 实测记录：`open` 与 PATH 的传播（2026-09-21，darwin/arm64）

| 实验 | 命令 | 结果 |
|---|---|---|
| E1 基线 | `open bin/pi-desk.app` | 起来了，WebKit 正常渲染，PID 存活，unified log 有活动 |
| E1 的 App PATH | `ps eww -p $PID` | 含 `/opt/homebrew/bin`（出现 12 个 homebrew 条目）→ 说明 `open` **会透传调用方 shell 环境** |
| E2 决定性 | `env PATH=/usr/bin:/bin:/usr/sbin:/sbin open bin/pi-desk.app` | App 的 PATH **正好等于**这个净化值 → 证实「App PATH = 启动方 PATH」 |
| E3 故障复现 | `env PATH=/usr/bin:/bin:/usr/sbin:/sbin bash -c 'command -v pi'` | 空 → `Resolve()` 返回 error，即该上下文下 agent 起不来 |
| E4 Finder 路径 | `launchctl getenv PATH` | `/opt/homebrew/bin:...:/sbin` → Dock/Finder 启动也 OK |

**结论**：原先写的「不能用 `open`」证伪 —— `open` 本机可用。真正的规则是一句话：**App 用启动方的 PATH 找 `pi`**。所以只要启动上下文正常，怎么开都行；出问题先跑第 3 节的 `ps eww` 看 PATH，而不是重装。

---

## 8. Markdown 预览链路 + 一次滚动 bug

| 层 | 位置 | 说明 |
|---|---|---|
| 渲染器 | `frontend/src/components/MarkdownBody.vue:23` | `new MarkdownIt({ html:false, breaks:true, linkify:true })`，**不是** milkdown |
| 超限降级 | `frontend/src/components/MarkdownBody.vue:20` `MAX_MARKDOWN_CHARS = 100_000` → `:52` 判定、`:136` 降级分支 | 超过则走 `<pre class="oversized-message">` 纯文本 |
| 链接改写 | `frontend/src/components/MarkdownBody.vue:27-49` + `src/utils/fileLinks.ts` | `./foo.ts`（第 12 行） 类相对链接变成 `a.markdown-file-link`，点击→ `appStore.openRepositoryFilePreview()`（`frontend/src/components/MarkdownBody.vue:110`） |
| 搜索高亮 | `frontend/src/components/MarkdownBody.vue:54` `highlightRenderedHtml` | 用 `<template>` + TreeWalker 往渲染完的 HTML 里塞 `<mark>` |
| 两个消费方 | 会话消息 `frontend/src/components/ConversationMessage.vue:292/320/352`；文件预览 `frontend/src/components/InspectorPanel.vue:221` | 文件预览有 Rendered / Source 切换（`frontend/src/components/InspectorPanel.vue:217-220`） |
| 样式 | `layout.css:3483`（`flex:1 1 auto` + `min-height:0`）、`layout.css:3506`（`padding:14px` + `overflow:auto`） | 两条规则共同构成滚动容器 |
| 编辑（另一条链路） | `MarkdownEditor.vue` → `MarkdownEditorCore.vue` | milkdown/prose，只用于输入框 ComposerBar，与预览无关 |

**已修 bug（“打开 markdown 无法滚动”**）：`MarkdownBody` 是多根组件（内容节点 + `FileLinkContextMenu`），Vue 对多根组件**不自动透传 attrs**，所以 `frontend/src/components/InspectorPanel.vue:221` 传的 `class="file-markdown-preview"` 被静默丢弃（dev 下只有一条 `Extraneous non-props attributes` 警告）→ `layout.css:3483/3506` 的 `flex:1 1 auto; min-height:0; overflow:auto` 从未生效 → 内容被 `layout.css:3427` 的 `overflow:hidden` 裁掉，整个面板里没有任何可滚容器。修法：`frontend/src/components/MarkdownBody.vue:18` 加 `defineOptions({ inheritAttrs:false })`，并在两个根分支（`:129` div / `:136` pre）上 `v-bind="$attrs"`；回归测 `src/components/MarkdownBody.attrs.test.ts`（2 例）。

→ 多根组件 + 外部 class/style = 静默失效，写组件时要么单根，要么显式绑 `$attrs`。全仓已扫过，仅此一处命中。

---

## 9. 文件树状态的生命周期（什么时候会丢）

展开态按 workspace 分桶（`repositoryKey(thread)` = `workspaceId` 优先，否则路径规范化），**并且现在会落盘**；
滚动位置是 per-tab，跟着 `panelState` 走：

| 状态 | 存哪 | 写入 | 读取/回填 | 跨重启 |
|---|---|---|---|---|
| 哪些目录展开 | `frontend/src/stores/app.ts:1157` `repositoryTreeExpandedByWorkspace` | 单个目录 `:2074 setRepositoryTreeExpanded`；批量 `:2084 setRepositoryTreeExpandedBulk`（⇕/⇅ 按钮在 `InspectorPanel.vue` `.panel-file-tools` 行） | getter `:1339` → `frontend/src/components/FileTreeNode.vue:31` `open = computed(...)`（**无记录 = 收起**，只有「当前预览文件的祖先」自动展开） | ✅ `desktop.preferences.treeExpanded` |
| 滚动位置 | tab 上的 `scroll` 字段（上游 per-tab；我们那套 `repositoryTreeScrollTopByWorkspace` 已在 `aac64af` 删除） | `InspectorPanel.vue` 的 `@scroll.capture` → `saveScroll` | `restoreScroll`（`immediate` watch）；**没落地的选择器挂在 `unrestoredOffsets` 里，由 `fileTree` / `treeOpen` 以 `flush:"post"` 重试**（`baefc1d`） | ✅ 随 `panelState`（10-12 之前只存不恢复） |

硬规则：

- **不要改回组件本地状态。** `InspectorPanel.vue` 的文件预览是 `v-if` 分支 → `.file-tree` 整个被卸载重建，
  任何本地 ref 都必然归零（这就是 2026-09-23 两个 bug 的同一个根因）。
- **进 `state.json`**（2026-10-12 `f97b5f6`，推翻 2026-09-23「冷启动回默认位置就是合理行为」的判定 ——
  那时默认是顶层展开，现在默认全收起，不持久化等于每次冷启动补十几个点击）。
  走的是 `panelState` 同款路子：**opaque JSON string**，Go 三层只透传不解析
  （`domain/catalog.go` + `workspace/catalog.go` 各一个 `TreeExpanded string \`json:"treeExpanded,omitempty"\``，
  `appservice/catalog.go` 两处逐字段映射），所以坏 blob 由读侧降级成「全收起」，不会让加载失败。
  存盘 payload 在 `frontend/src/stores/app.ts:4640-4650`（`packTreeExpanded` 在 `:730`，回填在 `:4315-4325`）
  → 想知道持不持久化，查那张表而不是猜。
  ⚠️ 只写 open 的目录：`false` 与「无记录」等价，别把它写回去撑大文件。
  ⚠️ 改完 Go 侧字段必须 `wails3 generate bindings -f '' -clean=true -ts -i`，
  且**在仓库根目录跑** —— 在 `frontend/` 里跑会输出到 `frontend/frontend/bindings` 且 0 models（实测踩过）。
- ⚠️ **滚动写入会回声**（`baefc1d` 的根因，别再踩）：给 `element.scrollTop` 赋值会触发一个 `scroll` 事件；
  内容还没渲染完时 WebKit 把它 clamp 回 0，于是 `saveScroll` 把**自己刚写的值读成 0 存回去**。
  实测：seed `.panel-file-tree: [0,1200]` → 启动一次 → `state.json` 变成 `[0,0]`。
  所以任何「回填 scrollTop」的代码都必须同时（1）把没落地的目标挂在待重试集合里，
  （2）`saveScroll` 遇到还在等内容的选择器就**直接丢弃该事件**。
  只修其中一条都不够：只加重试 → 值已被清零；只挡回声 → 永远不再有人去应用它。
  ⚠️ jsdom 不做 clamp（写多少存多少），所以这一半只能靠真引擎验：`/tmp/tree-5-top.png`（首行 `docs` 而非 `.github`）。
- 列表渲染上限 `frontend/src/components/InspectorPanel.vue:66` `FILE_LIST_LIMIT = 5000`，与后端 `internal/repository/repository.go:25 maxFiles = 5000` 对齐；
  5000 行实测 35011 个 DOM 节点 / 首帧 44ms / 滚动 0.1ms → 不分页、不做虚拟列表。

⚠️ dev 期间的边角：改 **Go** 会让 `wails3 dev` 重编并重启进程（看 `ps ... lstart`）→ 两条状态都回默认；
只改前端走 Vite HMR → 不丢。所以“树怎么又弹回顶部”先问自己刚才动的是哪一边。

回归测钢钉：`InspectorPanel.test.ts`（默认收起 / 展开往返 / 批量⇕⇅ / scrollTop 往返 / **树栏后挂载仍能落位**）
+ `stores/app.test.ts`（分桶隔离 / 默认规则 / 负值归零 / **`treeExpanded` 只打包 open + 坏 blob 降级**）
+ `internal/appservice/catalog_test.go`（`TestDesktopPreferencesFieldsAreCarried`：domain 字段 ↔ 两处映射，防「存了读不回」）。
