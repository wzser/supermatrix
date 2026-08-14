# CLI & API 深度 PRD

> 本文档深度解析 SuperMatrix 的 CLI 启动层与 HTTP API 层。
> 源码锚定范围：`src/cli/*.ts`、`src/app/runOnSession.ts`、`src/app/consoleNotifier.ts`、`tests/cli/*.ts`。
> 版本：v1.0，与 `00-skeleton.md` 术语表一致。

---

## 1. 启动流程（Bootstrap）

### 1.1 整体时序

`main.ts` 是单一入口，调用 `bootstrap(env)` 获取 `App` 对象，再调用 `app.start()` 启动全量服务 [源码锚点] `src/cli/main.ts:36-38`。`bootstrap.ts` 是 composition root，负责从环境变量构造配置、执行自检、实例化全部 adapter 与 app 层服务、组装依赖图，最后返回 `{ lifecycle, start, stop }` [源码锚点] `src/cli/bootstrap.ts:224-897`。

启动分为五个严格顺序的阶段：

```
validateEnv(env) ──► pre-wiring checks ──► Store + Migration ──► post-wiring checks
       │                    │                      │                    │
       ▼                    ▼                      ▼                    ▼
   zod schema        6 项廉价探针         resetBusySessions      reconcileBackendProcesses
   失败 → throw      任一 fail → exit(1)   失败回退粗暴清理       失败 → exit(1)
```

### 1.2 validateEnv 的 Schema

环境校验使用 zod 严格 schema [源码锚点] `src/cli/bootstrap.ts:183-194`：

```typescript
const envSchema = z.object({
  SM_ROOT_GROUP_ID: z.string().min(1),
  SM_ROOT_USER_ID: z.string().min(1),
  SM_WORKSPACE_ROOT: z.string().min(1),
  SM_DB_PATH: z.string().min(1),
  SM_BACKEND: z.enum(["claude", "codex", "kimi"]).default("claude"),
  SM_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LARK_APP_ID: z.string().min(1),
  SM_LARK_CLI_PATH: z.string().optional(),
  SM_API_PORT: z.coerce.number().int().default(3501),
  SM_SHUTDOWN_GRACE_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
});
```

解析成功后映射到 `AppConfig` 类型 [源码锚点] `src/cli/bootstrap.ts:81-92`。其中 `larkCliPath` 存在 fallback 逻辑：若环境变量未提供，默认使用 `path.resolve("node_modules/.bin/lark-cli")` [源码锚点] `src/cli/bootstrap.ts:218`。

### 1.3 Pre-wiring Checks 列表

pre-wiring 阶段在构造 Store 之前执行，所有检查都是廉价探针，失败即 `process.exit(1)`，避免带伤启动 [源码锚点] `src/cli/bootstrap.ts:233-264`。共有 6 项检查，按顺序短路执行（遇到第一个 fail 即停止） [源码锚点] `src/app/bootSelfCheck/index.ts:18-23`：

| 序号 | 检查名 | 源码位置 | 行为 | 失败后果 |
|------|--------|----------|------|----------|
| 1 | `localDepsCheck` | `src/app/bootSelfCheck/checks/localDeps.ts:11` | 探测 lark-cli 可执行性（含 PATH fallback 自动修复）、DB 目录可写、workspace 根目录可写 | `fail` |
| 2 | `dualInstanceCheck` | `src/app/bootSelfCheck/checks/dualInstance.ts:7` | PID 文件锁 + ps 扫描，防止双实例运行 | `fail` |
| 3 | `supervisorPresenceCheck` | `src/app/bootSelfCheck/checks/supervisorPresence.ts:8` | 沿 PPID 链向上扫描 5 层，确认存在 dev-loop/localwatch/PM2 之一 | `warn`（不短路） |
| 4 | `schedulerHealthCheck` | `src/app/bootSelfCheck/checks/schedulerHealth.ts:3` | 探测 `SM_SCHEDULER_HEALTH_URL`，2 秒超时 | `warn`（不短路） |
| 5 | `codexDefaultModelCheck` | `src/app/bootSelfCheck/checks/codexDefaultModel.ts:30` | 解析 codex 可用模型列表，缓存到全局 catalog；处理 `SM_CODEX_DEFAULT_MODEL` | `warn`（检测失败时） |
| 6 | `kimiAcpHealthCheck` | `src/app/bootSelfCheck/checks/kimiAcpHealth.ts:11` | 执行 `kimi info`，验证 CLI 可用 | `warn`（不影响其他 backend） |

注意：`localDepsCheck` 具有**自动修复**能力——当主路径 lark-cli 不可用时，自动回退到 PATH 查找，并将 `ctx.cfg.larkCliPath` 原地替换 [源码锚点] `src/app/bootSelfCheck/checks/localDeps.ts:22-24`。`supervisorPresenceCheck` 和 `schedulerHealthCheck` 在 `runChecks` 中返回 `warn` 不会触发 `hasFail` 短路，但 `localDepsCheck` 返回 `fail` 会立即终止 [源码锚点] `src/app/bootSelfCheck/index.ts:27-29`。

### 1.4 Post-wiring Reconcile

Store 初始化并执行 migration 后，进入 post-wiring 阶段 [源码锚点] `src/cli/bootstrap.ts:287-314`。当前仅包含一项检查：

