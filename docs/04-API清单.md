# 04 · API 清单

> 基准：`feat/r1a-go-data-plane` @ `abc2726`
> **一句话**：Pi Desk 没有 HTTP 层。对前端的暴露面 = **14 个 Wails service 的 147 个绑定函数（159 methods）** + **`pi:event` 与 R1a `agent:event`**；对下游 = **`pi --mode rpc` 的 26 个命令帧** + **remote-helper 帧协议**。

## 0. 怎么重算这份清单

```bash
# 方法总数（应为 147）
grep -h 'export function' frontend/bindings/pi-desk/internal/appservice/*.ts | wc -l
# 单个 service 的方法名
grep -n 'export function' frontend/bindings/pi-desk/internal/appservice/agentservice.ts
# 全表（本文件 §2 由脚本生成：绑定 TS × Go 方法定义交叉定位）
python3 docs/snippets/gen_api_index.py . > /tmp/api.md   # 脚本副本已存进 docs/snippets/
```

`frontend/bindings/**` 是 `wails3 generate bindings` 的产物，文件头第一行写着 “DO NOT EDIT”；所以清单的**权威源**是 Go 方法签名，TS 只是投影。

## 1. 暴露面总览

| Service | Go 文件 | 方法数 | 前端包装 |
|---|---|---|---|
| `AgentService` | `internal/appservice/agent.go` | 33 | `frontend/src/services/agent.ts` |
| `PiExtensionService` | `internal/appservice/extensionconfig.go` | 16 | `services/extensions.ts` |
| `CatalogService` | `internal/appservice/catalog.go` | 22 | `services/catalog.ts` |
| `RepositoryService` | `internal/appservice/repository.go` | 11 | `services/repository.ts` |
| `ModelConfigService` | `internal/appservice/modelconfig.go` | 16 | `services/modelconfig.ts` |
| `RemoteWorkspaceService` | `internal/appservice/remoteworkspaceservice.go` | 9 | `services/remoteWorkspaces.ts` |
| `DesktopService` | `internal/appservice/desktop.go` | 8 | `services/desktop.ts` |
| `McpConfigService` | `internal/appservice/mcpconfig.go` | 6 | `services/mcpconfig.ts` |
| `BrowserService` | `internal/appservice/browserservice.go` | 6 | `services/browser.ts` |
| `ManagedSkillService` | `internal/appservice/skillconfig.go` | 5 | `services/skills.ts` |
| `OrphanSessionService` | `internal/appservice/orphansession.go` | 5 | `services/orphanSessions.ts` |
| `TerminalService` | `internal/appservice/terminal.go` | 5 | `services/terminal.ts` |
| `PromptTemplateService` | `internal/appservice/promptconfig.go` | 4 | `services/prompts.ts` |
| `PiMaintenanceService` | `internal/appservice/pimaintenance.go` | 1 | `services/desktop.ts` |
| **合计** | 14 个 service | **147** | 另有 Wails 自带 `notifications` service（`main.go:190`） |

> 复算方法数分组：`for f in frontend/bindings/pi-desk/internal/appservice/*.ts; do echo "$(grep -c 'export function' $f) $(basename $f)"; done | sort -rn`

---

## 2. 方法全表（脚本生成：TS 绑定 × Go 方法定义交叉定位，147 条）

列含义：`入参`/`返回` 取自生成绑定的 TS 签名；`Go 实现` 是真实方法所在 `文件:行号`。

> 生成命令：`python3 docs/snippets/gen_api_index.py . > /tmp/api.md`（skill 自带的 `api_index.py` 按动词分组，不适合按 service 分，故用这份）。


### AgentService — 33 个方法

绑定：`frontend/bindings/pi-desk/internal/appservice/agentservice.ts`

