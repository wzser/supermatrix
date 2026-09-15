# Domain & Ports 深度 PRD

> 本文档对 SuperMatrix 骨架 PRD（`00-skeleton.md`）中 Domain 层与 Ports 层的所有类型、规则、不变式进行逐字段拆解。所有声明均附带源码锚点与测试对账，不引入源码中不存在的假设。
> 版本: v1.0-draft
> 日期: 2026-05-20
> 源码锚定: 基于 SuperMatrix 主仓库 commit 范围 ce32f76 及之前

---

## 1. 实体定义

Domain 层定义了框架运行的全部业务实体。以下按文件组织，给出每个字段的语义、类型约束与空值规则。

### 1.1 Session（`src/domain/session.ts:40-73`）

| 字段 | 类型 | 空值规则 | 语义 |
|------|------|----------|------|
| `id` | `SessionId` | 非空 | 全局唯一标识，格式 `sess_` + 8 位 hex |
| `name` | `string` | 非空 | 机器可读名称，受 `NAME_RE` 约束（见 §8） |
| `alias` | `string` | 非空（可空串） | 人类可读别名，≤8 可见字符，不可含空白/ `/` / `\` / `|` |
| `avatar` | `string` | 非空（可空串） | 飞书 Bitable file_token（27 位 base62）或空串 |
| `category` | `SessionCategory` | 非空 | 闭包枚举：`""` / `"业务"` / `"平台"` / `"工具"` / `"知识"` / `"外部"` |
| `fpManaged` | `boolean \| null` | 可为 null | FP 管辖标记；`null` 视为未标记（在 scope 内），`false` 显式排除 |
| `scope` | `Scope` | 非空 | `"root"` / `"user"` / `"child"`，决定群绑定与命令可见性 |
| `backend` | `BackendKind` | 非空 | `"claude"` / `"codex"` / `"kimi"` |
| `model` | `string \| null` | 可为 null | 模型标识（如 `"sonnet-4-5"`），null 表示使用后端默认 |
| `effort` | `EffortLevel \| null` | 可为 null | `"low"` / `"medium"` / `"high"` / `"xhigh"` / `"max"` |
| `thinking` | `boolean` | 非空 | 是否启用扩展思考模式 |
| `modelLocked` | `boolean` | 非空 | 模型是否被锁定（禁止运行时切换） |
| `workdir` | `AbsolutePath` | 非空 | 工作目录绝对路径，需以 `/` 开头 |
| `backendSessionId` | `string \| null` | 可为 null | 后端层会话 ID：Claude rollout UUID / Codex thread ID / Kimi ACP session ID |
| `chatName` | `string \| null` | 可为 null | 飞书群显示名称（历史字段，无新写入方） |
| `purpose` | `string` | 非空 | 能力描述文本，由 FP 脚本写入，SuperMatrix 不解析其内部结构 |
| `status` | `SessionStatus` | 非空 | 状态机当前状态（见 §3） |
| `parentId` | `SessionId \| null` | 可为 null | 父会话 ID；child session 必有值，root/user 为 null |
| `depth` | `number` | 非空 | 派生深度；root=0，child=parent.depth+1 |
| `inactivityTimeoutS` | `number \| null` | 可为 null | 空闲超时秒数；null 表示禁用 |
| `maxRuntimeS` | `number \| null` | 可为 null | 单次运行最大秒数；null 表示禁用 |
| `childType` | `ChildSessionType \| null` | 可为 null | 子会话类型；非 child scope 为 null |
| `triggerKind` | `TriggerKind \| null` | 可为 null | 触发来源：session / human / watchdog / scheduler / skill_master / eventbus_subscriber / self_curl |
| `postIdentity` | `PostIdentity \| null` | 可为 null | 结果投递身份：bot / user / caller_default |
| `callerInvocation` | `CallerInvocation \| null` | 可为 null | 调用模式：sync_inline / async_kickoff / fire_and_forget |
| `continuationHook` | `ContinuationHook \| null` | 可为 null | `"none"` / `"inject_result"` |
| `capabilityPayload` | `CapabilityPayload \| null` | 可为 null | 子会话能力载荷（resultSinks + eventBusContract） |
| `createdAt` | `Timestamp` | 非空 | 创建时间戳（epoch millis） |
| `updatedAt` | `Timestamp` | 非空 | 最后更新时间戳 |

[测试对账] `tests/domain/sessionCatalog.test.ts:6-39` 中的 `mkSession` 工厂函数覆盖了全部字段的默认值构造，验证了 `Session` 类型的完整性。

### 1.2 Attachment / AttachmentRef

Domain 层定义（`src/domain/attachment.ts:3-13`）：

```typescript
type AttachmentKind = "image" | "file";