- **`reconcileBackendProcessesCheck`** [源码锚点] `src/app/bootSelfCheck/checks/reconcileBackendProcesses.ts:7`：
  - 扫描 `ppid=1` 且命令行匹配 `claude|codex|kimi` 的孤儿进程
  - 区分 Kimi ACP：当前存活的 `kimi acp` 进程（由 `getKimiAcpPid()` 提供）不被视为孤儿
  - 对 DB 中所有 `status=running` 的 message_run：
    - 若 session backend 为 kimi 且存在 live ACP pid → 保留 run，恢复 session 为 busy
    - 其余全部标记为 `timeout`，理由为 `"boot reconcile: backend orphaned by console restart"`
  - 杀死所有非 live 的孤儿进程 PID
  - 若 reconciler 自身抛出异常，则回退到 `resetRunningMessageRunsOnBoot`（粗暴清理），并在启动播报中显示 `warn` [源码锚点] `src/cli/bootstrap.ts:295-310`

### 1.5 依赖注入顺序

在 pre/post wiring 均通过后，`bootstrap.ts` 按以下顺序构造对象图 [源码锚点] `src/cli/bootstrap.ts:339-724`：

1. **Filesystem**: `NodeWorkspaceFs`
2. **Clock**: 纯函数 `{ now: () => asTimestamp(Date.now()) }`
3. **Lark Gateway**: `createRealLarkClient` → `LarkCliGateway`
4. **Event Bus**: `InMemoryEventBus` + `InMemoryTopicBus`
5. **Backends**: `ClaudeBackend`, `CodexBackend`, `KimiBackend`（kimi 提前实例化用于 reconcile）
6. **BackendRegistry**: 统一注册表，cancel 时遍历所有 backend
7. **SessionLifecycle**: 依赖 store/fs/lark/clock/eventBus
8. **ContinuationDispatcher**: 采用 late-binding 打破循环依赖——持有对 `dispatcher` 的引用，在 `dispatcher` 构造完成后才真正可用 [源码锚点] `src/cli/bootstrap.ts:419-436`
9. **ChildSessionService**: 依赖 store/backendRegistry/clock/eventBus/topicBus，注入 `deliverResultSinks`
10. **ConsoleNotifier**: 硬绑定到 root group，通过 lark-cli shell-out 发送卡片/文本
11. **Replier**: 依赖 lark/clock
12. **CommandRegistry**: 所有命令 handler 在此注册
13. **ProcessLifecycle**: 管理 in-flight 计数与优雅重启
14. **Dispatcher**: 依赖 store/lark/router/backend/childSession/replier/eventBus/lifecycle
15. **API Server**: `startApiServer(deps, cfg.apiPort)`，在 `start()` 内绑定端口
16. **SourceWatcher**: `startSourceWatcher`，监听 `src/` 目录 `.ts` 文件变更

> **关键设计**: `continuationDispatcher` 与 `dispatcher` 存在循环依赖。`continuationDispatcher` 的 `handleInbound` 先检查 `dispatcher` 是否已赋值，未赋值时抛出 `DispatcherNotReadyError`，由上游 adjudication 路径处理重试 [源码锚点] `src/cli/bootstrap.ts:425-431`。

---

## 2. 环境配置

以下为 `validateEnv` 解析的全部环境变量清单，按必填/可选分组。

### 2.1 必填变量

| 变量 | 类型 | 校验规则 | 说明 |
|------|------|----------|------|
| `SM_ROOT_GROUP_ID` | `string` | `min(1)` | 控制台群 chat_id（`oc_xxx`） |
| `SM_ROOT_USER_ID` | `string` | `min(1)` | 管理员 open_id（`ou_xxx`） |
| `SM_WORKSPACE_ROOT` | `string` | `min(1)` | 工作空间根目录绝对路径 |
| `SM_DB_PATH` | `string` | `min(1)` | SQLite 数据库文件路径 |
| `LARK_APP_ID` | `string` | `min(1)` | 飞书应用 App ID（`cli_xxx`） |

### 2.2 可选变量

| 变量 | 类型 | 默认值 | 校验规则 | 说明 |
|------|------|--------|----------|------|
| `SM_BACKEND` | `"claude" \| "codex" \| "kimi"` | `"claude"` | `enum` | 默认 backend |
| `SM_LOG_LEVEL` | `"debug" \| "info" \| "warn" \| "error"` | `"info"` | `enum` | 日志级别 |
| `SM_LARK_CLI_PATH` | `string` | `"node_modules/.bin/lark-cli"` | `optional()` | lark-cli 路径；boot 时支持 PATH fallback |
| `SM_API_PORT` | `number` | `3501` | `coerce.number().int()` | HTTP API 端口 |
| `SM_SHUTDOWN_GRACE_TIMEOUT_MS` | `number` | `20000` | `coerce.number().int().positive()` | 优雅关闭总超时 |
| `SM_KIMI_CLI_PATH` | `string` | `"kimi"` | 运行时读取 | Kimi CLI 路径 [源码锚点] `src/cli/bootstrap.ts:245` |
| `SM_HEARTBEAT_CONTROL_PATH` | `string` | 自动推导 | 运行时读取 | 心跳控制脚本路径 [源码锚点] `src/cli/bootstrap.ts:541-543` |
| `SM_SCHEDULER_BASE_URL` | `string` | `"http://127.0.0.1:3500"` | 运行时读取 | scheduler 基础 URL |
| `SM_SCHEDULER_HEALTH_URL` | `string` | 从 BASE_URL 推导 | 运行时读取 | scheduler 健康检查 URL |
| `SM_CODEX_DEFAULT_MODEL` | `string` | 自动检测 | 运行时读取 | Codex 默认模型覆盖 |
| `SM_PREDICATE_PATCH_TOKEN` | `string` | `null` | 运行时读取 | PATCH predicate 的 Bearer Token |

### 2.3 未暴露给 validateEnv 的运行时变量

以下变量在 `bootstrap.ts` 或 `apiServer.ts` 中直接读取 `process.env`，不经过 `envSchema`：

