# SuperMatrix 骨架 PRD — 系统总览与核心概念

> 本文档是 SuperMatrix 反向工程 PRD 的上下文基线。所有子系统 PRD 必须与此保持一致。
> 版本: v1.0-draft
> 日期: 2026-05-20
> 源码锚定: 基于 SuperMatrix 主仓库 commit 范围 ce32f76 及之前

---

## 1. 系统定位与目标

**SuperMatrix** 是一个 AI Agent 编排框架，通过飞书（Feishu/Lark）作为用户界面，管理 Claude Code / Codex / Kimi 代理会话。

### 1.1 核心价值主张

- **会话即工作区**: 每个会话绑定独立的工作目录（git 仓库），Agent 在隔离环境中运行。
- **多后端统一**: 一套框架同时支持 Claude、Codex、Kimi 三种 backend，用户可在运行时切换。
- **子会话派生**: 支持 `/spawn` 命令创建 child session，实现跨会话任务委托与结果投递。
- **飞书原生**: 所有交互通过飞书群完成，无需额外前端。

### 1.2 用户画像

| 角色 | 使用方式 | 典型操作 |
|------|----------|----------|
| 平台运维者 | Root Group | `/new`, `/status`, `/delete`, `/selfcheck` |
| 业务使用者 | Session Group | 直接发消息给 Agent，使用 `/spawn` 委托任务 |
| 外部协作者 | 外部 Session Group | 被邀请进外部群，只能发消息、不能执行命令 |
| 调度器/Watchdog | HTTP API | `POST /api/spawn`, `POST /api/notify` |

---

## 2. 架构总览

### 2.1 六边形架构分层

```
┌─────────────────────────────────────────────┐
│                  CLI Layer                    │
│  main.ts → bootstrap.ts → apiServer.ts       │
│  (composition root, env parsing, startup)     │
├─────────────────────────────────────────────┤
│                   App Layer                   │
│  dispatcher.ts, sessionLifecycle.ts,         │
│  childSession.ts, replier.ts, commandRegistry│
│  (编排层，组合 domain + ports)                │
├─────────────────────────────────────────────┤
│                  Ports Layer                  │
│  AgentBackend, BindingStore, LarkGateway,    │
│  EventBus, TopicBus, WorkspaceFs, Logger...  │
│  (纯接口定义，零实现)                          │
├─────────────────────────────────────────────┤
│                Adapters Layer                 │
│  backend-claude, backend-codex, backend-kimi │
│  lark-cli, store-sqlite, workspace-node,     │
│  event-bus-memory, topic-bus-memory          │
│  (可替换的具体实现)                            │
├─────────────────────────────────────────────┤
│                 Domain Layer                  │
│  session.ts, ids.ts, errors.ts, events/      │
│  attachment.ts, childCapabilities.ts         │
│  (纯业务逻辑，零外部依赖)                      │
└─────────────────────────────────────────────┘
```

**依赖方向规则**: [源码锚点] `scripts/check-deps.ts:7-14`
```
domain → domain
ports   → ports, domain
adapters → adapters, ports, domain
app     → app, ports, domain
cli     → cli, app, adapters, ports, domain
```

违反者被 `npm run lint:deps` 拦截。当前代码零违规。

### 2.2 运行时拓扑

```
飞书 Root Group  ──→  LarkCliGateway  ──→  Dispatcher
    (oc_xxx)            (WebSocket)          (命令路由 / 消息分发)
                                              │
                        ┌─────────────────────┼─────────────────────┐
                        ↓                     ↓                     ↓
                  SessionLifecycle      ProcessLifecycle       ChildSessionService
                  (create/delete/        (graceful stop/        (spawnChild/
                   reset/restart)         reload/restart)        resumeChild)
                        │                     │                     │
                        ↓                     ↓                     ↓
                  SqliteBindingStore     KimiBackend/          BackendRegistry
                  (SQLite + migrations)  ClaudeBackend/        (get / cancel)
                                       CodexBackend
                                              │
                        ┌─────────────────────┼─────────────────────┐
                        ↓                     ↓                     ↓
                  NodeWorkspaceFs      InMemoryEventBus      InMemoryTopicBus
                  (git init/scaffold)  (session events)      (topic pub/sub)
```

