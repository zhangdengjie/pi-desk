# ADR-007: SQLite 并发、PRAGMA 与备份

- Status: Proposed (R0)
- Date: 2026-11-08
- Related: `GUIDE.MD` §4.2、§8.5
- Deciders: TBD

## Context

选 `modernc.org/sqlite`（纯 Go、无 cgo）。SQLite 的 PRAGMA 是每连接生效的；`database/sql` 连接池里只执行一次 `PRAGMA` 不能保证其他连接也带上。WAL 支持多读单写，但并发写会 `database is locked`。

## Decision

```text
驱动        modernc.org/sqlite
写连接      MaxOpenConns=1 / MaxIdleConns=1；单写 goroutine
读连接      MaxOpenConns=4；mode=ro + query_only=1
PRAGMA      走 DSN _pragma 参数，每连接生效
备份        VACUUM INTO，不在 WAL 活跃时 cp 主文件
路径        url.URL{Scheme:"file", Path: dbPath} 处理空格
```

DSN 示例见 `GUIDE.MD` §4.2。写路径只走 `writeDB`；事务内只用 `tx`，禁止在 `tx` 里调用 `writeDB.Exec`（会另开连接，可能自锁）。

## Consequences

正向：消除大部分并发写锁；读不阻塞写；PRAGMA 行为可预测；备份一致。

负向：单写连接是吞吐上限（桌面端足够）；读写分离需要「读己之写」时显式走写连接；连接池配置容易写错。

## Alternatives

1. 全部用一个连接（`MaxOpenConns=1`）→ 可行但读会排队；作为最小实现备选。
2. `mattn/go-sqlite3` → 否定：cgo，跨平台构建复杂。
3. 外部数据库 → 否定：本地优先。

## Verification

- 50 goroutine × 100 条写入：`-race` 无 `database is locked`、无丢更新。
- 路径含空格（`Application Support`）可打开。
- `kill -9` 后重开：WAL 可恢复，无 malformed。
- `VACUUM INTO` 备份可在另一进程打开；恢复演练一次。
- 代码审查：无 `tx` 内 `writeDB.Exec`，无第二处写连接。

## Open questions

- 读连接是否需要 `SetConnMaxIdleTime`（当前默认）。
- WAL 自动 checkpoint 阈值是否需要在 R3 调优。
