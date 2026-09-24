# Pi Desk

Pi Desk 是 Pi coding agent 的 Wails v3 桌面客户端。Pi 继续负责 agent runtime，Pi Desk 提供桌面 UI、workspace/session 管理、定时任务、Repository、Terminal，以及受信任的远程 SSH workspace。

主要能力：

- Repository：模糊文件检索与只读多标签预览。
- Extensions：通过 Pi 官方 CLI 管理全局及 workspace 的扩展包。
- 定时任务：一次/每小时/每天/工作日/每周计划，绑定受信任的本地 workspace。
- 队列与输入：流式提示词队列、文件引用与图片附件。
- 远程 SSH workspace：host key 校验与 lease 隔离的远端 Repository、Terminal 与 Pi task。

## 运行模型

```text
Vue -> Wails service -> Go host -> pi --mode rpc
                         |-> local filesystem/Git/PTY
                         |-> SSH -> remote-helper -> remote root
```

## 配置文件

`~/.pi-desk/config.json` 放的是可以直接手改的偏好，和 `state.json`（应用自己写的记忆）分开：
改完切回 Pi Desk 窗口就生效，不需要重启。设置 → 常规 → 「吐字与面板」写的是同一个文件。

```json
{
  "streamPanels": "auto",
  "reveal": { "split": 5, "floor": 2, "ceiling": 160 },
  "scroll": { "snapWithinPx": 140, "factor": 0.35, "resumeWithinPx": 24, "liveWindowDelayMs": 1200 }
}
```

| `streamPanels` | 吐字期间推理 / 工具调用窗口怎么表现 |
|---|---|
| `auto`（默认） | 回答还没开始打字时，当前推理块和超过 1.2s 的运行中调用自动开一个固定高度的窗口；回答一开始就交还位置 |
| `alwaysOpen` | 本轮所有窗口全程保持打开，回答结束后也不收起 |
| `alwaysClosed` | 什么都不自动打开 |

三种模式下，**你自己点开或关上的窗口一律保持你留下的状态**（按消息 id 记，切换会话不丢）。

`reveal` 管吐字速度：每帧放「积压字数 ÷ `split`」个字符，再夹到 `[floor, ceiling]`。
调大 `split` 更慢更连贯，调小 `ceiling` 可以压掉模型一次吐一大段时的冲击感。

`scroll` 管跟随：跳动 ≤ `snapWithinPx` 直接钉到底部，更大的跳动每帧走剩余距离的 `factor`；
离底部 `resumeWithinPx` 以内算「你还跟着」；工具调用要跑满 `liveWindowDelayMs` 才自动开实时窗
（大多数调用一瞬间完成，不该为它们挪动版面）。

两组都是可选的：只写想改的键，其余用出厂值（上例就是出厂值）。越界或类型不对的单个字段会回落
出厂值，并在设置 → 常规 顶部给出提示；设置面板里的「当前生效的吐字/跟随参数」显示的就是实际值。

验证用的隔离实例（`PI_DESK_DATA_DIR=<dir>`）会把这份文件读成 `<dir>/config.json`；
`PI_DESK_CONFIG=/path/to/file.json` 可以指死单个文件。未知键保留、未知取值回落 `auto`。