[源码锚点] `src/cli/bootstrap.ts:224-897`（完整 wiring 逻辑）

### 2.3 数据持久化模型

SQLite 数据库 (`SM_DB_PATH`) 包含以下核心表：

| 表 | 职责 | 关键约束 |
|----|------|----------|
| `sessions` | 会话元数据、状态、backend、workdir | `name` UNIQUE, `status` TEXT |
| `bindings` | session ↔ 飞书群绑定 | `group_id` PK, `session_id` UNIQUE |
| `message_runs` | 单次 prompt 执行记录 | `session_id`, `status`, `stream_log` |
| `attachments` | 附件持久化 | `session_id`, `local_path` |
| `cross_session_log` | 跨会话通信（spawn 结果） | `from_session_id`, `to_session_id` |
| `token_usage` | Token 消耗统计 | `session_id`, `message_run_id`, `backend` |
| `spawn_predicate_patches` | Spawn 验证断言历史 | `spawn_comm_id`, `version` |
| `spawn_async_items` | 异步 spawn 闭包状态 | `comm_id`, `status`, `route` |
| `watcher_exceptions` | Watcher 异常记录 | `spawn_comm_id`, `trigger_signal` |
| `schema_version` | Migration 版本追踪 | `version` PK |

[源码锚点] `migrations/001_initial.sql` 及后续 `002`~`028`

---

## 3. 核心概念表

### 3.1 会话（Session）

**定义**: SuperMatrix 管理的基本工作单元，对应一个飞书群、一个工作目录、一个 AI backend 进程上下文。

**核心属性**: [源码锚点] `src/domain/session.ts:40-73`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | SessionId | `sess_` + 8 位 hex |
| `name` | string | 唯一标识，正则 `^[a-z0-9][a-z0-9_-]{0,39}$` |
| `alias` | string | 显示别名，可重复 |
| `scope` | `"root" \| "user" \| "child"` | root=控制台群, user=用户群, child=派生子会话 |
| `backend` | `"claude" \| "codex" \| "kimi"` | AI backend 类型 |
| `status` | SessionStatus | 见 3.2 状态机 |
| `workdir` | AbsolutePath | 工作目录绝对路径 |
| `backendSessionId` | string \| null | backend 层会话 ID（Claude rollout / Codex thread / Kimi ACP session） |
| `parentId` | SessionId \| null | 父会话 ID（child session 用） |
| `depth` | number | 派生深度（root=0, child=parent.depth+1） |
| `category` | SessionCategory | `"" \| "业务" \| "平台" \| "工具" \| "知识" \| "外部"` |
| `fpManaged` | boolean \| null | FP 管辖标记（来自飞书 Bitable） |
| `childType` | ChildSessionType \| null | `one_shot_delegation` / `ephemeral_conversation` / `event_awaited_worker` |

**命名规则**: [源码锚点] `src/app/sessionLifecycle.ts:52`
```
NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/u
```

### 3.2 会话状态机

```
                    ┌─────────────┐
                    │ initializing│
                    └──────┬──────┘
                           │ create success
                           ↓
    ┌───────────────┐    idle      ┌───────────────┐
    │  /cancel /    │◄────────────►│   /restart    │
    │ backend error │              │   /reset      │
    ↓               │              ↓               │
   busy ◄───────────┘            error ◄──────────┘
    │   prompt arrives              │
    │   run finished                │
    └──► idle                       └──► idle (after /restart /reset)

    child session 特有路径:
    busy ──► deleted (one_shot_delegation 正常结束)
    busy ──► waiting ──► deleted (event_awaited_worker 等待 topic)
    busy ──► waiting ──► error (event_awaited_worker 超时)
```

[源码锚点] `src/domain/session.ts:12-18`（状态定义）