- `SM_KIMI_CLI_PATH`：kimi ACP 健康探针使用 [源码锚点] `src/cli/bootstrap.ts:245`
- `SM_HEARTBEAT_CONTROL_PATH`：heartbeat 命令使用 [源码锚点] `src/cli/bootstrap.ts:541-543`
- `SM_SCHEDULER_BASE_URL` / `SM_SCHEDULER_HEALTH_URL`：scheduler 查询使用 [源码锚点] `src/cli/bootstrap.ts:944-956`
- `SM_PREDICATE_PATCH_TOKEN`：predicate PATCH 授权使用 [源码锚点] `src/cli/apiServer.ts:1539-1556`
- `LARK_CLI_NO_PROXY`：内部设为 `"1"`，避免代理问题 [源码锚点] `src/cli/bootstrap.ts:472`
- `SM_RUNTIME_ROOT`：heartbeat 子进程环境变量 [源码锚点] `src/cli/bootstrap.ts:566`

---

## 3. API 路由总览

API Server 监听 `127.0.0.1:{SM_API_PORT}`（默认 3501），仅接受 loopback 连接 [源码锚点] `src/cli/apiServer.ts:979`。所有路由共享同一 `try/catch` 外层防护，未捕获异常返回 500 [源码锚点] `src/cli/apiServer.ts:957-962`。

端口绑定支持 3 次 EADDRINUSE 重试，间隔 300ms [源码锚点] `src/cli/apiServer.ts:180-181,965-994`。

| METHOD | PATH | 授权 | 说明 |
|--------|------|------|------|
| GET | `/api/health` | 无 | 健康检查 |
| GET | `/api/sessions/:id/result` | 无 | 轮询 child session 执行结果 |
| POST | `/api/spawn` | 无（loopback 信任） | 创建 child session 并委托任务 |
| POST | `/api/run` | 无（loopback 信任） | 在现有 user session 上执行 prompt |
| POST | `/api/notify` | 无（loopback 信任） | 向 root group 发送通知卡片 |
| PATCH | `/api/spawn/:spawn_comm_id/predicate` | Bearer Token | 修改 spawn 验证断言 |

> **授权模型说明**: `/api/spawn`、 `/api/run`、 `/api/notify` 均为 loopback-only，无 HTTP 层鉴权，依赖网络隔离（仅 `127.0.0.1`）与 caller `from` 字段的 session 存在性校验。`PATCH /api/spawn/:comm/predicate` 需要 `SM_PREDICATE_PATCH_TOKEN` 作为 Bearer Token [源码锚点] `src/cli/apiServer.ts:687-698`。

---

## 4. POST /api/spawn：同步 → 异步降级完整流程

### 4.1 请求契约

```typescript
// 输入（ ParsedSpawnBody ）
{
  target: string;          // 目标 session name（必填）
  prompt: string;          // 委托 prompt（必填）
  from: string;            // 调用者 session name（必填）
  backend?: "claude" | "codex"; // 覆盖 backend，默认继承 target
  model?: string | "default";   // 覆盖模型，"default"=清除继承
  supermatrix_internal?: { caller_invocation: "async_kickoff" | "fire_and_forget" }; // 仅内部调用者
  delivery_address?: DeliveryAddress; // 投递地址（与 sinks 互斥）
  sinks?: CallerSink[];    // 结果 sinks（仅 async 模式）
  verification_predicate?: unknown; // 验证断言
  client_request_id?: string;
}

// delivery_address 的 zod schema
deliveryAddressSchema = discriminatedUnion("kind", [
  z.object({ kind: z.literal("caller") }),
  z.object({ kind: z.literal("chat"), chatId: string, identity: z.enum(["bot","user"]).default("bot") }),
  z.object({ kind: z.literal("session"), sessionName: string }),
  z.object({ kind: z.literal("topic"), topic: string }),
]);
```

[源码锚点] `src/cli/apiServer.ts:132-147,79-85`

### 4.2 模式决策

外部 caller **不允许**显式指定 `mode` 字段——请求体中出现 `mode` 一律返回 400 [源码锚点] `src/cli/apiServer.ts:255-260` [测试对账] `tests/cli/apiServer.test.ts:345-364`。默认模式为 `sync_inline`。只有通过 `supermatrix_internal.caller_invocation` 且 `from` 在 `FRAMEWORK_INTERNAL_SPAWN_CALLERS`（当前仅 `"supermatrix-root"`）中的请求，才能进入 `async_kickoff` 或 `fire_and_forget` [源码锚点] `src/cli/apiServer.ts:289-304` [测试对账] `tests/cli/apiServer.test.ts:366-384`。

### 4.3 Sync Inline 完整流程

```
POST /api/spawn
    │
    ▼
校验 target / from / backend / model ──► 404/400
    │
    ▼
解析 delivery_address / sinks ──► 默认 http_response
    │
    ▼
第一次 sync spawn attempt (runSyncSpawnAttempt)
    │
    ├── 通信失败（spawn_failed，无 commId）──► 500，不降级
    │
    └── 结果返回 ──► ThreePhaseCheck
            │
            ├── 全通过 ──► 200 {closure: "verified", finalMessage}
            │
            ├── 第一阶段 communication 失败 ──► 500，不降级
            │
            ├── execution 失败（run_timeout）──► 直接降级 async（不 retry）
            │
            └── execution/delivery 失败（非 timeout）──► 重复 check
                    │
                    ├── 重复 check 通过 ──► 200
                    │
                    └── 仍失败 ──► Retry attempt
                            │
                            ├── Retry 通过 ──► 200
                            │
                            ├── Retry communication 失败 ──► 500
                            │
                            └── 仍失败 ──► 彻底降级 async
```