| 方法 | 入参 | 返回 | Go 实现 |
|---|---|---|---|
| `Abort` | request: domain.ThreadRequest | domain.CommandResult | `internal/appservice/agent.go:385` |
| `AbortBash` | request: domain.ThreadRequest | domain.CommandResult | `internal/appservice/agent.go:447` |
| `AbortRetry` | request: domain.ThreadRequest | domain.CommandResult | `internal/appservice/agent.go:413` |
| `Bash` | request: domain.BashRequest | domain.CommandResult | `internal/appservice/agent.go:417` |
| `CloneSession` | request: domain.ThreadRequest | domain.CommandResult | `internal/appservice/agent.go:588` |
| `Compact` | request: domain.CompactRequest | domain.CommandResult | `internal/appservice/agent.go:795` |
| `DeleteSessionMessage` | request: domain.SessionMessageRequest | domain.CommandResult | `internal/appservice/agent.go:617` |
| `EditSessionMessage` | request: domain.SessionMessageRequest | domain.CommandResult | `internal/appservice/agent.go:603` |
| `ExcludeSessionMessageFromContext` | request: domain.SessionMessageRequest | domain.CommandResult | `internal/appservice/agent.go:621` |
| `ExportSession` | request: domain.ExportSessionRequest | domain.CommandResult | `internal/appservice/agent.go:760` |
| `ForkSession` | request: domain.SessionForkRequest | domain.CommandResult | `internal/appservice/agent.go:592` |
| `ForkSessionAt` | request: domain.SessionMessageRequest | domain.CommandResult | `internal/appservice/agent.go:625` |
| `GetAvailableModels` | request: domain.ThreadRequest | domain.CommandResult | `internal/appservice/agent.go:463` |
| `GetAvailableThinkingLevels` | request: domain.ThreadRequest | domain.CommandResult | `internal/appservice/agent.go:467` |
| `GetCommands` | request: domain.ThreadRequest | domain.CommandResult | `internal/appservice/agent.go:471` |
| `GetDiagnostics` | request: domain.ThreadRequest | string | `internal/appservice/agent.go:845` |
| `GetForkMessages` | request: domain.ThreadRequest | domain.CommandResult | `internal/appservice/agent.go:475` |
| `GetMessages` | request: domain.ThreadRequest | domain.CommandResult | `internal/appservice/agent.go:455` |
| `GetSessionBranches` | request: domain.ThreadRequest | domain.SessionBranches | `internal/appservice/agent.go:479` |
| `GetSessionStats` | request: domain.ThreadRequest | domain.CommandResult | `internal/appservice/agent.go:459` |
| `GetState` | request: domain.ThreadRequest | domain.CommandResult | `internal/appservice/agent.go:451` |
| `ReplaySessionMessage` | request: domain.SessionMessageRequest | domain.CommandResult | `internal/appservice/agent.go:613` |
| `RespondExtensionUI` | request: domain.ExtensionUIResponseRequest | — | `internal/appservice/agent.go:817` |
| `SendPrompt` | request: domain.PromptRequest | domain.CommandResult | `internal/appservice/agent.go:325` |
| `SetAutoCompaction` | request: domain.ToggleRequest | domain.CommandResult | `internal/appservice/agent.go:393` |
| `SetAutoRetry` | request: domain.ToggleRequest | domain.CommandResult | `internal/appservice/agent.go:389` |
| `SetFollowUpMode` | request: domain.QueueModeRequest | domain.CommandResult | `internal/appservice/agent.go:401` |
| `SetModel` | request: domain.ModelRequest | domain.CommandResult | `internal/appservice/agent.go:778` |
| `SetSessionName` | request: domain.SessionNameRequest | domain.CommandResult | `internal/appservice/agent.go:806` |
| `SetSteeringMode` | request: domain.QueueModeRequest | domain.CommandResult | `internal/appservice/agent.go:397` |
| `SetThinkingLevel` | request: domain.ThinkingRequest | domain.CommandResult | `internal/appservice/agent.go:787` |
| `StartSession` | request: domain.StartSessionRequest | domain.LiveSession | `internal/appservice/agent.go:150` |
| `StopSession` | request: domain.ThreadRequest | — | `internal/appservice/agent.go:295` |

### BrowserService — 6 个方法

绑定：`frontend/bindings/pi-desk/internal/appservice/browserservice.ts`