**状态转换规则**:
- `initializing` → `idle`: sessionLifecycle.create() 成功 [源码锚点] `src/app/sessionLifecycle.ts:270`
- `idle` → `busy`: dispatcher 收到 prompt，开始 backend run [源码锚点] `src/app/dispatcher.ts:576-592`
- `busy` → `idle`: run 成功完成 [源码锚点] `src/app/dispatcher.ts:699-710`
- `busy` → `error`: run 抛出异常 [源码锚点] `src/app/dispatcher.ts:720-729`
- `error` → `idle`: `/restart` 或 `/reset` [源码锚点] `src/app/sessionLifecycle.ts:339-355`
- child `busy` → `deleted`: run 结束且 childType ≠ ephemeral_conversation [源码锚点] `src/app/childSession.ts:113-115`
- child `busy` → `waiting`: event_awaited_worker 第一 run 完成，等待 topic [源码锚点] `src/app/childSession.ts:594`

### 3.3 Backend 抽象

**AgentBackend 接口**: [源码锚点] `src/ports/AgentBackend.ts:22-26`

```typescript
export type AgentBackend = {
  readonly kind: BackendKind;
  run(input: RunInput): AsyncIterable<AgentEvent>;
  cancel(sessionId: SessionId): Promise<void>;
};
```

**RunInput**: [源码锚点] `src/ports/AgentBackend.ts:13-20`
```typescript
export type RunInput = {
  session: Session;
  prompt: string;
  attachments?: AttachmentRef[];
  systemHint?: string;
  answerOnly?: boolean;
};
```

**三后端差异**:

| 维度 | Claude | Codex | Kimi |
|------|--------|-------|------|
| 进程模型 | 每 turn 独立子进程 | 每 turn 独立子进程 | 单 ACP 进程，session 多路复用 |
| 会话恢复 | `--resume` + backendSessionId | `--resume` + threadId | `loadSession()` + ACP sessionId |
| 超时控制 | inactivity + maxRuntime | inactivity + maxRuntime | maxRuntime（2026-05-20 修复后） |
| Token usage | 实时 stream | 累积式，需 normalize | ACP 不承载 usage |
| 附件支持 | `--file` 路径 | `--file` 路径 | content blocks（2026-05-20 修复后） |

### 3.4 消息流（Message Run）

**定义**: 一次用户 prompt 从发起到完成的完整执行周期。

**生命周期**: [源码锚点] `src/app/dispatcher.ts:574-740`

1. **准入检查**: session 存在、非 busy、非 error、非 deleted
2. **附件获取**: 下载飞书附件到本地，记录到 DB
3. **状态翻转**: `idle` → `busy`，持久化 message_run 行
4. **Backend 执行**: `backend.run()` 返回 AsyncIterable<AgentEvent>
5. **流消费**: replier.consume() 逐事件更新飞书卡片
6. **结果持久化**: finishMessageRun() 记录 finalMessage / error / streamLog
7. **状态恢复**: `busy` → `idle`，触发 drainPendingNext

**RunStatus 分类**: [源码锚点] `src/app/runStatus.ts`
- `completed` — 正常完成
- `failed` — 执行失败
- `timeout` — 超时
- `cancelled` — 用户取消
- `stuck` — 被 watchdog 标记为卡住

### 3.5 子会话（Child Session）

**定义**: 由父会话通过 `/spawn` 或 `/api/spawn` 派生的临时会话，用于异步任务委托。

**三种类型**: [源码锚点] `src/domain/childCapabilities.ts`

| 类型 | 生命周期 | 结果投递 | 典型场景 |
|------|----------|----------|----------|
| `one_shot_delegation` | 一次 run 后删除 | resultSink | "帮我 review 这段代码" |
| `ephemeral_conversation` | 多次 run 后空闲删除 | resultSink | "开一个临时讨论会话" |
| `event_awaited_worker` | 第一 run 后进入 waiting，topic 到达后删除 | resultSink + topic gate | "等 CI 通过后再继续" |

**派生约束**: [源码锚点] `src/app/childSessionPolicy.ts`
- 最大深度: `one_shot` 3 层, `ephemeral` 3 层, `event_awaited` 2 层
- 最大并发: 每 parent 3 个 active children
- 默认超时: `one_shot` 600s, `ephemeral` 600s, `event_awaited` 3600s