[源码锚点] `src/cli/apiServer.ts:492-637`

### 4.4 Three Phase Check

`runThreePhaseCheck` 对每一次 sync spawn 的结果执行三阶段验证 [源码锚点] `src/app/spawnClosure/threePhaseCheck.ts:31-51`：

| 阶段 | 检查内容 | 通过条件 | 失败时的 failureKind |
|------|----------|----------|---------------------|
| **communication** | child session 是否成功创建 | `!spawn_failed` | `spawn_not_started` |
| **execution** | child run 是否成功完成且非空 | 无 timeout/run_error，且 `finalMessage.trim() !== ""` | `run_timeout` / `run_error` / `empty_output` |
| **delivery** | result sink 是否已实际投递 | 非 `http_response` 的 sink 需在 `result_sink_attempts` 表中有 `status='delivered'` 记录 | `delivery_missing` |

若 communication 失败，后续 execution 和 delivery 被标记为 `skipped` [源码锚点] `src/app/spawnClosure/threePhaseCheck.ts:37-42`。

### 4.5 Caller Disconnect Switch

在 `sync_inline` 模式下，API Server 会监听 HTTP 请求的 `aborted`/`close` 事件以及响应的 `close` 事件 [源码锚点] `src/cli/apiServer.ts:1188-1198`。一旦检测到 caller 提前断开连接：

1. `markDisconnected` 设置 `disconnected = true`
2. `tryRegister` 将该 spawn 注册为 async item（通过 `registerAsyncItem`）
3. `runSyncSpawnAttempt` 中的 `Promise.race` 会优先返回 `detached` 结果，spawn 的后台执行继续运行但不再尝试同步返回 [源码锚点] `src/cli/apiServer.ts:1037-1058`
4. 断开后的结果通过 resultSink 异步投递，caller 可通过 `GET /api/sessions/:id/result` 轮询

[测试对账] `tests/cli/apiServer.test.ts:749-823` 验证了 caller disconnect 场景：abort 后 async item 被注册，`failedPhase` 为 `delivery`，`failureKind` 为 `late_result`。

### 4.6 Retry 策略

Sync 模式的 retry 是**单次**的，仅在以下情况触发：

- 第一次 `threePhaseCheck` 的 `firstFailure` 不是 `communication` 也不是 `run_timeout`
- 对 `firstAttempt.childSpawnResult` 做**重复 check**（不重新 spawn）后仍失败
- 然后才执行第二次 `runSyncSpawnAttempt` [源码锚点] `src/cli/apiServer.ts:556-615`

`run_timeout` 不 retry 直接降级，因为超时意味着 backend 已耗尽时间预算，重试代价高且成功率低 [源码锚点] `src/cli/apiServer.ts:543-554` [测试对账] `tests/cli/apiServer.test.ts:705-747`。

### 4.7 Async 降级响应

彻底降级时返回 200（注意不是 202），body 为：

```json
{
  "ok": false,
  "status": "switched_async",
  "ref": "async_xxx",
  "spawnCommId": "comm_xxx",
  "message": "已转后台跟进，ref=async_xxx"
}
```

[源码锚点] `src/cli/apiServer.ts:1306-1349` [测试对账] `tests/cli/apiServer.test.ts:598-641`。

框架内部 async 模式（`async_kickoff`）返回 202：

```json
{
  "ok": true,
  "mode": "async_kickoff",
  "childSessionId": "sess_xxx",
  "childSessionName": "child_xxx",
  "messageRunId": "mr_xxx",
  "spawnCommId": "comm_xxx"
}
```

[源码锚点] `src/cli/apiServer.ts:642-681` [测试对账] `tests/cli/apiServer.test.ts:366-384`。

---

## 5. POST /api/run：在现有 Session 上执行 Prompt

### 5.1 请求契约

```typescript
// 输入
{
  target: string;    // 目标 session name（必填，必须是 user scope）
  prompt: string;    // 执行 prompt（必填）
  from?: string;     // 调用者 session name（可选，用于 cross_session_log）
}
```

### 5.2 准入校验

| 校验项 | 失败响应 | 源码位置 |
|--------|----------|----------|
| target 存在 | 404 | `apiServer.ts:789-793` |
| target scope 为 `user` | 400 | `apiServer.ts:794-799` [测试对账] `tests/cli/apiServer.test.ts:1572-1582` |
| target 非 `deleted` | 400 | `apiServer.ts:801-803` |
| target 非 `error` | 400 | `apiServer.ts:805-810` [测试对账] `tests/cli/apiServer.test.ts:1623-1637` |
| target 有 binding | 500 | `apiServer.ts:824-831` [测试对账] `tests/cli/apiServer.test.ts:1611-1621` |
| target 非 busy | 409（由 `runOnSession` 决定）| `apiServer.ts:851-858` [测试对账] `tests/cli/apiServer.test.ts:1531-1546` |

### 5.3 执行流程

`POST /api/run` 调用 `runOnSession(deps, input)`，该函数与 chat 触发的 dispatcher run loop 语义对齐，但**跳过**以下 chat 耦合逻辑 [源码锚点] `src/app/runOnSession.ts:17-28`：

- 不通过 Lark 发送/更新卡片（无 `replier.consume`）
- 不执行 slash 命令路由
- 不摄取附件
- 不维护 PendingNext 队列（API 层拒绝并发，返回 409）

核心流程：

