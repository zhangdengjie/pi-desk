# ADR-006: Worktree 环境隔离与 Bootstrap

- Status: Proposed (R0)
- Date: 2026-11-08
- Related: `GUIDE.MD` §6.2
- Deciders: TBD

## Context

`git worktree` 只复制已跟踪文件。`node_modules/`、`.venv/`、`target/`、`.env*` 不会自动出现；如果任务包含 `npm test` / 编译，Agent 会在新 worktree 里因缺依赖失败。直接自动复制 `.env` 又会把密钥扩散到多个目录。

## Decision

Worktree 创建后按 workspace 配置执行 bootstrap：

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
symlink  软链 share 列表到父仓库；快，但 npm/pip 可能写坏共享目录
copy     复制 copy 列表；慢，只允许显式 allowlist
command  执行 bootstrap_command；最可靠，失败则 Run 失败
```

约束：

- 默认 `none`；不自动复制 `.env`、密钥、证书；只按显式 allowlist。
- `symlink` 前提示风险；同一依赖目录不要在两个 worktree 同时执行安装。
- bootstrap 失败必须让 Run 失败并提示缺什么，不允许带空依赖继续跑。
- 删除 worktree 不跟随软链；复制进去的 `.env` 随目录删除。
- 分支：同 Task 复用；不同 Task 冲突加 `-<attempt>` 后缀。
- 删除前检查 dirty/untracked 与未合并提交；有提交保留分支并提示导出 patch。
- 远程 workspace 不支持 worktree，入口隐藏并提示。

## Consequences

正向：并行任务不会因缺依赖静默失败；密钥不会默认扩散；行为可预测。

负向：首次创建需要用户选择策略；`command` 模式增加启动时间；共享依赖仍有污染风险。

## Alternatives

1. 总是 `npm install` → 否定：慢，且不同项目命令不同。
2. 总是软链依赖 → 否定：写坏共享目录的风险高。
3. 容器隔离 → 否定：R5 之前不做。

## Verification

- 无 `node_modules` 的 worktree：`none` 下 Run 失败并提示；`command` 下成功。
- `.env` 未在 allowlist 时不出现；出现时只复制显式文件。
- 两个 Task 并行改同一仓库：文件互不覆盖。
- dirty/未合并提交的 worktree 删除被拒绝或标记 orphaned。

## Open questions

- bootstrap 配置存 SQLite workspace 元数据还是 `~/.pi-desk/config.json`（建议后者先落地，后续迁移）。
- 软链依赖的并发安装锁是否需要额外提示。