type AttachmentRef = {
  id: string;
  sessionId: SessionId;
  kind: AttachmentKind;
  localPath: AbsolutePath;
  originalName: string;
  mimeType?: string | undefined;
  uploadedAt: Timestamp;
};
```

Ports 层在 `AgentBackend.ts:5-11` 中额外定义了一个无 `id` / `sessionId` 的精简版 `AttachmentRef`，专供 `RunInput.attachments` 使用。两者字段名一致，但语义域不同：domain 版用于持久化（含 DB 主键 `id`），ports 版用于运行时传递。

[测试对账] `tests/domain/attachmentResolver.test.ts:8-18` 中的 `att()` 工厂构造了 domain 版 `AttachmentRef`；`tests/domain/promptBuilder.test.ts:6-16` 中的 `att()` 工厂构造了 ports 版（通过类型兼容隐式转换）。

### 1.3 MessageRun（`src/ports/BindingStore.ts:95-106`）

单次 prompt 执行的持久化记录。

| 字段 | 类型 | 语义 |
|------|------|------|
| `id` | `MessageRunId` | 全局唯一，格式 `mr_` + 8 位 hex |
| `sessionId` | `SessionId` | 所属 session |
| `groupId` | `LarkGroupId` | 触发该 run 的飞书群 ID |
| `prompt` | `string` | 用户原始 prompt 文本 |
| `cardId` | `CardId \| null` | 关联的飞书卡片 ID；null 表示无卡片（如 API 触发） |
| `startedAt` | `Timestamp` | 开始时间 |
| `finishedAt` | `Timestamp \| null` | 结束时间；null 表示仍在运行 |
| `status` | `RunStatus` | `"running"` / `"completed"` / `"failed"` / `"cancelled"` / `"timeout"` |
| `finalMessage` | `string \| null` | 最终助手回复文本 |
| `errorMessage` | `string \| null` | 错误信息 |

**RunStatus** 与 **SessionStatus** 的区别：`RunStatus` 是 `message_runs` 表的行状态，而 `SessionStatus` 是会话级状态。两者生命周期解耦：一个 session 可在 `idle` 状态下拥有多条 `completed` 的 message_run。

### 1.4 CrossSessionComm（`src/ports/BindingStore.ts:159-189`）

跨会话通信记录，用于 `/spawn`、continuation 注入和 `/api/run`。

| 字段 | 类型 | 语义 |
|------|------|------|
| `id` | `string` | 通信记录唯一 ID |
| `fromSessionId` | `SessionId` | 请求方 session |
| `toSessionId` | `SessionId` | 目标方 session |
| `kind` | `CrossSessionCommKind` | `"spawn"` / `"continuation"` / `"resume_main"` |
| `prompt` | `string` | 请求的 prompt 文本 |
| `childSessionId` | `string \| null` | 派生的 child session ID；`resume_main` 时为 null |
| `status` | `"pending" \| "completed" \| "failed"` | 通信状态 |
| `resultPreview` | `string \| null` | 结果预览 |
| `finalMessage` | `string \| null` | 最终结果全文 |
| `messageRunId` | `MessageRunId \| null` | 关联的 message run |
| `errorMessage` | `string \| null` | 错误信息 |
| `finishedAt` | `Timestamp \| null` | 完成时间 |
| `bitableRecordId` | `string \| null` | 飞书 Bitable 同步记录 ID |
| `syncedAt` | `Timestamp \| null` | 最后一次成功同步到 Bitable 的时间 |
| `childModel` | `string \| null` | 子会话使用的模型 |

### 1.5 Binding（`src/domain/binding.ts:3-7`）

Session 与飞书群的 1:1 绑定。

```typescript
type Binding = {
  groupId: LarkGroupId;
  sessionId: SessionId;
  createdAt: Timestamp;
};
```

约束：一个 `groupId` 只能绑定一个 session，一个 `sessionId` 也只能绑定一个群。该不变式由 `BindingStore` 实现保证（`createSessionWithBinding` 在事务中同时插入 `sessions` 与 `bindings` 行）。

### 1.6 TokenUsage（`src/ports/BindingStore.ts:108-143`）

Token 消耗统计的三层聚合：

- **原始输入** (`TokenUsageInput`): 单条 run 的 token 消耗，含 `rawUsageJson`（后端原始 JSON）。
- **原始累积** (`TokenUsageRawTotals`): 某 session 最新一次 run 的各维度 token 数。
- **窗口聚合** (`TokenUsageWindow`): 含 `rowCount` 的聚合窗口（today / last7Days / cumulative）。
- **总览** (`TokenUsageSummary`): 三个窗口的汇总。

### 1.7 SpawnPredicate & WatcherState（`src/domain/spawnPredicate.ts`, `src/ports/BindingStore.ts:191-257`）

`SpawnPredicate` 是五种断言的联合类型：`git-log`、`db-row`、`file-mtime`、`http-get`、`inbox-message`。每种断言共享 `PredicateCommon`（`expected_window_sec`、`evaluation_timeout_ms`、`retry_on_transient_fail`），并携带类型专属字段。

`WatcherStateRecord` 追踪断言评估器的运行状态：
- `consecutiveFalseCount`: 连续评估为 false 的次数
- `consecutiveTransientFailCount`: 连续瞬态失败的次数
- `patchCount24h`: 24 小时内 patch 次数
- `leaseOwner` / `leaseExpiresAt`: 分布式租约（防止多实例同时评估同一断言）


---

## 2. 值对象

### 2.1 Branded Type 设计（`src/domain/ids.ts:1-36`）

SuperMatrix 使用 TypeScript 的交集类型（intersection type）实现编译期标签，防止不同语义域的字符串被误用：

```typescript
export type SessionId    = string & { readonly __brand: "SessionId" };
export type LarkGroupId  = string & { readonly __brand: "LarkGroupId" };
export type AbsolutePath = string & { readonly __brand: "AbsolutePath" };
export type Timestamp    = number & { readonly __brand: "Timestamp" };
export type CardId       = string & { readonly __brand: "CardId" };
export type MessageRunId = string & { readonly __brand: "MessageRunId" };
```

每个 branded type 配有工厂函数，在运行时执行最小校验：

| 工厂函数 | 校验规则 | 失败行为 |
|----------|----------|----------|
| `asSessionId(v)` | `v` 非空串 | `throw new Error("SessionId must be non-empty")` |
| `asLarkGroupId(v)` | `v` 非空串 | `throw new Error("LarkGroupId must be non-empty")` |
| `asAbsolutePath(v)` | 以 `/` 开头 | `throw new Error("AbsolutePath must start with /: ${value}")` |
| `asTimestamp(v)` | `Number.isFinite(v)` | `throw new Error("Timestamp must be a finite number")` |
| `asCardId(v)` | `v` 非空串 | `throw new Error("CardId must be non-empty")` |
| `asMessageRunId(v)` | `v` 非空串 | `throw new Error("MessageRunId must be non-empty")` |

**设计意图**：
1. **零运行时开销**：brand 字段为 `readonly`，实际不存在于运行时代码中；TypeScript 编译后与普通 `string`/`number` 完全相同。
2. **边界防御**：`asAbsolutePath` 阻止相对路径进入 domain 层，避免后续 `path.resolve` 产生非确定性结果。
3. **类型即文档**：函数签名中 `SessionId` 与 `LarkGroupId` 不可互换，消除了 "把群 ID 当 session ID 传入" 的一类 bug。

[测试对账] `tests/domain/ids.test.ts:4-25` 覆盖了全部六个工厂函数的正例与反例，包括 `asAbsolutePath` 对 `./foo` 的拒绝和 `asTimestamp` 对 `NaN` 的拒绝。

### 2.2 Timestamp 的语义约定

`Timestamp` 为 epoch milliseconds（`Date.now()` 语义），而非 seconds。所有比较直接使用算术运算（`a - b`）。格式化函数 `formatIso` 与 `formatRelativeChinese`（`src/domain/format.ts:3-17`）均基于此语义。

[测试对账] `tests/domain/format.test.ts:5-26` 验证了 ISO 格式输出与中文相对时间的四个档位（刚刚 / 分钟前 / 小时前 / 天前）。

---

## 3. 状态机

### 3.1 SessionStatus 的定义（`src/domain/session.ts:12-18`）

```typescript
export type SessionStatus =
  | "initializing"
  | "idle"
  | "busy"
  | "waiting"
  | "error"
  | "deleted";
```

`waiting` 状态专属于 `event_awaited_worker` 子会话：第一 run 完成后进入该状态，持有一个 `TopicBus` 订阅，直到 gating topic 到达或 `maxRuntime` 超时。[源码锚点] `src/domain/session.ts:20-26`。

### 3.2 普通 Session（root / user）状态转换图

```
                    +-------------+
                    | initializing|
                    +------+------+
                           | create success
                           v
    +---------------+    idle      +---------------+
    |  /cancel /    |<------------>|   /restart    |
    | backend error |              |   /reset      |
    v               |              v               |
   busy <-----------+            error <----------+
    |   prompt arrives              |
    |   run finished                |
    +---> idle (success)            +---> idle (after /restart /reset)
    +---> error (run threw)         +---> deleted (after /delete)