1. **Busy gate**: session 为 `busy` 或 DB 中有 lingering running run → 返回 `{kind: "busy"}` [源码锚点] `src/app/runOnSession.ts:74-81`
2. **Cross-session log**: 若提供 `requesterSessionId`，创建 `comm_run_{id}_{ts}` 的 cross_session_comm 记录 [源码锚点] `src/app/runOnSession.ts:87-100`
3. **Message run 持久化**: `startMessageRun` + `updateSessionStatus("busy")` [源码锚点] `src/app/runOnSession.ts:102-116`
4. **Backend 执行**: `backendRegistry.get(session.backend).run()`，通过 `collectStream` 收集结果 [源码锚点] `src/app/runOnSession.ts:143-152`
5. **wasCleared 检查**: run 结束后重新读取 session，若 `backendSessionId === null && status === idle`，说明 `/restart` 或 `/reset` 已介入，避免覆盖 [源码锚点] `src/app/runOnSession.ts:156-158`
6. **结果返回**:
   - 成功 → `{kind: "ok", runId, finalMessage, backendSessionId, runStatus: "completed"}`
   - 失败 → `{kind: "error", runId, finalMessage, error, runStatus}`

### 5.4 与 Chat 触发的差异

| 维度 | Chat 触发（dispatcher） | API 触发（runOnSession） |
|------|------------------------|--------------------------|
| 并发策略 | PendingNext 队列（FIFO） | 直接拒绝 409 |
| 卡片更新 | 实时 updateCard/finalizeCard | 无卡片交互 |
| 附件处理 | 下载并传入 backend | 空数组 `attachments: []` |
| cross_session_log | 通过 spawn/child 路径 | 通过 `requesterSessionId` 显式创建 |
| 状态恢复 | `drainPendingNext` 触发下一条 | 无队列，单条执行 |
| Token usage | 同 stream 实时记录 | 通过 `collectStream` + `usageBaseline` 累积归一化 |

[源码锚点] `src/app/runOnSession.ts:17-28,74-81,143-152` [测试对账] `tests/cli/apiServer.test.ts:1501-1529`

---

## 6. POST /api/notify：通知卡片的降级策略

### 6.1 请求契约

```typescript
// 普通通知
notifyInputSchema = z.object({
  source: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  level: z.enum(["info", "warn", "error"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});

// Watcher 异常 fallback
watcherExceptionNotifySchema = z.object({
  kind: z.literal("spawn_exception_transaction_fallback"),
  tx_id: z.string().min(1),
  dedupe_key: z.string().min(1),
  spawn_comm_id: z.string().min(1),
  trigger_signal: z.string().min(1),
  summary: z.string().min(1),
  payload: z.unknown().optional(),
}).strict();
```

[源码锚点] `src/cli/apiServer.ts:79-95`

### 6.2 降级策略

`createConsoleNotifier` 的 `notify` 方法优先尝试发送**飞书 interactive card** [源码锚点] `src/app/consoleNotifier.ts:127-132`：

- card 发送失败（`sendCard` 抛异常）→ **降级为纯文本** `sendText`
- 降级后返回 `{ messageId, degraded: true, error: cardErrMsg }`
- 未降级返回 `{ messageId, degraded: false }`

[源码锚点] `src/app/consoleNotifier.ts:127-143` [测试对账] `tests/cli/apiServer.test.ts:1306-1369`（通过 notifier mock 验证 watcher exception 路径的 Lark 文本投递）

### 6.3 Watcher Exception Fallback

当请求体的 `kind` 为 `"spawn_exception_transaction_fallback"` 时，走独立处理路径：

1. 渲染异常文本（含 tx_id、dedupe_key、spawn_comm_id、trigger_signal、summary、payload）
2. 发送到固定群 `YOLO_WATCHER_EXCEPTION_CHAT_ID`（`oc_REDACTEDCHATID`）
3. 无论 Lark 发送成功与否，先将异常记录到 `watcher_exceptions` 表
4. 若 Lark 发送失败，抛出异常使 API 返回 500；成功返回 200 含 `exception_id` 和 `lark_message_id`

[源码锚点] `src/cli/apiServer.ts:892-923,1426-1468`

---

## 7. PATCH /api/spawn/:comm/predicate：断言补丁

### 7.1 请求契约

```typescript
predicatePatchBodySchema = z.object({
  from: z.string().min(1),                        // 补丁发起者 session name
  actor_role: z.enum(["owner", "sk", "root"]),   // 角色声明
  tx_id: z.string().min(1).optional(),            // SK 路径必填
  reason: z.string().min(1),                      // 补丁原因
  verification_predicate: z.unknown(),            // 新断言内容
}).strict();
```

### 7.2 授权模型

PATCH 需要三层校验：

1. **Token 层**: 请求头必须携带 `Authorization: Bearer {SM_PREDICATE_PATCH_TOKEN}`。Token 来源优先级：`process.env.SM_PREDICATE_PATCH_TOKEN` → `.env.local` 文件解析 [源码锚点] `src/cli/apiServer.ts:1539-1556`。缺失 Token 返回 401，Token 不匹配返回 403 [源码锚点] `src/cli/apiServer.ts:687-698` [测试对账] `tests/cli/apiServer.test.ts:1289-1302`。

2. **Actor 存在性**: `from` 对应的 session 必须存在于 DB，否则 403 [源码锚点] `src/cli/apiServer.ts:737-740`。

3. **Actor Role 校验** (`isPatchAuthorized`) [源码锚点] `src/cli/apiServer.ts:1586-1602`：

| actor_role | 通过条件 |
|------------|----------|
| `owner` | `current.fromSessionId === actorSessionId`（即 from session 是原 spawn 的发起者） |
| `sk` | `from === "socail-king"` 且 `tx_id` 存在 且 `watcherState.patchCount24h < 3` |
| `root` | `from === "supermatrix-root" \| "codexroot"` 且 `reason.startsWith("manual-root-override:")` |