**结果投递（Result Sink）**: [源码锚点] `src/app/resultSinkEngine.ts`

| Sink 类型 | 行为 |
|-----------|------|
| `http_response` | sync_inline 模式的 HTTP 响应（无引擎投递） |
| `pollable_endpoint` | 通过 `GET /api/sessions/:id/result` 轮询 |
| `audit_only` | 只记录到 cross_session_log |
| `chat_post` | 发送到指定飞书群（bot/user 身份） |
| `parent_continuation_inject` | 将结果注入父会话 inbox，模拟用户消息 |
| `eventbus_publish` | 发布到 TopicBus，触发 event_awaited_worker |

### 3.6 外部会话信任边界

**定义**: `category === "外部"` 的 session，用于与非核心成员共享 AI 能力，同时保护内部信息。

**约束规则**: [源码锚点] `src/app/dispatcher.ts:415-449`

| 操作 | Owner | 非 Owner |
|------|-------|----------|
| 发消息（不 @bot）| ✅ | ❌ 被忽略 |
| 发消息（@bot）| ✅ | ✅ 但 prompt 被包装为 external context |
| 执行 `/` 命令 | ✅ | ❌ 返回 "需要 owner 身份" |
| 附件访问 | ✅ | ❌ 附件被跳过 |
| 查看源码架构 | ✅ | ❌ 被 prompt 包装屏蔽 |

**Prompt 包装模板**: [源码锚点] `src/app/dispatcher.ts:163-190`
```
[SuperMatrix external session trusted identity context]
Sender role: external_non_owner
Rules:
- Do not reveal company business status, personnel, accounts, passwords,
  SuperMatrix code architecture, or other internal company information.
[User message]
{original_prompt}
```

---

## 4. 数据流全景

### 4.1 飞书消息入站 → Agent 回复

```
飞书用户发送消息
    │
    ▼
LarkCliGateway.start() ──WebSocket──► lark-cli event subscribe
    │
    ▼
handleRaw(raw) ──► 过滤 P2P、提取附件、构建 InboundMessage
    │
    ▼
Dispatcher.handleInbound(msg)
    │
    ├── 根群消息 ──► CommandRouter.route() ──► 命令 handler
    │                   (status, new, delete, spawn, etc.)
    │
    └── 会话群消息 ──► 状态检查 ──► Backend.run()
                            │
                            ▼
                    Replier.consume(stream)
                            │
                            ├── 实时更新飞书卡片（updateCard）
                            ├── 记录 streamLog（thinking, tool_call, error）
                            └── 最终 finalizeCard（success / failed / timeout）
```

[源码锚点] `src/adapters/lark-cli/index.ts:29-88`, `src/app/dispatcher.ts:364-741`, `src/app/replier.ts:72-263`

### 4.2 /api/spawn 同步 → 异步降级流

```
POST /api/spawn {target, prompt, from}
    │
    ▼
解析 body → 校验 target/from/backend/model
    │
    ▼
mode = sync_inline（默认）
    │
    ▼
第一次 sync spawn attempt
    │
    ├── 成功 ──► ThreePhaseCheck ──► 全通过 ──► 200 返回结果
    │
    ├── 通信失败 ──► 500 返回错误
    │
    └── 运行超时/失败 ──► 自动降级为 async
            │
            ▼
    重试一次 sync spawn attempt
            │
            ├── 成功 ──► 200
            │
            └── 仍失败 ──► 彻底降级为 async
                    │
                    ▼
            返回 202 {childSessionId, messageRunId}
            后台继续执行，结果通过 resultSink 投递
```

[源码锚点] `src/cli/apiServer.ts:492-637`

**ThreePhaseCheck 检查项**: [源码锚点] `src/app/spawnClosure/threePhaseCheck.ts`
1. **admission**: child session 是否成功创建？
2. **communication**: cross_session_comm 是否成功记录？
3. **delivery**: result sink 是否成功投递？

### 4.3 启动自检（Boot Self-Check）

