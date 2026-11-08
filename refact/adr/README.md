# ADR Index

R0 的架构决策记录。状态：`Proposed` → R0 评审后转 `Accepted`；被取代时标 `Superseded by ADR-xxx`。

```text
001  storage-truth-source      Pi JSONL / SQLite / state.json 的真相源边界
002  event-contract            双通道、事件信封、持久化与截断
003  task-run-semantics        Task / Run / Session 语义与状态机
004  runtime-capabilities      Runtime 薄接口 + 能力声明 + 可选接口
005  identity-and-scope        保留 pi-desk 身份；R0–R3 范围
006  worktree-bootstrap        Worktree 依赖/环境初始化策略
007  sqlite-concurrency        读写连接池、每连接 PRAGMA、备份
008  bindings-and-ci           Bindings 生成、提交与 CI 比对
```

关联文档：

```text
../GUIDE.MD                  实施指南 v2.1
../GUIDE.v1.MD               原始方案归档
../wails-upgrade-spike.md    Wails v3.1 spike 结果
```

约定：

- 每个 ADR 只记录一个决策；实现细节放 GUIDE。
- 决策变更先改 ADR，再改代码；禁止只改代码不回写 ADR。
- ADR 里的 `Verification` 必须能在 R0/R1a 验收时复算。