[测试对账] `tests/cli/apiServer.test.ts:1206-1302` 覆盖了 owner/sk/root 三种成功路径以及 owner 不匹配、401 缺失 Token 等失败场景。

### 7.3 补丁持久化

通过 `patchSpawnPredicate` 写入 `spawn_predicate_patches` 表，返回递增的 `version` 和新 `predicateHash` [源码锚点] `src/cli/apiServer.ts:749-765`。

---

## 8. GET /api/health

### 8.1 返回值结构

```json
{
  "status": "ok",
  "sessions": 42,      // 当前 active session 数量
  "busy": 3,           // 当前 busy session 数量
  "uptime": 3600.5     // process.uptime() 秒数
}
```

[源码锚点] `src/cli/apiServer.ts:195-204`

### 8.2 健康指标语义

- `status` 恒为 `"ok"`——只要 API Server 能响应请求，即认为健康。真正的深度健康由 `/selfcheck` 命令或启动自检覆盖。
- `sessions` = `listActiveSessions().length`，包含所有非 deleted 状态的 session。
- `busy` = `countBusySessions()`，仅统计 `status = "busy"` 的 session。
- `uptime` 来自 Node.js 原生 `process.uptime()`，可用于判断进程是否近期重启。

---

## 9. GET /api/sessions/:id/result：轮询接口

### 9.1 状态机

```
GET /api/sessions/:id/result
    │
    ├── session 不存在 ──► 404
    │
    ├── session 存在，无 message_run ──► 404
    │
    └── 有 message_run
            │
            ├── run.status === "running" ──► 202
            │   {
            │     "ok": true,
            │     "status": "running",
            │     "childSessionId": "sess_xxx",
            │     "childSessionName": "child_xxx",
            │     "startedAt": 1712345678000
            │   }
            │
            └── run.status !== "running" ──► 200
                {
                  "ok": true,
                  "status": "completed" | "failed" | "timeout" | ...,
                  "childSessionId": "sess_xxx",
                  "childSessionName": "child_xxx",
                  "backendSessionId": "...",
                  "finalMessage": "...",
                  "errorMessage": "...",
                  "startedAt": 1712345678000,
                  "finishedAt": 1712345688000
                }
```

[源码锚点] `src/cli/apiServer.ts:207-243`

### 9.2 设计意图

该接口是 async spawn 模式（含 sync 降级为 async 的场景）的结果消费端。Caller 在收到 202（async_kickoff）或降级后的 `switched_async` 后，通过轮询此接口获取最终状态。`childSessionName` 的返回使得 caller 无需额外查询即可获知子会话标识。

---

## 10. 优雅关闭

> 注：`src/cli/shutdown.ts` 不存在于源码树中。所有关闭逻辑集中在 `bootstrap.ts` 的 `gracefulStop` 闭包与 `main.ts` 的信号处理程序中。

### 10.1 gracefulStop 的关闭顺序

`gracefulStop` 定义于 `bootstrap.ts` 内，是一个闭包，按以下严格顺序执行 [源码锚点] `src/cli/bootstrap.ts:734-772`：

| 顺序 | 组件 | 操作 | 超时 |
|------|------|------|------|
| 1 | sourceWatcher | `disposeWatcher()`（abort fs.watch + 取消 pending typecheck） | 无 |
| 2 | cleanupTimer | `clearInterval(cleanupTimer)` | 无 |
| 3 | btw handler | `btw.shutdown()` | 无 |
| 4 | API Server | `closeServerWithTimeout(apiServer, min(5_000, cfg.shutdownGraceTimeoutMs))` | 5s 或 grace timeout 取小 |
| 5 | KimiBackend | `kimiBackend.dispose()` | 无（尽力而为） |
| 6 | Lark Gateway | `lark.stop()` | 无（尽力而为） |
| 7 | EventBus | `eventBus.stop()` | 无（尽力而为） |
| 8 | PID File | `cleanupBootstrapPidFile(cfg.dbPath)` | 无 |
| 9 | Store | `store.close()` | 无（尽力而为） |

每一步都包裹在 `try/catch` 中，失败仅记录日志，不中断后续步骤 [源码锚点] `src/cli/bootstrap.ts:747-771`。

### 10.2 超时机制

- `closeServerWithTimeout` [源码锚点] `src/cli/bootstrap.ts:140-181`：
  - 先调用 `server.close(cb)` 等待现有连接自然关闭
  - 超时后若存在 `closeAllConnections` 则强制断开所有连接，否则退而求其次 `closeIdleConnections`
  - 返回 `"completed"` 或 `"timed_out"`

- `runWithTimeout` [源码锚点] `src/cli/bootstrap.ts:122-138`：
  - `Promise.race` 在 operation 与 setTimeout 之间竞争
  - 返回 `"completed"` 或 `"timed_out"`

[测试对账] `tests/cli/shutdown.test.ts:9-33` 验证了 `runWithTimeout` 在 fake timer 下正确返回 `timed_out`，以及 `closeServerWithTimeout` 在超时时调用 `closeAllConnections`。

### 10.3 main.ts 的信号处理

`main.ts` 注册 `SIGINT` 和 `SIGTERM` 处理器 [源码锚点] `src/cli/main.ts:91-92`：

- **第一次信号**: 调用 `app.lifecycle.requestRestart("signal: SIGTERM", {force: false})`，由 `ProcessLifecycle` 等待 in-flight runs 完成后触发 `onExit`
- **第二次信号**: 强制退出，`app.lifecycle.requestRestart(..., {force: true})`
- **硬超时**: 若 graceful shutdown 在 `SHUTDOWN_TIMEOUT_MS = 60_000` 内未完成，自动触发 force exit [源码锚点] `src/cli/main.ts:80-88`
- **SIGTERM 取证**: 第一次 SIGTERM 时同步执行 `ps -ef` 快照，追加到 `logs/sm-sigterm-forensics.log`，用于排查未知来源的 SIGTERM [源码锚点] `src/cli/main.ts:18-33`