```
bootstrap()
    │
    ├── Pre-wiring checks ──► 失败则 process.exit(1)
    │   ├── localDepsCheck      (lark-cli, db 目录, kimi binary)
    │   ├── dualInstanceCheck   (PID 文件锁)
    │   ├── supervisorPresenceCheck (launchd / PM2 检测)
    │   ├── schedulerHealthCheck (localhost:3500 /tasks)
    │   ├── codexDefaultModelCheck
    │   └── kimiAcpHealthCheck  (kimi info)
    │
    ├── 构造 Store + 执行 Migration
    │
    ├── Post-wiring checks ──► 失败则 process.exit(1)
    │   └── reconcileBackendProcessesCheck
    │       (DB busy sessions ↔ 实际 OS processes 对齐)
    │
    └── 清理 stale child sessions
        ├── cleanupStaleChildSessions (idle > 60min)
        ├── cleanupErroredChildSessions (error > 5min)
        └── cleanupStuckBusyChildren (busy > 5min, child only)
```

[源码锚点] `src/cli/bootstrap.ts:233-337`

---

## 5. 部署模型

### 5.1 运行时依赖

| 依赖 | 版本/要求 | 说明 |
|------|----------|------|
| Node.js | >= 22.0.0 | `node -v` 检查 |
| npm | 随 Node | |
| Claude Code CLI | 最新 | `npm install -g @anthropic-ai/claude-code` |
| Kimi CLI | >= 1.37.0 | `kimi` 在 PATH 或 `SM_KIMI_CLI_PATH` |
| lark-cli | 随 npm install | `@larksuite/cli` |
| macOS | 推荐 | LaunchAgent 仅支持 macOS |
| SQLite | 3.x | `better-sqlite3` 自带 |

### 5.2 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SM_ROOT_GROUP_ID` | 是 | — | 控制台群 chat_id (`oc_xxx`) |
| `SM_ROOT_USER_ID` | 是 | — | 管理员 open_id (`ou_xxx`) |
| `SM_WORKSPACE_ROOT` | 是 | — | 工作空间根目录 |
| `SM_DB_PATH` | 是 | — | SQLite 数据库路径 |
| `SM_BACKEND` | 是 | `claude` | 默认 backend |
| `SM_LOG_LEVEL` | 否 | `info` | debug/info/warn/error |
| `LARK_APP_ID` | 是 | — | 飞书应用 App ID (`cli_xxx`) |
| `SM_LARK_CLI_PATH` | 否 | `node_modules/.bin/lark-cli` | lark-cli 路径 |
| `SM_API_PORT` | 否 | `3501` | HTTP API 端口 |
| `SM_KIMI_CLI_PATH` | 否 | `kimi` | kimi binary 路径 |
| `ANTHROPIC_API_KEY` | 否 | — | Claude API Key（替代 OAuth）|

### 5.3 进程拓扑

```
┌────────────────────────────────────────────┐
│  launchd / PM2 / terminal                  │
│  └─► tsx src/cli/main.ts                   │
│      ├─► Lark event subscriber (WebSocket) │
│      ├─► HTTP API server (localhost:3501)  │
│      ├─► child process monitor (interval)  │
│      └─► source file watcher (fs.watch)    │
│                                              │
│  按需 spawn（per-turn）:                     │
│  ├─► claude -p ...（ClaudeBackend）         │
│  ├─► codex ...（CodexBackend）              │
│  └─► kimi acp（KimiBackend，单进程复用）     │
└────────────────────────────────────────────┘
```

### 5.4 文件系统布局

```
SM_WORKSPACE_ROOT/
├── session-catalog.json          # 全局会话目录（所有 workspace symlink）
├── first-principle/              # Principles 模板
│   ├── templates/
│   │   ├── console-principles.md
│   │   ├── coding-principles.md
│   │   ├── business-principles.md
│   │   ├── claude-md-base.md
│   │   ├── agents-md-base.md
│   │   └── sop-template.md
│   └── scripts/
│       └── sync-session-table.sh
├── {session-name}/               # 单个 session 工作区
│   ├── .git/
│   ├── .gitignore
│   ├── session-catalog.json -> ../session-catalog.json
│   ├── console-principles.md -> ../first-principle/templates/...
│   ├── coding-principles.md -> ...
│   ├── business-principles.md -> ...
│   ├── CLAUDE.md                 # 从模板渲染
│   ├── AGENTS.md                 # 从模板渲染
│   └── sop/
│       ├── INDEX.md
│       └── TEMPLATE.md -> ../first-principle/templates/sop-template.md
└── .attachments/{group_id}/{YYYY-MM-DD}/
    └── {messageId}_{safe_filename}
```