| 方法 | 入参 | 返回 | Go 实现 |
|---|---|---|---|
| `CloseTab` | id: string | — | `internal/appservice/browserservice.go:201` |
| `Command` | id: string, command: string | — | `internal/appservice/browserservice.go:257` |
| `KeepTab` | id: string | — | `internal/appservice/browserservice.go:267` |
| `OpenURL` | request: domain.BrowserOpenURLRequest | domain.BrowserStatus | `internal/appservice/browserservice.go:238` |
| `SetBounds` | request: domain.BrowserBoundsRequest | — | `internal/appservice/browserservice.go:226` |
| `StartTab` | request: domain.BrowserStartRequest | domain.BrowserStatus | `internal/appservice/browserservice.go:76` |

### CatalogService — 22 个方法

绑定：`frontend/bindings/pi-desk/internal/appservice/catalogservice.ts`

| 方法 | 入参 | 返回 | Go 实现 |
|---|---|---|---|
| `AddWorkspace` | request: domain.AddWorkspaceRequest | domain.WorkspaceSummary | `internal/appservice/catalog.go:107` |
| `CacheComposerImage` | image: domain.ImageContent | string | `internal/appservice/catalog.go:799` |
| `DeleteSession` | request: domain.DeleteSessionRequest | domain.DeletedSession | `internal/appservice/catalog.go:466` |
| `DeleteWorkspaceSessions` | request: domain.WorkspaceRequest | — | `internal/appservice/catalog.go:143` |
| `GetDesktopState` | — | domain.DesktopState | `internal/appservice/catalog.go:508` |
| `GetSessionSnapshot` | request: domain.SessionSnapshotRequest | domain.SessionSnapshot | `internal/appservice/catalog.go:303` |
| `GetSessionUsage` | request: domain.ListSessionsRequest | domain.SessionUsageSummary | `internal/appservice/catalog.go:386` |
| `GetUsageReport` | request: domain.UsageReportRequest | domain.UsageReport | `internal/appservice/catalog.go:398` |
| `ListSessions` | request: domain.ListSessionsRequest | domain.SessionSummary[] | null | `internal/appservice/catalog.go:260` |
| `ListWorkspaceApplications` | — | domain.WorkspaceApplication[] | null | `internal/appservice/catalog.go:205` |
| `ListWorkspaces` | — | domain.WorkspaceSummary[] | null | `internal/appservice/catalog.go:92` |
| `OpenWorkspace` | request: domain.WorkspaceRequest | — | `internal/appservice/catalog.go:194` |
| `OpenWorkspaceWith` | request: domain.OpenWorkspaceWithRequest | — | `internal/appservice/catalog.go:217` |
| `PickWorkspace` | request: domain.PickWorkspaceRequest | string | `internal/appservice/catalog.go:85` |
| `ReadComposerImage` | key: string | string | `internal/appservice/catalog.go:822` |
| `RemoveWorkspace` | request: domain.WorkspaceRequest | — | `internal/appservice/catalog.go:135` |
| `RenameWorkspace` | request: domain.RenameWorkspaceRequest | domain.WorkspaceSummary | `internal/appservice/catalog.go:115` |
| `SaveDesktopState` | state: domain.DesktopState | — | `internal/appservice/catalog.go:555` |
| `SearchAllSessions` | request: domain.SessionSearchRequest | domain.SessionSearchResult | `internal/appservice/catalog.go:372` |
| `SearchSessionText` | request: domain.SessionSnapshotRequest | domain.SessionSearchText | `internal/appservice/catalog.go:360` |
| `SessionSnapshotRef` | request: domain.SessionSnapshotRequest | string | `internal/appservice/catalog.go:336` |
| `SetWorkspaceDefaults` | request: domain.WorkspaceDefaultsRequest | domain.WorkspaceSummary | `internal/appservice/catalog.go:127` |

### DesktopService — 8 个方法

绑定：`frontend/bindings/pi-desk/internal/appservice/desktopservice.ts`