### 10.4 reload 机制

`sourceWatcher` 或 `/reload` 命令触发重启时，`ProcessLifecycle.onExit` 会：

1. 将 reload source 写入 `{dbDir}/.reload-source`（如 `"src-watcher"` 或 `"command"`）
2. 调用 `gracefulStop`
3. `process.exit(0)`

下次启动时，`bootstrap.ts` 读取 `.reload-source` 并在启动播报中展示触发来源 [源码锚点] `src/cli/bootstrap.ts:681-698,854-873`。

启动播报有 60 秒冷却期：若 60 秒内重启，则跳过播报防止消息轰炸 [源码锚点] `src/cli/bootstrap.ts:839-852`。

---

## 11. 源文件监视（SourceWatcher）

### 11.1 触发条件

`startSourceWatcher` 使用 Node.js `fs.watch(opts.srcDir, {recursive: true})` 递归监视 `.ts` 文件变更 [源码锚点] `src/cli/sourceWatcher.ts:22,78-88`。

过滤规则：
- 仅响应以 `.ts` 结尾的文件 [源码锚点] `src/cli/sourceWatcher.ts:84`
- 启动后 5 秒 grace period 内忽略所有事件（避免启动脚本自身写文件触发误重启）[源码锚点] `src/cli/sourceWatcher.ts:24,85`

### 11.2 Debounce 与 Preflight

文件变更到达后，启动 `debounceMs`（默认 300ms）的防抖定时器 [源码锚点] `src/cli/sourceWatcher.ts:23,42-48`。稳定后执行 `tsc --noEmit` 作为 preflight 检查 [源码锚点] `src/cli/sourceWatcher.ts:54-62`。

关键行为：
- **typecheck 失败** → 记录 warn，**不触发重启** [源码锚点] `src/cli/sourceWatcher.ts:64-70`
- **typecheck 期间有新变更** → `kill()` 正在运行的 tsc 子进程，重新 debounce [源码锚点] `src/cli/sourceWatcher.ts:34-40`
- **typecheck 通过** → 调用 `opts.lifecycle.requestRestart(..., {source: "src-watcher"})` [源码锚点] `src/cli/sourceWatcher.ts:72-75`

### 11.3 reload 行为

sourceWatcher 触发的 restart 属于 graceful restart 范畴：
- 不直接退出进程，而是通过 `ProcessLifecycle.requestRestart`
- `ProcessLifecycle` 等待 `inFlight === 0` 后才执行 `onExit`
- 因此正在进行的 backend run 不会被打断

[源码锚点] `src/cli/sourceWatcher.ts:72-75`, `src/app/processLifecycle.ts:27-38`

---

## 12. 不变式清单

以下不变式由 CLI & API 层保护，违反将导致系统行为不可预期。

1. **Loopback Only**: API Server 仅绑定 `127.0.0.1`，不接受外部网络连接。违反后果：未授权实体可直接调用 `/api/spawn`、 `/api/run` 执行任意 prompt。[源码锚点] `src/cli/apiServer.ts:979`

2. **Sync Inline 不接受 Caller 自选 Mode**: `/api/spawn` 请求体中出现 `mode` 字段一律 400。框架独占模式决策权，防止 caller 误用 async 模式绕过 three-phase verification。[源码锚点] `src/cli/apiServer.ts:255-260` [测试对账] `tests/cli/apiServer.test.ts:345-364`

3. **Sync Inline 不接受 Caller 提供的 Sinks**: 外部 caller 使用 `sync_inline` 时，`sinks` 字段必须缺失或为空，否则 400。结果必须通过 HTTP 响应返回，防止结果丢失。[源码锚点] `src/cli/apiServer.ts:409-418` [测试对账] `tests/cli/apiServer.test.ts:981-997`

4. **Pre-wiring Fail Fast**: 任何 pre-wiring check 返回 `fail`，`bootstrap` 在构造 Store 之前即 `process.exit(1)`。确保带伤配置永远不会触及 DB 或飞书网关。[源码锚点] `src/cli/bootstrap.ts:261-264`

5. **Reconciler 异常回退**: post-wiring 的 `reconcileBackendProcessesCheck` 若抛出异常，必须回退到 `resetRunningMessageRunsOnBoot` 并标记 `warn`。防止 reconciler bug 导致启动死锁。[源码锚点] `src/cli/bootstrap.ts:295-310`

6. **API Port 先于 Lark 绑定**: `app.start()` 内先启动 `startApiServer`，成功后才 `lark.start()`。确保端口冲突在启动播报之前暴露，避免 crash loop 噪音。[源码锚点] `src/cli/bootstrap.ts:776-798`

7. **Caller Disconnect 不中止 Spawn**: sync spawn 期间 caller HTTP 连接断开，spawn 的后台执行继续运行，通过 async item 注册保证结果可被后续查询。禁止静默丢弃。[源码锚点] `src/cli/apiServer.ts:1044-1058` [测试对账] `tests/cli/apiServer.test.ts:749-823`

8. **Double Signal Escalation**: 第二次 SIGINT/SIGTERM 必须立即 force exit，不得无限等待 in-flight runs。防止操作员在紧急情况下失去进程控制权。[源码锚点] `src/cli/main.ts:50-56`

9. **Source Watcher 不重启 Broken Code**: `tsc --noEmit` 失败时绝对禁止触发 `requestRestart`。防止编译错误导致反复 crash loop。[源码锚点] `src/cli/sourceWatcher.ts:64-70`