[源码锚点] `src/app/sessionLifecycle.ts:89-294`（create 逻辑）

---

## 6. 术语表 v1

| 术语 | 英文 | 定义 | 源码位置 |
|------|------|------|----------|
| 会话 | Session | SuperMatrix 管理的基本工作单元，绑定飞书群+工作目录+backend | `src/domain/session.ts` |
| 根群 | Root Group | 控制台群，所有管理命令在此发送 | `SM_ROOT_GROUP_ID` |
| 用户群 | User Group | 普通会话群，直接与 Agent 交互 | `scope = "user"` |
| 子会话 | Child Session | 由父会话派生的临时会话，用于异步委托 | `scope = "child"` |
| Backend | Backend | AI 后端实现（Claude/Codex/Kimi） | `src/ports/AgentBackend.ts` |
| Message Run | Message Run | 单次 prompt 的完整执行周期 | `src/ports/BindingStore.ts` |
| 派生 | Spawn | 创建 child session 并委托任务 | `/spawn`, `/api/spawn` |
| 结果投递 | Result Sink | child session 完成后向何处投递结果 | `src/domain/childCapabilities.ts` |
| 验证断言 | Spawn Predicate | 验证 child 结果是否满足预期的断言 | `src/app/spawnPredicate/schema.ts` |
| 闭包 | Spawn Closure | 异步 spawn 的全生命周期追踪（admission → delivery → close） | `src/app/spawnClosure/` |
| 飞书卡片 | Lark Card | 飞书 interactive message，用于显示运行状态 | `src/ports/LarkGateway.ts` |
| 外部会话 | External Session | category="外部"，有严格信任边界 | `src/app/dispatcher.ts:415-449` |
| ACP | Agent Client Protocol | Zed Industries 的 AI 代理通信协议 | `@zed-industries/agent-client-protocol` |
| 六边形架构 | Hexagonal Architecture | domain → ports → adapters → app → cli 分层 | `scripts/check-deps.ts` |
| 自检查 | Boot Self-Check | 启动时的健康检查（pre/post wiring） | `src/app/bootSelfCheck/` |

---

## 7. 版本与变更追溯

| 版本 | 日期 | 变更 | 作者 |
|------|------|------|------|
| v1.0-draft | 2026-05-20 | 骨架 PRD 初稿，基于代码反向工程 | supermatrix-root |

---

## 8. 待补充清单（给阶段 1 subagent 的输入）

以下细节将在子系统 PRD 中深度展开，本骨架文档仅提供上下文：

- [ ] Domain: `childCapabilities.ts` 完整字段语义与校验规则
- [ ] Domain: `attachmentResolver.ts` 附件选择逻辑（当前 vs 历史）
- [ ] App: `spawnClosure` 完整状态机（pending → adjudicating → re_driving → closed）
- [ ] App: `spawnPredicate` 所有 evaluator 类型（httpGet, fileMtime, inboxMessage 等）
- [ ] App: `continuationDispatcher` 注入逻辑与重试策略
- [ ] Adapters: `backend-claude` stream parser 的 JSON-RPC 碎片处理
- [ ] Adapters: `backend-codex` token usage normalize 逻辑
- [ ] Adapters: `store-sqlite` 所有方法的 SQL 语句与参数映射
- [ ] CLI: `apiServer.ts` 所有路由的输入输出契约（/api/spawn, /api/run, /api/notify, /api/health, PATCH predicate）
- [ ] Scripts: `spawn-closure-watcher.sh` 与 `watcher-tick.sh` 的协同模型
- [ ] Ops: LaunchAgent plist 配置与 macOS Keychain OAuth 问题