| 方法 | 入参 | 返回 | Go 实现 |
|---|---|---|---|
| `CheckForUpdates` | — | domain.UpdateCheckResult | `internal/appservice/desktop.go:450` |
| `CheckRuntime` | — | domain.PiRuntimeStatus | `internal/appservice/desktop.go:108` |
| `ExportDiagnostics` | outputPath: string | — | `internal/appservice/desktop.go:203` |
| `GetBootstrapState` | — | domain.BootstrapState | `internal/appservice/desktop.go:80` |
| `ReadUserConfig` | — | domain.UserConfigView | `internal/appservice/desktop.go:539` |
| `SaveWindowState` | state: domain.WindowState | — | `internal/appservice/desktop.go:114` |
| `ToggleDebugMode` | — | boolean | `internal/appservice/desktop.go:424` |
| `WriteUserConfig` | view: domain.UserConfigView | domain.UserConfigView | `internal/appservice/desktop.go:580` |

### ManagedSkillService — 5 个方法

绑定：`frontend/bindings/pi-desk/internal/appservice/managedskillservice.ts`

| 方法 | 入参 | 返回 | Go 实现 |
|---|---|---|---|
| `CreateManagedSkill` | request: domain.CreateManagedSkillRequest | domain.ManagedSkill | `internal/appservice/skillconfig.go:117` |
| `DeleteManagedSkill` | request: domain.ManagedSkillRequest | — | `internal/appservice/skillconfig.go:184` |
| `GetManagedSkill` | request: domain.ManagedSkillRequest | domain.ManagedSkill | `internal/appservice/skillconfig.go:93` |
| `ListManagedSkills` | request: domain.ListManagedSkillsRequest | domain.ManagedSkillSnapshot | `internal/appservice/skillconfig.go:51` |
| `UpdateManagedSkill` | request: domain.UpdateManagedSkillRequest | domain.ManagedSkill | `internal/appservice/skillconfig.go:154` |

### McpConfigService — 6 个方法

绑定：`frontend/bindings/pi-desk/internal/appservice/mcpconfigservice.ts`

| 方法 | 入参 | 返回 | Go 实现 |
|---|---|---|---|
| `DeleteMcpServer` | request: domain.McpServerRequest | — | `internal/appservice/mcpconfig.go:178` |
| `GetMcpServer` | request: domain.McpServerRequest | domain.McpServer | `internal/appservice/mcpconfig.go:77` |
| `ListImportableMcpServers` | — | domain.McpImportCandidate[] | null | `internal/appservice/mcpconfig.go:286` |
| `ListMcpServers` | request: domain.ListMcpServersRequest | domain.McpConfigSnapshot | `internal/appservice/mcpconfig.go:49` |
| `TestMcpServer` | request: domain.TestMcpServerRequest | domain.McpServerTestResult | `internal/appservice/mcpconfig.go:201` |
| `UpsertMcpServer` | request: domain.UpsertMcpServerRequest | domain.McpServer | `internal/appservice/mcpconfig.go:103` |

### ModelConfigService — 16 个方法

绑定：`frontend/bindings/pi-desk/internal/appservice/modelconfigservice.ts`