```

#### 转换规则详表

| 源状态 | 目标状态 | 触发条件 | 副作用 | 源码锚点 |
|--------|----------|----------|--------|----------|
| `initializing` | `idle` | `sessionLifecycle.create()` 成功完成所有 scaffold 步骤 | 发送 `session_status_changed` 事件；再生 session-catalog | `src/app/sessionLifecycle.ts:270` |
| `idle` | `busy` | Dispatcher 收到 prompt，通过准入检查后 | 插入 `message_runs` 行；发送 `session_status_changed` | `src/app/dispatcher.ts:586` |
| `busy` | `idle` | Backend stream 正常完成且无错误 | 持久化 `finalMessage`、token usage、streamLog；发送 `session_status_changed`；触发 `drainPendingNext` | `src/app/dispatcher.ts:699-710` |
| `busy` | `idle` | Backend stream 完成但携带 error 事件（如 codex empty completion） | 同上，但 `finishMessageRun` 状态为 `failed` | `src/app/dispatcher.ts:678-689` |
| `busy` | `idle` | run 过程中抛出未捕获异常（非 timeout/cancel） | `finishMessageRun` 状态由 `classifyRunStatus` 决定；恢复 `idle` | `src/app/dispatcher.ts:720-729` |
| `error` | `idle` | `/restart` 或 `/reset` 命令 | 清空 `backendSessionId`；发送 `session_status_changed` | `src/app/sessionLifecycle.ts:339-355` |
| `idle` / `error` | `deleted` | `/delete` 命令 | 解散飞书群；删除 DB 行；发送 `session_deleted` | `src/app/sessionLifecycle.ts:302-321` |
| *any* | `deleted` | `deleteSessionAndBinding` 级联删除 | 子会话同步被标记为 `deleted` | `src/app/childSession.ts:443-446`（`isDeletedNow` 检查） |

#### 特殊：boot 自检查时的状态修复

当进程重启后，`reconcileBackendProcesses` 检查可能发现 Kimi ACP 进程仍在运行但 DB 中 session 状态非 `busy`：

| 源状态 | 目标状态 | 触发条件 | 源码锚点 |
|--------|----------|----------|----------|
| 非 `busy` | `busy` | Boot 检查发现 live Kimi ACP 进程与 session 匹配 | `src/app/bootSelfCheck/checks/reconcileBackendProcesses.ts:93-94` |
| `busy` | 保持 `busy`（隐含） | 孤儿进程被 kill，关联 run 被标记 `timeout` | 同上 `:104` |

### 3.3 Child Session 状态转换图

Child session 的状态机在普通路径上增加了 `waiting` 分支，且终止态由 `childType` 决定。

```
initializing ---> idle ---> busy ---> deleted   (one_shot_delegation)
initializing ---> idle ---> busy ---> idle      (ephemeral_conversation，可再次 busy)
initializing ---> idle ---> busy ---> waiting ---> deleted   (event_awaited_worker，topic 到达)
initializing ---> idle ---> busy ---> waiting ---> error     (event_awaited_worker，超时)
```

#### 转换规则详表

| 源状态 | 目标状态 | 触发条件 | 副作用 | 源码锚点 |
|--------|----------|----------|--------|----------|
| `busy` | `deleted` | `one_shot_delegation` run 正常完成 | 投递 result sinks；持久化 message run | `src/app/childSession.ts:113-115`, `:665` |
| `busy` | `idle` | `ephemeral_conversation` run 正常完成 | 同上；session 行保留，可接受后续 run | `src/app/childSession.ts:113-115`, `:665` |
| `busy` | `waiting` | `event_awaited_worker` 第一 run 完成 | 订阅 TopicBus；等待 gating topic | `src/app/childSession.ts:594` |
| `waiting` | `deleted` | Topic 在 `maxRuntime` 内到达 | 投递 result sinks | `src/app/childSession.ts:618` |
| `waiting` | `error` | Topic 等待超时 | 不投递 sinks；抛出 `RunFailure` | `src/app/childSession.ts:642` |
| `busy` | `error` | run 抛出未捕获异常 | 不投递 sinks；恢复 `error` | `src/app/childSession.ts:698-706` |
| `busy` | `error` | `startMessageRun` 等前置步骤失败 | `revertBusyOnSetupFailure` 自动回滚 | `src/app/childSession.ts:149-166` |

**关键不变式**：`terminalStatusForChildType` 函数（`src/app/childSession.ts:113-115`）是 child 终止态的唯一权威来源：

```typescript
export function terminalStatusForChildType(type: ChildSessionType | null): SessionStatus {
  return type === "ephemeral_conversation" ? "idle" : "deleted";
}
```

这意味着 `event_awaited_worker` 在 topic 到达后的终止态也是 `deleted`（不是 `idle`），且 `user_voice_reporter`、`event_publisher` 目前同样走向 `deleted`。


---

## 4. 错误模型

### 4.1 类型层级（`src/domain/errors.ts:1-16`）

```
Error
+-- DomainError
    +-- UserError
    +-- SystemError
```

```typescript
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class UserError extends DomainError {}