10. **RunOnSession 的 Busy Gate**: `/api/run` 遇到 busy session 返回 409，不进入 PendingNext 队列。API caller 必须自行实现重试，禁止隐式队列化导致时序不可控。[源码锚点] `src/app/runOnSession.ts:74-81` [测试对账] `tests/cli/apiServer.test.ts:1531-1546`

---

## 13. 反例场景

### 13.1 反例 1：外部 caller 试图强制 async 模式

**场景**: 外部 session 发送 `POST /api/spawn` 并携带 `"mode": "async_kickoff"`。

**结果**: 400 `"mode is not supported in /api/spawn requests; omit it and let the framework choose async fallback"`。Spawn 不会被创建。

**原因**: 框架独占模式决策权，防止 caller 绕过 sync inline 的三阶段验证。Async 只能是框架内部标记或 sync 失败后的自动降级。[源码锚点] `src/cli/apiServer.ts:255-260` [测试对账] `tests/cli/apiServer.test.ts:345-364`

### 13.2 反例 2：sync spawn 返回空结果，retry 仍失败

**场景**: child session 成功创建并运行，但 `finalMessage` 为空字符串。重复 check 仍为空，触发 retry attempt，retry 结果仍然为空。

**结果**: 返回 200 `{ok: false, status: "switched_async", ref: "async_xxx"}`，注册 async item，`failureKind` 为 `empty_output`。

**原因**: `empty_output` 被视为 execution 失败，允许 retry 一次；retry 仍失败则彻底降级，由后台 watcher/adjudication 路径继续处理。[源码锚点] `src/cli/apiServer.ts:556-636` [测试对账] `tests/cli/apiServer.test.ts:598-641`

### 13.3 反例 3：caller 在 sync spawn 运行中 disconnect

**场景**: Caller 通过 HTTP 长连接调用 sync spawn，backend 运行期间 caller 网络中断或主动 abort。

**结果**: API Server 检测到 `req.aborted` 或 `res.close`，注册 async item（`failureKind: late_result`），spawn 继续在后台执行。Caller 不会收到 HTTP 响应，但可通过 `GET /api/sessions/:id/result` 轮询结果。

**原因**: `createCallerDisconnectSwitch` 在 disconnect 事件触发时调用 `registerAsyncItem`，确保结果不丢失。[源码锚点] `src/cli/apiServer.ts:1090-1218` [测试对账] `tests/cli/apiServer.test.ts:749-823`

### 13.4 反例 4：向 error 状态的 session 发送 `/api/run`

**场景**: 某 user session 因 backend 崩溃进入 `error` 状态，外部 scheduler 仍向该 session 发送 `POST /api/run`。

**结果**: 400 `"target session in error state — use /restart or /reset first"`。

**原因**: `runOnSession` 不自动恢复 error session，防止在 broken backend context 上继续累积错误。必须由 root group 的 `/restart` 或 `/reset` 命令显式恢复。[源码锚点] `src/cli/apiServer.ts:805-810` [测试对账] `tests/cli/apiServer.test.ts:1623-1637`

### 13.5 反例 5：patch predicate 时 owner 身份伪造

**场景**: 攻击者（或 bug）使用 `codexroot` 身份、声明 `actor_role: "owner"` 尝试 patch 不属于它的 spawn comm。

**结果**: 403 `"predicate patch not authorized"`。`isPatchAuthorized` 中 `owner` 路径严格校验 `current.fromSessionId === actorSessionId`，与 `from` 字符串无关。[源码锚点] `src/cli/apiServer.ts:1586-1594` [测试对账] `tests/cli/apiServer.test.ts:1271-1287`

### 13.6 反例 6：双实例启动

**场景**: 操作员不小心在终端手动执行 `tsx src/cli/main.ts`，而当前已有 localwatch/supervisor 管理的实例在运行。

**结果**: `dualInstanceCheck` 通过 PID 文件锁和 ps 扫描检测到存活实例，pre-wiring 返回 `fail`，`process.stderr.write` 渲染失败报告后 `process.exit(1)`。

**原因**: 双实例会导致飞书 WebSocket 竞争、DB 写冲突、backend 进程管理混乱。[源码锚点] `src/app/bootSelfCheck/checks/dualInstance.ts:7-55` [测试对账] `tests/cli/shutdown.test.ts`（间接验证单实例假设）

### 13.7 反例 7：源码编译错误触发重启

**场景**: 开发者保存了一个有 TypeScript 类型错误的文件到 `src/`。

**结果**: `sourceWatcher` 的 debounce 触发 `tsc --noEmit`，typecheck 失败，记录 warn 后**不调用** `requestRestart`。进程继续运行旧代码。

**原因**: 防止编译错误导致 crash loop。开发者修复错误并再次保存后，typecheck 通过才会重启。[源码锚点] `src/cli/sourceWatcher.ts:64-70`

---

## 14. 测试对账索引

| 测试文件 | 覆盖范围 |
|----------|----------|
| `tests/cli/apiServer.test.ts` | `/api/spawn` 完整流程（mode 拒绝、delivery_address、sinks、closure verification、retry、async 降级、caller disconnect、model 选择、predicate 校验与 patch）; `/api/run` 的 busy/404/500/error 场景; `/api/notify` 的 watcher exception fallback |
| `tests/cli/shutdown.test.ts` | `runWithTimeout` 与 `closeServerWithTimeout` 的超时行为 |

---

*文档结束。所有源码锚点均基于 SuperMatrix 主仓库 `src/cli/`、`src/app/runOnSession.ts`、`src/app/consoleNotifier.ts`、`tests/cli/` 目录下的当前版本。*