| 方法 | 入参 | 返回 | Go 实现 |
|---|---|---|---|
| `AddModels` | request: domain.AddModelsConfigRequest | domain.ModelConfigSnapshot | `internal/appservice/modelconfig.go:261` |
| `DeleteModel` | request: domain.DeleteModelConfigRequest | domain.ModelConfigSnapshot | `internal/appservice/modelconfig.go:376` |
| `DeleteProvider` | request: domain.DeleteProviderConfigRequest | domain.ModelConfigSnapshot | `internal/appservice/modelconfig.go:422` |
| `DiscoverModels` | request: domain.DiscoverModelsRequest | domain.ModelDiscoveryResult | `internal/appservice/modelprobe.go:51` |
| `GetAccountQuota` | request: domain.ModelQuotaRequest | domain.ModelQuotaResult | `internal/appservice/modelprobe.go:272` |
| `GetConfiguredModels` | — | domain.SelectableModel[] | null | `internal/appservice/modelconfig.go:100` |
| `GetModelCatalog` | refresh: boolean | domain.ModelCatalogSnapshot | `internal/appservice/modelauth.go:41` |
| `GetModelsConfig` | — | domain.ModelConfigSnapshot | `internal/appservice/modelconfig.go:90` |
| `LoginModelProvider` | request: domain.ModelAuthRequest | domain.ModelCatalogSnapshot | `internal/appservice/modelauth.go:45` |
| `LogoutModelProvider` | providerID: string | domain.ModelCatalogSnapshot | `internal/appservice/modelauth.go:91` |
| `MissingProviderEnv` | — | domain.ProviderEnvIssue[] | null | `internal/appservice/modelconfig.go:617` |
| `ReplyModelLogin` | request: domain.ModelAuthReply | — | `internal/appservice/modelauth.go:69` |
| `SaveModelAPIKey` | request: domain.ModelAuthRequest | domain.ModelCatalogSnapshot | `internal/appservice/modelauth.go:81` |
| `SetDefaultModel` | request: domain.DefaultModelRequest | domain.ModelCatalogSnapshot | `internal/appservice/modelauth.go:98` |
| `TestModel` | request: domain.TestModelConfigRequest | domain.ModelTestResult | `internal/appservice/modelprobe.go:125` |
| `UpsertModel` | request: domain.UpsertModelConfigRequest | domain.ModelConfigSnapshot | `internal/appservice/modelconfig.go:180` |

### OrphanSessionService — 5 个方法

绑定：`frontend/bindings/pi-desk/internal/appservice/orphansessionservice.ts`

| 方法 | 入参 | 返回 | Go 实现 |
|---|---|---|---|
| `DeleteOrphanSession` | request: domain.DeleteSessionRequest | domain.DeletedSession | `internal/appservice/orphansession.go:99` |
| `ExportOrphanSession` | request: domain.ExportOrphanSessionRequest | — | `internal/appservice/orphansession.go:120` |
| `GetOrphanSessionSnapshot` | request: domain.SessionSnapshotRequest | domain.SessionSnapshot | `internal/appservice/orphansession.go:65` |
| `ListOrphanSessions` | — | domain.OrphanSessionSummary[] | null | `internal/appservice/orphansession.go:47` |
| `RestoreOrphanSession` | request: domain.RestoreOrphanSessionRequest | — | `internal/appservice/orphansession.go:80` |

### PiExtensionService — 16 个方法

绑定：`frontend/bindings/pi-desk/internal/appservice/piextensionservice.ts`

| 方法 | 入参 | 返回 | Go 实现 |
|---|---|---|---|
| `InstallPackage` | request: domain.PiPackageRequest | domain.PiPackageCommandResult | `internal/appservice/extensionconfig.go:358` |
| `InstallPiDeskBrowser` | — | domain.PiDeskBrowserExtensionStatus | `internal/appservice/extensionconfig.go:287` |
| `InstallPiDeskComputerUse` | — | domain.PiDeskComputerUseExtensionStatus | `internal/appservice/extensionconfig.go:209` |
| `InstallPiDeskGoal` | — | domain.PiDeskGoalExtensionStatus | `internal/appservice/extensionconfig.go:170` |
| `InstallPiDeskSubagents` | — | domain.PiDeskSubagentsExtensionStatus | `internal/appservice/extensionconfig.go:248` |
| `InstallPiDeskTodo` | — | domain.PiDeskTodoInstallResult | `internal/appservice/extensionconfig.go:107` |
| `ListExtensions` | — | domain.PiExtensionSnapshot | `internal/appservice/extensionconfig.go:101` |
| `ListPackages` | request: domain.ListPiPackagesRequest | domain.PiPackageSnapshot | `internal/appservice/extensionconfig.go:326` |
| `RemovePackage` | request: domain.PiPackageRequest | domain.PiPackageCommandResult | `internal/appservice/extensionconfig.go:374` |
| `RemovePiDeskBrowser` | — | — | `internal/appservice/extensionconfig.go:311` |
| `RemovePiDeskComputerUse` | — | — | `internal/appservice/extensionconfig.go:233` |
| `RemovePiDeskGoal` | — | — | `internal/appservice/extensionconfig.go:194` |
| `RemovePiDeskSubagents` | — | — | `internal/appservice/extensionconfig.go:272` |
| `RemovePiDeskTodo` | — | — | `internal/appservice/extensionconfig.go:155` |
| `SetPackageEnabled` | request: domain.SetPiPackageEnabledRequest | — | `internal/appservice/extensionconfig.go:382` |
| `UpdatePackage` | request: domain.PiPackageRequest | domain.PiPackageCommandResult | `internal/appservice/extensionconfig.go:366` |