export class SystemError extends DomainError {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) this.cause = cause;
  }
}
```

### 4.2 区分语义

| 类型 | 使用场景 | 典型触发点 | 用户可见性 |
|------|----------|------------|------------|
| `UserError` | 用户输入不合法、业务规则冲突、权限不足 | 命令参数错误、session 已删除、深度超限、并发超限 | **直接可见**，消息文本原样返回 |
| `SystemError` | 基础设施故障、外部依赖不可用、未预期的代码路径 | DB 写入失败、文件系统错误、后端进程崩溃 | **脱敏后可见**，用户看到 "内部错误，请查看 console 日志" |
| `DomainError` | 抽象基类，不直接实例化 | — | 视子类而定 |

### 4.3 传播规则

1. **Command Router 层**（`src/app/commandRouter.ts:33-34`）是错误分类的边界：
   - `UserError` -> 直接返回 `❌ ${err.message}` 到飞书群
   - `SystemError` -> 返回脱敏消息 `"❌ 内部错误，请查看 console 日志"`，原始错误写入日志
   - 其他 `Error` -> 同 `SystemError` 处理

2. **Session Lifecycle 层**（`src/app/sessionLifecycle.ts:295-299`）在 `create()` 的 try/catch 中：
   - `UserError` -> 原样向上抛出（由 commandRouter 处理）
   - 其他异常 -> 包装为 `SystemError(message, err)` 后抛出

3. **Child Session 层** 的 `revertBusyOnSetupFailure`（`src/app/childSession.ts:149-166`）是一个特殊防御：当 `runPrompt` 的前置步骤（如 `startMessageRun`）抛出异常时，自动将 `busy` 回滚为 `error`，防止 session 永远卡在 `busy`。

### 4.4 RunFailure（App 层内部异常）

`RunFailure`（`src/app/childSession.ts:38-43`）不是 Domain 层类型，但属于 child session 状态机的关键控制流：

```typescript
class RunFailure extends Error {
  constructor(message: string, readonly messageRunId: MessageRunId) {
    super(message);
    this.name = "RunFailure";
  }
}
```

它仅在 `runPrompt` 内部使用，用于将 stream 异常或超时信息向上传播，同时携带 `messageRunId` 以便调用方记录。

[测试对账] `tests/domain/errors.test.ts:4-23` 验证了 `UserError` 是 `DomainError` 的实例、`SystemError` 可选携带 `cause`、以及 `SystemError` 无 `cause` 时字段为 `undefined`。

---

## 5. 事件系统

### 5.1 AgentEvent（`src/domain/events/agentEvent.ts:1-19`）

Backend 进程在单次 run 中通过 `AsyncIterable<AgentEvent>` 向框架投递的流事件。所有变体如下：

| 变体 | 字段 | 语义 |
|------|------|------|
| `started` | `backendSessionId: string; model?: string; thinking?: boolean` | Backend 会话初始化完成，后续事件均属于该 session |
| `thinking` | `text: string` | Claude 的扩展思考文本（非最终输出） |
| `tool_call` | `name: string; args: unknown; callId?: string; command?: string` | Agent 调用工具 |
| `tool_result` | `name: string; result: unknown; callId?: string; command?: string` | 工具执行结果返回 |
| `assistant_message` | `text: string; final: boolean` | 助手生成的文本块；`final=true` 表示最后一块 |
| `error` | `message: string; recoverable: boolean` | Backend 报告错误；`recoverable=true` 表示可重试（如网络瞬断） |
| `completed` | `finalMessage: string` | Stream 正常结束，携带最终消息全文 |
| `usage` | `model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, contextWindowTokens?, rawUsage` | Token 消耗统计；Claude/Codex 实时上报 |

**关键语义**：
- `error` 事件分为 **可恢复** 与 **不可恢复**。Replier 对可恢复错误仅记录到 streamLog，不终止 run；不可恢复错误（或连续多次可恢复错误后仍然失败）才会标记 run 为失败。[源码锚点] `src/app/replier.ts:220-233`。
- `usage` 事件的出现时机和字段完整性因后端而异：Claude 在 stream 末尾上报；Codex 的 usage 是累积式的，需要 `normalizeCumulativeUsage`。

### 5.2 SessionEvent（`src/domain/events/sessionEvent.ts:4-25`）

框架内部生命周期事件，由 `EventBus` 投递。

| 变体 | 字段 | 语义 |
|------|------|------|
| `session_created` | `session: Session` | 新 session 创建成功 |
| `session_deleted` | `sessionId: SessionId` | Session 行被删除 |
| `session_status_changed` | `sessionId: SessionId; from: SessionStatus; to: SessionStatus` | 状态转换已持久化 |
| `catalog_updated` | `reason: string` | 全局 `session-catalog.json` 已重新生成（无 sessionId，因为一次生成覆盖全部） |
| `message_to_session` | `from: SessionId; to: SessionId; payload: unknown` | 跨会话消息投递（如 continuation 注入） |

**EventBus 语义**（`src/ports/EventBus.ts:7-12`）：
- `publish(event)` 是异步的，返回 `Promise<void>`
- `subscribe(kinds, handler)` 按事件种类过滤订阅
- 当前唯一实现为 `InMemoryEventBus`，无持久化保证；若进程重启，未处理事件丢失

---

## 6. 子会话能力

### 6.1 闭包枚举（`src/domain/childCapabilities.ts:1-74`）

```typescript
export const CHILD_SESSION_TYPES = [
  "one_shot_delegation",
  "ephemeral_conversation",
  "event_awaited_worker",
  "user_voice_reporter",
  "event_publisher",
] as const;

export const TRIGGER_KINDS = [
  "session", "human", "watchdog", "scheduler", "skill_master", "eventbus_subscriber", "self_curl",
] as const;

export const POST_IDENTITIES = ["bot", "user", "caller_default"] as const;

export const CALLER_INVOCATIONS = ["sync_inline", "async_kickoff", "fire_and_forget"] as const;

export const CONTINUATION_HOOKS = ["none", "inject_result"] as const;
```

每种枚举均配有类型守卫函数：`isChildSessionType`、`isTriggerKind`、`isPostIdentity`、`isCallerInvocation`、`isContinuationHook`。

### 6.2 ResultSink（`src/domain/childCapabilities.ts:38-44`）

结果投递目标是带 `kind` 标签的联合类型：

| `kind` | 专属字段 | 行为 |
|--------|----------|------|
| `http_response` | 无 | sync_inline 模式的 HTTP 响应（无引擎投递） |
| `pollable_endpoint` | 无 | 通过 `GET /api/sessions/:id/result` 轮询 |
| `chat_post` | `chatRef: ChatRef; identity: "bot" | "user"` | 发送到指定飞书群 |
| `eventbus_publish` | `topic: string` | 发布到 `TopicBus` |
| `parent_continuation_inject` | `parentSessionId: SessionId` | 将结果注入父会话 inbox |
| `audit_only` | 无 | 只记录到 `cross_session_log` |

### 6.3 ChatRef（`src/domain/childCapabilities.ts:32-36`）

```typescript
type ChatRef =
  | { kind: "parent" }
  | { kind: "requester" }
  | { kind: "reply_to" }
  | { kind: "explicit"; chatId: string };