### PiMaintenanceService — 1 个方法

绑定：`frontend/bindings/pi-desk/internal/appservice/pimaintenanceservice.ts`

| 方法 | 入参 | 返回 | Go 实现 |
|---|---|---|---|
| `MaintainPi` | request: domain.PiMaintenanceRequest | domain.PiMaintenanceResult | `internal/appservice/pimaintenance.go:38` |

### PromptTemplateService — 4 个方法

绑定：`frontend/bindings/pi-desk/internal/appservice/prompttemplateservice.ts`

| 方法 | 入参 | 返回 | Go 实现 |
|---|---|---|---|
| `DeletePromptTemplate` | request: domain.PromptTemplateRequest | — | `internal/appservice/promptconfig.go:169` |
| `GetPromptTemplate` | request: domain.PromptTemplateRequest | domain.PromptTemplate | `internal/appservice/promptconfig.go:85` |
| `ListPromptTemplates` | request: domain.ListPromptTemplatesRequest | domain.PromptTemplateSnapshot | `internal/appservice/promptconfig.go:48` |
| `UpsertPromptTemplate` | request: domain.UpsertPromptTemplateRequest | domain.PromptTemplate | `internal/appservice/promptconfig.go:108` |

### RemoteWorkspaceService — 9 个方法

绑定：`frontend/bindings/pi-desk/internal/appservice/remoteworkspaceservice.ts`

| 方法 | 入参 | 返回 | Go 实现 |
|---|---|---|---|
| `ConnectRemoteTarget` | request: domain.ConnectRemoteTargetRequest | string | `internal/appservice/remoteworkspaceservice.go:75` |
| `DecideRemoteRoot` | request: domain.DecideRemoteRootRequest | domain.WorkspaceSummary | `internal/appservice/remoteworkspaceservice.go:134` |
| `DisconnectRemoteTarget` | request: domain.RemoteTargetRequest | — | `internal/appservice/remoteworkspaceservice.go:233` |
| `DiscoverRemoteTargets` | — | domain.RemoteAliasSummary[] | null | `internal/appservice/remoteworkspaceservice.go:45` |
| `ListRemoteTargets` | — | domain.RemoteTargetSummary[] | null | `internal/appservice/remoteworkspaceservice.go:61` |
| `OpenRemoteWorkspace` | request: domain.WorkspaceRequest | domain.WorkspaceSummary | `internal/appservice/remoteworkspaceservice.go:196` |
| `PrepareRemoteRoot` | request: domain.PrepareRemoteRootRequest | domain.RemoteRootCandidate | `internal/appservice/remoteworkspaceservice.go:104` |
| `RemoveRemoteTarget` | request: domain.RemoteTargetRequest | — | `internal/appservice/remoteworkspaceservice.go:222` |
| `ResumeRemoteWorkspace` | request: domain.ResumeRemoteWorkspaceRequest | domain.WorkspaceSummary | `internal/appservice/remoteworkspaceservice.go:160` |

### RepositoryService — 11 个方法

绑定：`frontend/bindings/pi-desk/internal/appservice/repositoryservice.ts`

| 方法 | 入参 | 返回 | Go 实现 |
|---|---|---|---|
| `Branches` | request: domain.RepositoryRequest | domain.GitBranchInventory | `internal/appservice/repository.go:197` |
| `ClipboardFiles` | request: domain.RepositoryRequest | domain.RepositoryFile[] | null | `internal/appservice/clipboard.go:17` |
| `Diff` | request: domain.RepositoryFileRequest | domain.RepositoryFileDiff | `internal/appservice/repository.go:164` |
| `OpenFile` | request: domain.RepositoryFileRequest | — | `internal/appservice/repository.go:269` |
| `OpenFileWith` | request: domain.RepositoryFileRequest | — | `internal/appservice/repository.go:280` |
| `PreviewFile` | request: domain.RepositoryFileRequest | domain.RepositoryFilePreview | `internal/appservice/repository.go:235` |
| `RevealFile` | request: domain.RepositoryFileRequest | — | `internal/appservice/repository.go:316` |
| `RollbackSessionFile` | request: domain.RollbackSessionFileRequest | — | `internal/appservice/repository.go:380` |
| `SaveFileAs` | request: domain.RepositorySaveFileRequest | — | `internal/appservice/repository.go:291` |
| `SessionFileChanges` | request: domain.SessionFileChangesRequest | domain.SessionFileChanges | `internal/appservice/repository.go:353` |
| `Snapshot` | request: domain.RepositoryRequest | domain.RepositorySnapshot | `internal/appservice/repository.go:111` |

### TerminalService — 5 个方法

绑定：`frontend/bindings/pi-desk/internal/appservice/terminalservice.ts`

| 方法 | 入参 | 返回 | Go 实现 |
|---|---|---|---|
| `Resize` | request: domain.TerminalResizeRequest | — | `internal/appservice/terminal.go:150` |
| `Snapshot` | request: domain.TerminalRequest | domain.TerminalState | `internal/appservice/terminal.go:114` |
| `Start` | request: domain.StartTerminalRequest | domain.TerminalState | `internal/appservice/terminal.go:90` |
| `Stop` | request: domain.TerminalRequest | — | `internal/appservice/terminal.go:158` |
| `Write` | request: domain.TerminalWriteRequest | — | `internal/appservice/terminal.go:136` |

<!-- TOTAL_METHODS=147 -->

## 3. 唯一的事件通道：`pi:event`

| 项 | 事实 | 证据 |
|---|---|---|
| 事件名 | 常量 `piEventName = "pi:event"`，全仓唯一 | `internal/appservice/agent.go:27` |
| 发射点 | `app.Event.Emit(piEventName, event)`（Supervisor 的 sink 里） | `internal/appservice/agent.go:105` |
| 前端订阅 | `Events.On("pi:event", …)`，返回解绑函数 | `frontend/src/services/agent.ts:152` |
| 载荷 | `{threadId, event:{generation, type, payload?, record?, error?}}` | `frontend/src/services/agent.ts:24` `:32` |
| 消费 | 单一入口 `store.handlePiEvent`（约 374 行逻辑） | `frontend/src/stores/app.ts:3408` |
| 其他事件 | 浏览器/终端各有自己的事件名，由 `publish`/`ServiceStartup` 发（`internal/appservice/browserservice.go:67`、`internal/appservice/terminal.go:55`） | — |

## 4. 出站到 Pi 的 26 个命令帧（`pi --mode rpc` 的入站面）

| 类别 | 命令 |
|---|---|
| 会话生命周期 | `prompt` `abort` `abort_bash` `abort_retry` `bash` `compact` `switch_session` |
| 读 | `get_state` `get_messages` `get_entries` `get_fork_messages` `get_session_stats` `get_commands` `get_available_models` `get_available_thinking_levels` |
| 写/图 | `set_model` `set_thinking_level` `set_session_name` `set_auto_retry` `set_auto_compaction` `set_steering_mode` `set_follow_up_mode` |
| 分支/导出 | `clone` `fork` `export_html` |
| 扩展回包 | `extension_ui_response` |

复算：

```bash
python3 - <<'PY'
import re,glob
lit=set()
for p in glob.glob('internal/appservice/*.go')+glob.glob('internal/piruntime/*.go'):
    if p.endswith('_test.go'): continue
    lit |= set(re.findall(r'"type":\s*"([a-z_]+)"', open(p).read()))
lit |= set(re.findall(r'setQueueMode\(request, "([a-z_]+)"\)', open('internal/appservice/agent.go').read()))
print(len(lit), ' '.join(sorted(lit)))
PY
```