```

- `parent`: 投递到父会话绑定的群
- `requester`: 投递到发起请求的会话绑定的群
- `reply_to`: 投递到原始消息来源群
- `explicit`: 显式指定群 ID

### 6.4 EventBusContract（`src/domain/childCapabilities.ts:46-49`）

```typescript
type EventBusContract = {
  subscribe: string | null;
  subscribeGatesCompletion: boolean;
};
```

- `subscribe`: 等待的 topic 名称；`event_awaited_worker` 要求非空
- `subscribeGatesCompletion`: 若 true，topic 到达是完成 child 的必要条件；否则 topic 仅作为通知

### 6.5 CapabilityPayload（`src/domain/childCapabilities.ts:51-54`）

```typescript
type CapabilityPayload = {
  resultSinks: ResultSink[];
  eventBusContract?: EventBusContract;
};
```

**派生约束**（`src/app/childSession.ts:172-196`）：
1. `resultSinks` 必须非空数组
2. `event_awaited_worker` 必须声明 `eventBusContract.subscribe`
3. `event_awaited_worker` 禁止 `callerInvocation = "sync_inline"`

### 6.6 ChildSessionPolicy（`src/app/childSessionPolicy.ts:11-101`）

每种 `ChildSessionType` 的派生策略：

| 策略维度 | 默认值 | 说明 |
|----------|--------|------|
| `maxBusyChildrenPerParent` | 5 | 每父会话最大活跃子会话数 |
| `maxIdleChildrenPerParent` | 0 | 每父会话最大空闲子会话数（仅 `ephemeral_conversation` 有意义） |
| `maxRuntimeSec` | 1800 (30min) | 单次运行硬超时 |
| `staleIdleTtlSec` | 3600 (60min) | idle/error 子会话清理阈值 |
| `maxDepth` | 3 | 从 root 起的最大派生深度 |

各类型显式覆盖：
- `event_awaited_worker`: `maxRuntimeSec = 3600` (1h)
- `user_voice_reporter`: `maxRuntimeSec = 600` (10min)
- `event_publisher`: `maxRuntimeSec = 600` (10min)

环境变量 `SM_CHILD_MAX_RUNTIME_SEC` 可覆盖继承默认值的类型的 `maxRuntimeSec`；显式覆盖的类型不受影响。[源码锚点] `src/app/childSessionPolicy.ts:74-87`。


---

## 7. 端口接口

Ports 层纯接口定义，零实现。以下按文件给出接口契约、调用方与实现方。

### 7.1 AgentBackend.ts

| 接口 | 方法 | 调用方 | 实现方 | 关键不变式 |
|------|------|--------|--------|------------|
| `AgentBackend` | `run(input: RunInput): AsyncIterable<AgentEvent>` | Dispatcher, runOnSession, childSession | `backend-claude`, `backend-codex`, `backend-kimi` | 必须异步可迭代；取消后 stream 应终止 |
| `AgentBackend` | `cancel(sessionId: SessionId): Promise<void>` | ProcessLifecycle, childSession (timeout) | 同上 | 幂等；对已终止进程不抛异常 |
| `BackendRegistry` | `get(kind): AgentBackend` | Dispatcher, childSession | `src/cli/bootstrap.ts` 组装 | 返回的 backend 必须与 `kind` 匹配 |
| `BackendRegistry` | `cancel(sessionId): Promise<void>` | ProcessLifecycle | 同上 | 向所有 backend 广播 cancel，由匹配者执行 |

`RunInput.answerOnly`（`src/ports/AgentBackend.ts:19`）是外部会话信任边界的关键开关：当非 owner 用户 @bot 时，该标志置为 `true`，强制 backend 以 `--ephemeral` / no-tool 模式运行，防止内部代码泄露。[源码锚点] `src/app/dispatcher.ts:570-573`。

### 7.2 BindingStore.ts

这是框架中最大的端口，包含 50+ 个方法。按职责分组：

**Session CRUD**
- `createSession`, `findSessionById`, `findSessionByName`, `listAllSessions`, `listActiveSessions`
- `updateSessionStatus`, `updateSessionModel`, `updateSessionEffort`, `updateSessionThinking`, `updateSessionModelLocked`
- `updateSessionBackend`, `updateSessionBackendSessionId`, `updateSessionInactivityTimeout`, `updateSessionMaxRuntime`

**Binding**
- `createBinding`, `findByGroup`, `findBySession`, `deleteBinding`
- `createSessionWithBinding`（事务性创建 session + binding）
- `deleteSessionAndBinding`（级联删除）

**MessageRun**
- `startMessageRun`, `finishMessageRun`, `setMessageRunCardId`
- `findRunningMessageRunBySession`, `findLatestMessageRunBySession`, `listRecentCompletedMessageRuns`
- `markMessageRunTimeout`

**TokenUsage**
- `recordTokenUsage`, `getLatestTokenUsageRawTotals`, `getTokenUsageSummary`

**Child Session 维护**
- `countActiveChildrenByParent`
- `cleanupStaleChildSessions`, `cleanupErroredChildSessions`, `cleanupStuckBusyChildren`

**CrossSessionComm & Spawn 断言**
- `logCrossSessionComm`, `finishCrossSessionComm`, `listCrossSessionComms`
- `createSpawnPredicate`, `patchSpawnPredicate`, `listOpenSpawnPredicates`
- `upsertWatcherState`, `getWatcherState`, `registerSpawnAsyncItem`, `recordWatcherException`
- `recordResultSinkAttempt`, `listResultSinkAttemptsBySpawn`

**实现方**: `store-sqlite`（`src/adapters/store-sqlite/`）
**调用方**: `sessionLifecycle`, `dispatcher`, `childSession`, `apiServer`, `spawnClosure` 等 App 层模块。

**关键不变式**：
1. `createSessionWithBinding` 必须原子性创建 session 与 binding，失败时回滚。
2. `updateSessionStatus` 必须同时更新 `updatedAt` 字段（由 adapter 保证）。
3. `finishMessageRun` 的 `streamLogJson` 参数可为 undefined；adapter 在 migration 降级时写 NULL。

### 7.3 Clock.ts

```typescript
export type Clock = { now(): Timestamp };
```

- **实现方**: `src/adapters/clock-real.ts`（`Date.now()`）、测试 fake（固定返回值）
- **调用方**: 几乎所有 App 层模块
- **不变式**: 返回值必须是单调不减的有限整数

### 7.4 CodexModelCatalog.ts

模块级状态（非实例接口），维护 Codex 可用模型列表：

```typescript
export function setCodexModelCatalog(models: readonly string[], source: CodexModelCatalogSource): void;
export function getCodexDefaultModel(): string;
export function isKnownCodexModel(model: string): boolean;
export function setCodexEffectiveDefaultModel(model: string): void;
```

- **实现方**: 自身（模块级内存状态）
- **调用方**: `bootstrap.ts`（启动时从 OpenAI API 拉取模型列表）、`setModel` 命令处理器
- **不变式**: `cachedModels` 永不为空；若外部输入为空数组，回退到 `LAST_RESORT_CODEX_DEFAULT_MODEL = "gpt-5.5"`

### 7.5 EventBus.ts

```typescript
export type EventBus = {
  publish(event: SessionEvent): Promise<void>;
  subscribe(kinds: SessionEvent["kind"][], handler: EventHandler): Unsubscribe;
  start(): Promise<void>;
  stop(): Promise<void>;
};
```

- **实现方**: `event-bus-memory.ts`
- **调用方**: `sessionLifecycle`, `dispatcher`, `childSession`
- **不变式**: `subscribe` 返回的 `Unsubscribe` 函数调用后，handler 不再接收新事件；已排队的事件可能仍被投递

### 7.6 LarkGateway.ts

飞书交互端口，15 个方法：

| 方法 | 语义 |
|------|------|
| `start(handler)` | 启动 WebSocket 事件监听 |
| `stop()` | 停止监听 |
| `sendMessage(groupId, text, identity?)` | 发送纯文本；`identity="user"` 时以用户身份发送 |
| `postCard` / `updateCard` / `finalizeCard` | 卡片生命周期 |
| `createGroup` / `inviteUser` / `dissolveGroup` / `renameGroup` / `getGroupName` | 群管理 |

- **实现方**: `lark-cli` adapter（`src/adapters/lark-cli/`）
- **调用方**: `dispatcher`, `sessionLifecycle`, `replier`
- **关键不变式**: `finalizeCard` 的 `runStatus` 参数是卡片颜色/标题的权威信号；不传时 adapter 会回退到文本嗅探，可能误报

### 7.7 Logger.ts

```typescript
export type Logger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
};
```

- **实现方**: `pino` wrapper（`src/adapters/logger-pino.ts`）
- **调用方**: 全框架
- **不变式**: `child()` 返回的新 logger 必须继承父级字段，并与新增字段合并

### 7.8 PredicateDbRegistry.ts

```typescript
export type PredicateDbRegistry = {
  resolve(dbRef: string): PredicateDbConnection | undefined;
};
```

- **实现方**: `src/adapters/predicateDbRegistry.ts`
- **调用方**: Spawn 断言评估器（`spawnPredicate/`）
- **不变式**: `resolve` 返回 undefined 时，评估器应报告 `permanent_fail`

### 7.9 Scheduler.ts

```typescript
export type Scheduler = {
  addTask(input: NewTaskInput): Promise<ScheduledTask>;
  removeTask(id: string): Promise<void>;
  listTasks(): Promise<ScheduledTask[]>;
  pauseTask(id: string): Promise<void>;
  resumeTask(id: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
```

- **实现方**: `scheduler` 服务（外部 HTTP 服务，非本仓库实现）
- **调用方**: `sessionLifecycle`（创建 session 时同步任务到 scheduler）

### 7.10 TopicBus.ts

```typescript
export type TopicBus = {
  publish(topic: string, payload: unknown): Promise<void>;
  subscribe(topic: string, handler: TopicHandler, options?: TopicSubscribeOptions): TopicUnsubscribe;
  recent(topic: string): TopicPayload[];
};
```

- **实现方**: `topic-bus-memory.ts`
- **调用方**: `childSession`（`event_awaited_worker` 的 topic 等待）、`resultSinkEngine`（`eventbus_publish` sink）
- **关键不变式**: `subscribe` 默认 `replay: true`，即新订阅者会收到该 topic 的近期保留消息。这是为了解决 "publisher 先于 subscriber 完成" 的竞态。

### 7.11 WorkspaceFs.ts

```typescript
export type WorkspaceFs = {
  exists(path: AbsolutePath): Promise<boolean>;
  mkdir(path: AbsolutePath): Promise<void>;
  rmrf(path: AbsolutePath): Promise<void>;
  readFile(path: AbsolutePath): Promise<string>;
  writeFile(path: AbsolutePath, content: string): Promise<void>;
  copyFile(src: AbsolutePath, dest: AbsolutePath): Promise<void>;
  symlink(target: AbsolutePath, linkPath: AbsolutePath): Promise<void>;
  listDir(path: AbsolutePath): Promise<string[]>;
  gitInit(workdir: AbsolutePath): Promise<void>;
  gitCommit(workdir: AbsolutePath, message: string, paths: AbsolutePath[]): Promise<void>;
};
```

- **实现方**: `workspace-node.ts`（Node.js `fs` + `child_process`）
- **调用方**: `sessionLifecycle`（scaffold 工作区）
- **关键不变式**: `gitCommit` 的 `paths` 参数为空数组时，仍然创建 `--allow-empty` 提交；绝不会执行 `git add -A`，以保护嵌套仓库

### 7.12 processLister.ts

```typescript
export type ProcessLister = {
  list(filter: ListFilter): Promise<ProcessInfo[]>;
  killAll(pids: number[]): Promise<number[]>;
  getCommand(pid: number): Promise<string | null>;
  getProcessInfo(pid: number): Promise<{ pid: number; ppid: number; cmd: string } | null>;
};
```

- **实现方**: `processLister-node.ts`（`ps` 命令解析）
- **调用方**: `bootSelfCheck`（孤儿进程清理）、`processLifecycle`（graceful stop）
- **关键不变式**: `killAll` 先发送 SIGTERM，等待 2 秒，对仍未终止的进程发送 SIGKILL；返回实际被 kill 的 PID 列表

---

## 8. 校验规则

### 8.1 Session 名称（`src/app/sessionLifecycle.ts:52`）

```typescript
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/u;
```

- 首字符必须为字母或数字
- 后续字符可为字母、数字、下划线、连字符
- 总长度 1-40 字符
- 使用 `u` flag 支持 Unicode（虽然实际字符集为 ASCII 子集）

[源码锚点] `src/app/sessionLifecycle.ts:90-92`：校验失败抛出 `UserError`，消息为中文说明。

### 8.2 SessionCategory（`src/domain/session.ts:37-38`）

```typescript
export const SESSION_CATEGORIES = ["", "业务", "平台", "工具", "知识", "外部"] as const;
```

空字符串 `""` 表示 "未分类"，允许 child session 和迁移前的过渡状态。任何其他值在写入时被拒绝。[源码锚点] `src/domain/sessionMeta.ts:43-48` 的 `validateSessionCategory` 显式检查 `CATEGORY_VALUES.has(value)`，失败时抛出 `UserError`。

[测试对账] `tests/domain/sessionMeta.test.ts:74-87` 验证了六个合法值与两个非法值（`"框架"`、`"platform"`）。

### 8.3 BackendKind（`src/domain/session.ts:28`）

```typescript
export type BackendKind = "claude" | "codex" | "kimi";
```

闭包枚举，无运行时守卫函数。非法值在 SQLite 写入时由 `TEXT` 约束捕获，或在 adapter 层以 `SystemError` 抛出。

### 8.4 EffortLevel（`src/domain/session.ts:30`）

```typescript
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
```

### 8.5 Session Meta 字段校验（`src/domain/sessionMeta.ts`）

| 字段 | 校验器 | 规则 |
|------|--------|------|
| `avatar` | `validateSessionAvatar` | 空串 或 27 位 `[A-Za-z0-9]`（Bitable file_token） |
| `alias` | `validateSessionAlias` | 空串 或 ≤8 可见字符，不可含空白 / `/` / `\` / `|` |
| `category` | `validateSessionCategory` | 见 §8.2 |

[测试对账] `tests/domain/sessionMeta.test.ts` 覆盖了 avatar 的长度边界（26/27/28）、字符集（下划线被拒绝）、URL/路径/data URL 的拒绝；alias 的 CJK 长度边界（8/9）、禁止字符；category 的闭包枚举。

### 8.6 Child Session 类型守卫（`src/domain/childCapabilities.ts:56-74`）

所有 `isXxx` 函数模式一致：

```typescript
export function isChildSessionType(value: unknown): value is ChildSessionType {
  return typeof value === "string" && (CHILD_SESSION_TYPES as readonly string[]).includes(value);
}
```

这组守卫在 App 层用于 spawn 请求的输入校验：`isChildSessionType` 失败直接抛出 `UserError`。[源码锚点] `src/app/childSession.ts:172-173`。


---

## 9. 附件解析

`attachmentResolver.ts`（`src/domain/attachmentResolver.ts:12-41`）实现了一个三层的附件选择策略：

### 9.1 输入结构

```typescript
type ResolveInput = {
  prompt: string;
  current: AttachmentRef[];
  history: AttachmentRef[];
};
```

- `current`: 当前消息附带的附件
- `history`: 该 session 历史上传过的所有附件

### 9.2 三层选择逻辑

**第一层：当前消息优先**

若 `input.current.length > 0`，直接返回当前附件的副本。[源码锚点] `:13-15`。

**第二层：历史附件按文件名匹配**

遍历 `history`，检查 `prompt.toLowerCase()` 是否包含 `originalName.toLowerCase()`。若有匹配，返回所有匹配的附件（可能多个）。[源码锚点] `:17-21`。

**第三层：类型暗示词回退**

若前两步均未命中，检查 prompt 中的关键词：

| 关键词（不区分大小写） | 目标类型 | 选择策略 |
|------------------------|----------|----------|
| `图片`, `图`, `image`, `截图`, `photo`, `picture` | `image` | 取历史中最新的 1 张图片 |
| `附件`, `文件`, `file`, `pdf`, `word`, `excel`, `表格`, `文档` | `file` | 取历史中最新的 1 个文件 |

按 `uploadedAt` 降序排序后取 `[0]`。[源码锚点] `:23-38`。

**兜底**：无任何匹配时返回空数组 `[]`。

### 9.3 设计意图

1. **当前附件绝对优先**：用户显式上传的附件不应被历史附件稀释。
2. **文件名引用精确**：若用户说 "看看 report.pdf"，即使是很久以前的附件也应被召回。
3. **类型暗示兜底**：口语化的 "这张图什么意思" 应能自动关联到最新的截图，无需用户记忆文件名。
4. **不回退到全部历史**：绝不返回整个历史附件列表，防止上下文爆炸。

[测试对账] `tests/domain/attachmentResolver.test.ts:21-52` 覆盖了四层场景：
- `current` 非空时忽略 history（test 1）
- 历史文件名精确匹配（test 2）
- 中文类型暗示词取最新同类（test 3）
- 无匹配返回空（test 4）

---

## 10. 不变式清单

以下规则一旦被违反，将导致框架进入不可恢复或语义不一致的状态。

**I1. Session 名称唯一性**
`sessions.name` 在数据库层面有 `UNIQUE` 约束。尝试创建同名 session 会触发 `UserError("名称已存在")`。[源码锚点] `src/app/sessionLifecycle.ts:90-96`。

**I2. Binding 1:1 约束**
一个 `groupId` 只能绑定一个 session，一个 `sessionId` 也只能绑定一个群。`createSessionWithBinding` 必须在事务中原子执行。[源码锚点] `src/ports/BindingStore.ts:358-361`。

**I3. 依赖方向不可逆行**
Domain 层不能依赖 Ports、Adapters、App 或 CLI 层；Ports 层只能依赖 Domain 层。违反者被 `scripts/check-deps.ts` 拦截。[源码锚点] `scripts/check-deps.ts:7-14`。

**I4. Busy Session 的并发排斥**
当 `SessionStatus = "busy"` 时，该 session 不得接受新的 prompt。Dispatcher 在 `idle` -> `busy` 翻转前执行准入检查。[源码锚点] `src/app/dispatcher.ts:574-592`。

**I5. Child Session 的 Depth 单调性**
`child.depth = parent.depth + 1`，且不得超过 `policyForType(childType).maxDepth`（默认 3）。[源码锚点] `src/app/childSession.ts:214-216`。

**I6. Terminal Status 的权威性**
Child session run 完成后的目标状态必须由 `terminalStatusForChildType(childType)` 决定，不允许 ad-hoc 分支。[源码锚点] `src/app/childSession.ts:113-115`。

**I7. EventBus 的 Recent-Buffer 语义**
`TopicBus.subscribe` 必须默认 replay 近期保留消息，否则 `event_awaited_worker` 在 publisher 先于 subscriber 完成时将永远等待。[源码锚点] `src/ports/TopicBus.ts:12-15`, `:27-35`。

**I8. AbsolutePath 必须以 `/` 开头**
`asAbsolutePath` 拒绝相对路径。若相对路径进入 domain 层，`promptBuilder.ts` 的 `relDisplay` 会产生错误的 `./` 前缀，导致 backend 找不到附件。[源码锚点] `src/domain/ids.ts:18-20`, `src/domain/promptBuilder.ts:9-12`。

**I9. MessageRun 的 Status 与 Session Status 解耦**
`message_runs.status` 是运行级状态，`sessions.status` 是会话级状态。一个 session 可以在 `idle` 状态下拥有多条 `completed` 的 message_run；反之，`busy` 的 session 只能有一条 `running` 的 message_run。[源码锚点] `src/ports/BindingStore.ts:63`, `src/app/dispatcher.ts:578-585`。

**I10. External Non-Owner 的 Answer-Only 约束**
`category === "外部"` 且发送者非 owner 时，`RunInput.answerOnly` 必须为 `true`，且 backend 不得将本次运行的 `backendSessionId` 持久化到 session 行（否则下次 owner 运行时会因找不到 rollout 文件而失败）。[源码锚点] `src/app/dispatcher.ts:570-573`, `:644-648`。

**I11. Boot Reconcile 的孤儿进程清理**
进程重启后，`reconcileBackendProcesses` 必须标记所有孤儿 run 为 `timeout` 并 kill 对应 OS 进程，否则会出现 "DB 说 idle，但后台进程仍在写文件" 的幽灵状态。[源码锚点] `src/app/bootSelfCheck/checks/reconcileBackendProcesses.ts:84-111`。

**I12. SessionCatalog 排除 fpManaged=false**
`buildSessionCatalog` 必须过滤掉 `fpManaged === false` 的 session，否则 FP governance 范围会包含已显式排除的会话。[源码锚点] `src/domain/sessionCatalog.ts:34-44`。

---

## 11. 反例场景

以下场景描述了源码中已显式防御或已知的错误路径。每个场景包含：触发条件、违反的不变式、框架的防御行为、以及若防御失效的后果。

### 11.1 场景 A：同名 Session 重复创建

**触发条件**：用户在 root 群执行 `/new claude foo`，然后再次执行 `/new claude foo`。
**违反的不变式**：I1（名称唯一性）。
**防御行为**：`sessionLifecycle.create()` 在 scaffold 前检查 `store.findSessionByName(input.name)`，若存在则抛出 `UserError("名称已存在")`。[源码锚点] `src/app/sessionLifecycle.ts:90-96`。
**若防御失效**：SQLite 的 `UNIQUE` 约束会在 INSERT 时抛异常，被外层 catch 包装为 `SystemError`，用户看到 "内部错误" 而非友好提示，且已创建的目录/文件不会回滚。

### 11.2 场景 B：Child Session 深度超限

**触发条件**：Session A（depth=2, type=one_shot）通过 `/spawn` 创建子会话 B，B 又试图创建 C。
**违反的不变式**：I5（Depth 单调性）。
**防御行为**：`spawnChild` 计算 `childDepth = parent.depth + 1`，与 `policyForType.maxDepth` 比较，超限抛出 `UserError`。[源码锚点] `src/app/childSession.ts:214-216`。
**若防御失效**：无限深度的派生链将导致工作目录和 DB 行爆炸；`revertBusyOnSetupFailure` 等机制会因递归过深而栈溢出。

### 11.3 场景 C：Busy Session 被 /restart 打断

**触发条件**：用户在 session 正在执行 run 时发送 `/restart` 命令。
**违反的不变式**：I4（Busy 并发排斥）。
**防御行为**：`reset()` 和 `restart()` 在开头检查 `session.status === "busy"`，若是则抛出 `UserError("session 正在运行，请等待完成或先 /cancel")`。[源码锚点] `src/app/sessionLifecycle.ts:341-344`。
**若防御失效**：`/restart` 会清空 `backendSessionId` 并将状态翻为 `idle`，但 backend 进程仍在运行。当该 run 最终完成时，dispatcher 的 `wasCleared` 检查（`afterRun?.backendSessionId === null && afterRun?.status === "idle"`）会阻止状态复活，但 stream 结果可能覆盖 `/restart` 后的新上下文，导致数据不一致。

### 11.4 场景 D：Event-Awaited Worker 的 Topic 先到达后订阅

**触发条件**：`event_awaited_worker` 在第一 run 完成前，目标 topic 已被发布。
**违反的不变式**：I7（TopicBus Recent-Buffer）。
**防御行为**：`TopicBus.subscribe` 默认 `replay: true`，实现方 `InMemoryTopicBus` 保留每个 topic 的近期消息 ring buffer，新 subscriber 会先收到缓冲消息再进入 live 模式。[源码锚点] `src/ports/TopicBus.ts:12-15`, `:27-35`。
**若防御失效**：Child session 进入 `waiting` 后永远不会收到已错过的 topic，在 `maxRuntime`（默认 1 小时）后超时进入 `error` 状态。结果 sinks 不会被投递，父会话的 continuation 注入也不会触发。

### 11.5 场景 E：外部非 Owner 获取内部附件

**触发条件**：`category="外部"` 的群中，非 owner 用户发送一条带附件图片的消息并 @bot。
**违反的不变式**：I10（External Non-Owner 的 Answer-Only 约束）。
**防御行为**：`dispatcher.ts` 在处理消息时，若检测到 `isExternalNonOwner`，将 `attachments` 设为空数组，确保附件不会进入 backend prompt。[源码锚点] `src/app/dispatcher.ts:415-449`（外部会话信任边界）。
**若防御失效**：外部用户可通过图片中的 prompt injection 或 backend 的 Read 工具读取工作目录中的敏感文件，突破信任边界。

### 11.6 场景 F：Boot 后孤儿进程未清理

**触发条件**：SuperMatrix 进程在 session 处于 `busy` 状态时崩溃并重启。
**违反的不变式**：I11（Boot Reconcile 的孤儿进程清理）。
**防御行为**：`bootstrap.ts` 在 post-wiring 阶段调用 `reconcileBackendProcessesCheck`。该检查对比 DB 中 `status="busy"` 的 session 与实际 OS 进程列表。对孤儿进程：标记关联 message_run 为 `timeout`，发送 SIGTERM/SIGKILL。[源码锚点] `src/app/bootSelfCheck/checks/reconcileBackendProcesses.ts:84-111`。
**若防御失效**：孤儿 Claude/Codex 进程会持续持有文件句柄和端口；当用户稍后 `/restart` 或发送新 prompt 时，可能因端口冲突或 rollout 文件被锁而失败。

### 11.7 场景 G：Kimi 附件路径为相对路径

**触发条件**：Kimi backend adapter 错误地生成了相对路径的 `localPath`。
**违反的不变式**：I8（AbsolutePath 必须以 `/` 开头）。
**防御行为**：`asAbsolutePath` 在附件入库前执行校验；`promptBuilder.ts` 使用 `path.relative(resolve(workdir), resolve(localPath))` 计算相对显示路径。[源码锚点] `src/domain/ids.ts:18-20`, `src/domain/promptBuilder.ts:9-12`。
**若防御失效**：若相对路径绕过校验进入 `RunInput.attachments`，Kimi backend 可能因找不到文件而报错；`promptBuilder` 的 `rel.startsWith("..")` 检查可能错误地将其判定为在工作区内，生成 `./../outside/file` 等危险路径。

---

## 12. 附录：术语与源码索引

| 术语 | 定义 | 主要源码位置 |
|------|------|--------------|
| Session | 基本工作单元 | `src/domain/session.ts` |
| SessionId | Branded string | `src/domain/ids.ts:1` |
| BackendKind | `"claude" / "codex" / "kimi"` | `src/domain/session.ts:28` |
| SessionStatus | 六状态枚举 | `src/domain/session.ts:12-18` |
| ChildSessionType | 五类型枚举 | `src/domain/childCapabilities.ts:3-10` |
| ResultSink | 结果投递目标 | `src/domain/childCapabilities.ts:38-44` |
| AgentEvent | Backend 流事件 | `src/domain/events/agentEvent.ts` |
| SessionEvent | 框架生命周期事件 | `src/domain/events/sessionEvent.ts` |
| AttachmentRef | 附件引用 | `src/domain/attachment.ts:5-13` |
| MessageRun | 单次执行记录 | `src/ports/BindingStore.ts:95-106` |
| CrossSessionComm | 跨会话通信 | `src/ports/BindingStore.ts:159-189` |
| BindingStore | 最大端口接口 | `src/ports/BindingStore.ts:323-435` |
| TopicBus | 命名主题 pub/sub | `src/ports/TopicBus.ts` |
| UserError | 用户可纠正错误 | `src/domain/errors.ts:8` |
| SystemError | 基础设施错误 | `src/domain/errors.ts:10-16` |
| NAME_RE | 会话名称正则 | `src/app/sessionLifecycle.ts:52` |
| SESSION_CATEGORIES | 分类闭包 | `src/domain/session.ts:37-38` |

---

*文档结束。所有声明均基于实际源码，未引入假设。如需更新，请同步修改源码与本文档的锚点。*