⚠️ `set_steering_mode` / `set_follow_up_mode` 是用变量拼的（`internal/appservice/agent.go:382-395`），纯 grep `"type":` 会漏 —— 上面脚本已补。
⚠️ 这 26 个是 **Pi Desk 现在会发的**，不代表 Pi 支持的全部；断言「Pi 支持 X」必须打到帧级证据（`AGENTS.md` §6）。

## 5. remote-helper 协议（宿主 ↔ 远端）

| 项 | 值 | 证据 |
|---|---|---|
| 协议版本 | `Version = 1` | `internal/remoteprotocol/types.go:12` |
| 帧种类 `Kind` | `request` `response` `error` `event` `cancel` | `internal/remoteprotocol/types.go:32-36` |
| 方法名上限 | 128 字节（`maxMethodBytes`） | `internal/remoteprotocol/types.go:16` |
| 系统类 | `system.hello` `system.ping` `system.shutdown` | `internal/remotehelper/server.go:18-20` |
| 文件类 | `file.stat` `file.list` `file.read` `file.image` `file.hash` `file.content` `file.mkdir` `file.write` | `internal/remotehelper/files.go:19-24` `internal/remotehelper/mkdir.go:11` `internal/remotehelper/write.go:15` |
| 检索/版本 | `search.find` `search.grep` `git.read` | `internal/remotehelper/search.go:24` `internal/remotehelper/git.go:19` |
| 执行 | `bash.run` `terminal.run` | `internal/remotehelper/bash.go:18` `internal/remotehelper/terminal.go:18` |
| 根校验 | `root.open` | `internal/remotehelper/root.go:18` |
| 流式副帧 | `stream.credit` `stream.data` `process.accepted` `terminal.input` `terminal.resize` | `internal/remoteprotocol/stream.go:4-8` |
| 分发点 | `switch envelope.Method` | `internal/remotehelper/server.go:245` |

## 6. DTO：159 个导出类型（跨语言只有一层）

```bash
grep -c '^export ' frontend/bindings/pi-desk/internal/domain/models.ts   # 159
```

**两条透传约定，改接口前必须知道**：

1. `AgentService` 里 **31 个方法返回 `domain.CommandResult`**，其形状是 `{command, dataJson}`（`internal/domain/agent.go:24-27`）。真正的数据是**一个 JSON 字符串**，前端用 `JSON.parse` 解（`frontend/src/services/agent.ts:38-41`）。⇒ 加字段不用重生成绑定，但也**没有类型检查**。
2. 另有 **35 个方法返回 `void`**（写操作与生命周期），失败只靠 error 字符串。复算：`grep -h 'export function' frontend/bindings/pi-desk/internal/appservice/*.ts | grep -c 'CancellablePromise<void>'`

## 7. 内嵌给 Pi 的 6 个扩展（不是 RPC，但同属暴露面）

| 扩展 | 内嵌位置 | 注册/安装方法 |
|---|---|---|
| `pi-desk-todo.ts` | `internal/appservice/extensionconfig.go:37` | `InstallPiDeskTodo` `:107` / `RemovePiDeskTodo` `:155` |
| `pi-desk-goal.ts` | `internal/appservice/extensionconfig.go:40` | `:170` / `:194` |
| `pi-desk-computer-use.ts` | `internal/appservice/extensionconfig.go:43` | `:209` / `:233` |
| `pi-desk-subagents.ts` | `internal/appservice/extensionconfig.go:46` | `:248` / `:272` |
| `pi-desk-browser.ts` | `internal/appservice/extensionconfig.go:49` | `:287` / `:311` |
| `pi-desk-remote.ts` | `internal/appservice/remotebroker.go:38`（其 manifest 内嵌在 `internal/appservice/remoteadapter.go:22`） | 起远程会话时由 broker 注入，见 `docs/02-功能模块地图.md` §6 |

widget 回流通道是**文本协议**而非 RPC：宿主解析 Pi 输出的 `[x] #1: …` 行（`frontend/src/utils/todoWidget.ts:22`，上限 100 条 / 4096 字：`:2-3`），键名兼容 `pi-deck-todo` 拼写（`frontend/src/stores/app.ts:108`）。
