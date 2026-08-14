# Adapters 深度 PRD

> 本文档是 SuperMatrix 反向工程 PRD 的 Adapters 层深度展开。必须与 `00-skeleton.md` 的术语表和架构总览保持一致。
> 版本: v1.0-draft
> 日期: 2026-05-20
> 源码锚定: 基于 SuperMatrix 主仓库 commit 范围 ce32f76 及之前

---

## 1. Backend 对比矩阵

SuperMatrix 同时支持 Claude、Codex、Kimi 三种 Backend，它们共享同一个 `AgentBackend` 接口 [源码锚点] `src/ports/AgentBackend.ts:22-26`，但在进程模型、流协议、会话恢复等维度上存在本质差异。

| 维度 | Claude Backend | Codex Backend | Kimi Backend |
|------|----------------|---------------|--------------|
| **进程模型** | 每 turn 独立子进程 (`claude -p`) | 每 turn 独立子进程 (`codex exec`) | 单 ACP 进程，session 多路复用 |
| **会话恢复** | `--resume <backendSessionId>` | `exec resume <threadId>` | `loadSession()` + ACP sessionId |
| **超时控制** | inactivityTimeout + maxRuntime | inactivityTimeout + maxRuntime | 仅 maxRuntime（默认 600s） |
| **Token usage** | 实时 per-turn usage（assistant 信封） | 累积式，需 coarse/rich normalize | ACP 不承载 usage，无 usage 事件 |
| **附件支持** | `--file` 路径 + native image blocks (`--input-format stream-json`) | `--image <FILE>` + `--` option terminator | content blocks 文本内联描述 |
| **错误处理** | stderr 或 exit code → error 事件 | stderr noise 过滤 + stdout JSON error 事件 | ACP 异常 → error 事件 |
| **环境注入** | `SM_SESSION_NAME` | `SM_SESSION_NAME` + proxy 大小写 normalize | 无额外 env 注入 |
| **answerOnly 模式** | `--permission-mode default`（跳过 resume） | `--sandbox read-only --ephemeral` | dispatcher 层处理，backend 无感知 |
| **流协议** | JSON-RPC stream-json（每行一个 JSON） | JSON-RPC NDJSON（每行一个 JSON） | ACP over NDJSON（@zed-industries/agent-client-protocol） |

**关键差异解释**:

- **Claude 与 Codex 的进程模型一致**，均为每 turn spawn 新子进程，通过 `detached: true` 和 `child.unref()` 避免阻塞主进程 [源码锚点] `src/adapters/backend-claude/process.ts:31-35`、`src/adapters/backend-codex/process.ts:66-71`。这使得取消操作只需 kill 当前子进程即可。
- **Kimi 的进程模型截然不同**：`AcpClient` 在首次 `ensureReady()` 时 lazy-spawn 一个 `kimi acp` 子进程，所有 session 共享该进程，通过 `sessionId` 在 ACP 协议层多路复用 [源码锚点] `src/adapters/backend-kimi/acpClient.ts:48-65`。这要求 KimiBackend 维护 `loadedAcpSessions` 集合来追踪哪些 ACP session 已在当前进程中加载 [源码锚点] `src/adapters/backend-kimi/index.ts:25`。
- **Token usage 差异最大**：Claude 在 assistant 信封中实时携带 per-turn usage，可直接流式累加；Codex 的 usage 分布在 `turn.completed`（coarse）和 `token_count`（rich）两种来源中，需要通过 pendingTurnUsage 机制做 coarse/rich merge 和 dedup [源码锚点] `src/adapters/backend-codex/streamParser.ts:380-417`；Kimi 的 ACP 协议完全不携带 usage 信息，因此 KimiBackend 不会产生 `usage` 类型的 AgentEvent [源码锚点] `src/adapters/backend-kimi/eventTranslator.ts:15-16`。

[测试对账] `tests/adapters/backend-claude/index.test.ts`、`tests/adapters/backend-codex/index.test.ts`、`tests/adapters/backend-kimi/index.test.ts`

---

## 2. Claude Backend

### 2.1 整体架构

`ClaudeBackend` 实现 `AgentBackend` 接口，核心依赖两个模块：
- `commandBuilder.ts`：将 `RunInput` 转换为 `claude` CLI 参数和可选的 stdin JSON
- `process.ts`：`spawnAndStream` 负责子进程生命周期、超时控制、流解析

[源码锚点] `src/adapters/backend-claude/index.ts:15-73`

### 2.2 spawnAndStream 的实现

`spawnAndStream` 是 Claude 和 Codex 共享的底层模式（各自有独立副本但结构几乎相同）。核心流程：

1. **子进程创建**：`spawn(opts.command, opts.args, { detached: true, stdio: [pipe/ignore, pipe, pipe] })` [源码锚点] `src/adapters/backend-claude/process.ts:27-32`
2. **Unref 子进程**：`child.unref()` 防止子进程阻止父进程退出 [源码锚点] `src/adapters/backend-claude/process.ts:35`
3. **队列 + waiter 模式**：维护一个 `AgentEvent[]` 队列和一个单消费者 Promise waiter，实现 push-driven async iterable [源码锚点] `src/adapters/backend-claude/process.ts:37-54`
4. **双重超时**：
   - `inactivityTimeoutMs`：自上次 stdout data 事件后无输出的超时，每次 `data` 事件重置计时器 [源码锚点] `src/adapters/backend-claude/process.ts:85-100`
   - `maxRuntimeMs`：自进程启动起的绝对超时 [源码锚点] `src/adapters/backend-claude/process.ts:102-115`
5. **取消机制**：`cancel()` 设置 `cancelled = true`，kill 进程，并在 close 时推送 `error({ message: "cancelled by user" })` [源码锚点] `src/adapters/backend-claude/process.ts:186-192`、`src/adapters/backend-claude/process.ts:154-156`

### 2.3 SIGTERM → SIGKILL Fallback

`killProcess()` 函数实现优雅终止的 fallback 链：

```
1. process.kill(-child.pid, "SIGTERM")   // 负 PID = 杀进程组（含 node wrapper + Go binary）
2. 若失败 → child.kill("SIGTERM")         // 直接杀子进程
3. graceMs（默认 3000ms）后：
   process.kill(-child.pid, "SIGKILL")   // 强制杀进程组
4. 若失败 → child.kill("SIGKILL")         // 强制杀子进程
```

[源码锚点] `src/adapters/backend-claude/process.ts:67-83`

**为什么需要进程组？** 因为 `lark-cli` 和 `kimi` 等 CLI 工具内部可能还有 Go binary 的 wrapper，直接杀 node 子进程会留下孤儿进程持有 Feishu 单实例 subscribe 锁或 ACP 连接。

[测试对账] `tests/adapters/backend-claude/process.test.ts:56-75`

### 2.4 Stream Parser：JSON-RPC 碎片、ANSI 转义、系统事件

`parseClaudeStream` 是状态机驱动的行级解析器，核心状态 `ClaudeStreamState` 跨 chunk 共享（这是关键设计——否则每个 data chunk 都会重新 emit `started`） [源码锚点] `src/adapters/backend-claude/streamParser.ts:13-27`。

**解析流程（按优先级排序）**：

1. **system 类型**：缓存 `model` 和 `thinking` 配置，首次提取到 `session_id` 时 emit `started` [源码锚点] `src/adapters/backend-claude/streamParser.ts:49-75`
2. **assistant 类型**：解析 `message.content` 数组，text block → `thinking` 事件，tool_use block → `tool_call` 事件；同时提取 `message.usage` 作为 per-turn usage [源码锚点] `src/adapters/backend-claude/streamParser.ts:81-121`
3. **user 类型**：解析 `tool_result` block → `tool_result` 事件 [源码锚点] `src/adapters/backend-claude/streamParser.ts:124-143`
4. **rate_limit_event**：静默跳过（不生成事件）[源码锚点] `src/adapters/backend-claude/streamParser.ts:146-149`
5. **error 类型**：emit `error` 事件 [源码锚点] `src/adapters/backend-claude/streamParser.ts:152-157`
6. **result 类型**：emit `assistant_message(final=true)` + `completed`；usage 仅在之前未 emit 过 assistant usage 时才 emit（避免 double-count）[源码锚点] `src/adapters/backend-claude/streamParser.ts:160-184`
7. **delta fallback**：兼容旧版 synthetic fixtures [源码锚点] `src/adapters/backend-claude/streamParser.ts:188-192`
8. **无 type 但含 session_id**：仍 emit `started` [源码锚点] `src/adapters/backend-claude/streamParser.ts:195-206`

**Usage double-count 防护**：
- `state.usageEmitted` 标记：一旦从 assistant 记录 emit 过 usage，result 记录的 usage 就不再 emit [源码锚点] `src/adapters/backend-claude/streamParser.ts:17-22`
- 这是必要的，因为 Claude 的 result.usage 是 run-level 总和，而 assistant.message.usage 是 per-turn 累加值；如果两者都 emit，下游 replier 的累加器会把它们相加，导致数字翻倍。

[测试对账] `tests/adapters/backend-claude/streamParser.test.ts`

### 2.5 Command Builder

`buildClaudeCommand` 的核心逻辑：

- 基础参数：`-p --output-format stream-json --verbose --permission-mode bypassPermissions` [源码锚点] `src/adapters/backend-claude/commandBuilder.ts:36-47`
- answerOnly 模式：permission-mode 改为 `default`，且跳过 `--resume` [源码锚点] `src/adapters/backend-claude/commandBuilder.ts:43-57`
- resume 逻辑：非 answerOnly 且存在 `backendSessionId` 时追加 `--resume` [源码锚点] `src/adapters/backend-claude/commandBuilder.ts:55-57`
- 模型解析：`session.model ?? env.SM_CLAUDE_DEFAULT_MODEL ?? "claude-opus-4-7"` [源码锚点] `src/adapters/backend-claude/commandBuilder.ts:48-50`
- effort 支持：`--effort <effort>` [源码锚点] `src/adapters/backend-claude/commandBuilder.ts:51-53`
- 附件处理：
  - Native image：当 `SM_CLAUDE_NATIVE_IMAGE` 未禁用且 attachment kind 为 image 时，读取文件转 base64，构造 ClaudeImageBlock，通过 stdin 以 `--input-format stream-json` 发送 [源码锚点] `src/adapters/backend-claude/commandBuilder.ts:61-128`
  - 非 image 附件：通过 `buildPromptWithAttachments` 将路径嵌入 prompt 文本 [源码锚点] `src/adapters/backend-claude/commandBuilder.ts:117`
- Native image 限制：单文件 ≤ 5MB，仅支持 jpeg/png/gif/webp [源码锚点] `src/adapters/backend-claude/commandBuilder.ts:7-13`

[测试对账] `tests/adapters/backend-claude/commandBuilder.test.ts`

---

## 3. Codex Backend

### 3.1 与 Claude 的差异概述

CodexBackend 的整体结构与 ClaudeBackend 高度对称（均使用 spawnAndStream + streamParser + commandBuilder），但在以下维度有显著差异：

| 差异点 | Claude | Codex |
|--------|--------|-------|
| 命令结构 | `claude -p <prompt>` | `codex exec [resume <id>] --json <prompt>` |
| resume 参数 | `--resume <id>` | `exec resume <id>` |
| 沙箱控制 | `--permission-mode` | `--dangerously-bypass-approvals-and-sandbox` / `--sandbox read-only --ephemeral` |
| effort 映射 | `--effort <value>` | `-c model_reasoning_effort=<value>`（max→xhigh） |
| 图片附件 | stdin JSON native blocks | `--image <FILE>` CLI 参数 |
| 模型解析 | env + fallback | `resolveCodexRunModel`（含 `defaultModelResolver.ts`） |
| 代理大小写 | 无 | `normalizeCodexChildEnv` 同步 http_proxy/HTTP_PROXY 等 |

[源码锚点] `src/adapters/backend-codex/commandBuilder.ts:9-52`、`src/adapters/backend-codex/process.ts:43-60`

### 3.2 Token Usage 累积 normalize

Codex 的 usage 信息分布在两种来源中，需要复杂的归一化逻辑：

1. **`turn.completed` 事件**：携带 `usage` 对象，包含 `input_tokens`、`cached_input_tokens`、`output_tokens`
2. **`event_msg.payload.type === "token_count"` 事件**：携带更丰富的 `info.last_token_usage`，包含 `reasoning_output_tokens` 和 `model_context_window`

**问题**：同一个 turn 可能同时收到 coarse（turn.completed）和 rich（token_count）两种 usage 记录，且它们可能交错到达。Parser 需要：

- 不重复 emit 同一个 turn 的 usage
- 当 rich 和 coarse 描述同一个 turn 时，优先使用 rich（因为它有 reasoningTokens 和 contextWindow）
- 当一个新 turn 的 usage 到达时，commit 上一个 pending turn 的 usage

**实现机制** [源码锚点] `src/adapters/backend-codex/streamParser.ts:380-492`：

- `PendingTurnUsage` 结构：`{ coarse?: ParsedTurnUsage; rich?: ParsedTurnUsage }`
- `appendUsage(state, usage)`：
  - 如果 incoming 是 `token_count`（rich）：
    - 若 pending.rich 存在且数值相同 → 忽略（duplicate）
    - 若 pending.coarse 存在且属于 same turn → 将 rich 存入 pending，不 emit
    - 否则 → commit pending，新建 pending.rich
  - 如果 incoming 是 `turn.completed`（coarse）：
    - 若 pending.rich 存在且属于 same turn → 将 coarse 存入 pending，不 emit
    - 若 pending.coarse 存在且数值相同 → 忽略
    - 否则 → commit pending，新建 pending.coarse
- `isSameTurn(a, b)`：比较 `rawOutputTokens`，且 input/cache 兼容（相等或其中一个为 0）
- `isSameTurnUsage(a, b)`：严格比较所有四个字段
- `mergePendingTurnUsage`：取 rich/coarse 中各字段的最大值，outputTokens 需减去 reasoningTokens（因为 raw output 包含 reasoning）
- `flush: true` 时：emit pending agent message + commit pending usage

**outputTokens 计算**：
```
outputTokens = reasoningTokens > 0 ? Math.max(0, rawOutputTokens - reasoningTokens) : rawOutputTokens
```
[源码锚点] `src/adapters/backend-codex/streamParser.ts:361-362`

这是必要的，因为 Codex 的 `output_tokens` 字段在存在 reasoning 时包含了 reasoning tokens，而 SuperMatrix 的 usage 模型希望 outputTokens 仅表示模型输出的文本 token。

[测试对账] `tests/adapters/backend-codex/tokenUsage.test.ts`、`tests/adapters/backend-codex/streamParser.test.ts:223-303`

### 3.3 defaultModelResolver

Codex 没有内置的默认模型环境变量（不像 Claude 有 `SM_CLAUDE_DEFAULT_MODEL`）。`defaultModelResolver.ts` 在 boot self-check 阶段主动探测：

- 执行 `codex debug models --bundled`（实验性子命令，T800 确认）
- 解析 JSON，筛选 `visibility === "list"` 且 `supported_in_api === true` 的模型
- 按 `priority` 升序排序，取第一个作为框架默认模型
- 任何解析失败都返回 `{ kind: "fail", error: ... }`，不阻塞启动

[源码锚点] `src/adapters/backend-codex/defaultModelResolver.ts:34-94`

`resolveCodexRunModel(model)` 在运行时把持久化模型解析为「显式模型或 `null`」（持久化刻意保留 `model=null`）；`resolveCodexExecutionModel(model)` = `resolveCodexRunModel(model) ?? getCodexDefaultModel()`，在 CLI 调用时把已验证的 effective default 钉成实际执行模型 [源码锚点] `src/adapters/backend-codex/commandBuilder.ts:12-25`。

[测试对账] `tests/adapters/backend-codex/defaultModelResolver.test.ts`

### 3.4 Codex 特有的 stderr 过滤

Codex CLI 0.128.0 在每次 `exec` 启动时都会向 stderr 打印 `"Reading additional input from stdin..."`（信息性，非错误）。当 Codex 因 API 错误退出非零时，该行会污染 stderrBuf，曾导致错误消息被掩盖。

解决方案：`filterKnownCodexStderrNoise` 精确匹配（非 startsWith）移除该行 [源码锚点] `src/adapters/backend-codex/process.ts:16-24`。close handler 中的逻辑：如果 stdout 已经通过 JSON stream 报告了真实错误（`sawError = true`），且过滤后的 stderr 为空，则不再追加低信息的 `exit ${code}` 事件 [源码锚点] `src/adapters/backend-codex/process.ts:193-208`。

[测试对账] `tests/adapters/backend-codex/process.test.ts`

---

## 4. Kimi Backend

### 4.1 ACP 协议集成

KimiBackend 是 SuperMatrix 中唯一不基于 JSON-RPC per-line 流的后端。它使用 Zed Industries 的 Agent Client Protocol（ACP），通过 `@zed-industries/agent-client-protocol` 包实现。

**ACP 连接生命周期** [源码锚点] `src/adapters/backend-kimi/acpClient.ts:48-200`：

1. `ensureReady()`：idempotent 初始化，首次调用时 spawn `kimi acp` 子进程
2. `start()`：
   - 若提供 `opts.streams`（测试注入），直接使用；否则 spawn 子进程
   - 将 Node.js 的 Readable/Writable 转换为 Web Streams：`Writable.toWeb(nodeStdin)` / `Readable.toWeb(nodeStdout)`
   - 调用 `ndJsonStream(webOutput, webInput)` 创建 ACP 流
   - 实例化 `ClientSideConnection`，注册三个 handler：
     - `sessionUpdate`：路由到当前 prompt 的 `onUpdate` callback
     - `requestPermission`：自动批准，优先选择 `approve_for_session`
     - `readTextFile/writeTextFile/createTerminal`：throw Error（SuperMatrix 不 advertise 这些能力）
   - 调用 `conn.initialize({ protocolVersion: 1, clientCapabilities: {} })`
3. 失败处理：init 失败时重置 `readyP = null`，使下次 `ensureReady()` 可重试；同时打印 stderr 前 2000 字符到 console.error [源码锚点] `src/adapters/backend-kimi/acpClient.ts:187-198`

**ACP 消息路由**：`updateRouters` Map 将 `sessionId` 映射到 `onUpdate` callback。`prompt()` 方法在调用前注册路由，在 finally 中删除路由，确保不会将更新投递到已结束的 prompt [源码锚点] `src/adapters/backend-kimi/acpClient.ts:213-224`。

[测试对账] `tests/adapters/backend-kimi/acpClient.test.ts`

### 4.2 单进程多路复用

与 Claude/Codex 的 per-turn 子进程不同，KimiBackend 的所有 session 共享一个 ACP 进程：

- `KimiBackend` 持有单个 `AcpClient` 实例 [源码锚点] `src/adapters/backend-kimi/index.ts:24`
- `loadedAcpSessions: Set<string>` 追踪哪些 ACP session 已在当前进程中加载 [源码锚点] `src/adapters/backend-kimi/index.ts:25`
- 首次 run：调用 `acp.newSession({ cwd })` 创建新 ACP session，emit `started` 事件 [源码锚点] `src/adapters/backend-kimi/index.ts:55-58`
- 恢复 run：若 `backendSessionId` 存在但不在 `loadedAcpSessions` 中，调用 `acp.loadSession({ sessionId, cwd })` [源码锚点] `src/adapters/backend-kimi/index.ts:59-65`
- **H2 互斥锁**：`sessionLocks` Map 实现 per-session 的 newSession/loadSession 串行化，防止同一 session 的并发 run 导致 ACP 状态竞争 [源码锚点] `src/adapters/backend-kimi/index.ts:29-69`

[测试对账] `tests/adapters/backend-kimi/index.test.ts:58-84`

### 4.3 ensureReady 机制

`AcpClient.ensureReady()` 是一个多态的 idempotent 初始化门：

- `state === "ready"`：直接返回
- `state === "dead"`：throw Error（已 dispose）
- `readyP` 存在：返回已有 Promise（防止并发初始化）
- `ensureReadyLock` 存在：返回当前 lock Promise（防止重复进入 start）
- 否则：设置 lock，调用 `start()`，成功后 `state = "ready"`

[源码锚点] `src/adapters/backend-kimi/acpClient.ts:69-80`

### 4.4 eventTranslator 的 update 类型映射

`eventTranslator.ts` 将 ACP `session/update` 的 `update` 对象翻译为 SuperMatrix `AgentEvent`。

**观察到的 ACP update 类型**（来自 T0 fixtures，kimi-cli 1.37.0） [源码锚点] `src/adapters/backend-kimi/eventTranslator.ts:5-14`：

| ACP update 类型 | SuperMatrix 事件 | 说明 |
|-----------------|------------------|------|
| `agent_message_chunk` | 不立即 emit，累积到 `pendingAssistant` | 回答文本片段 |
| `agent_thought_chunk` | 不立即 emit，累积到 `pendingThinking` | 思考文本片段 |
| `tool_call` | `tool_call` | 工具调用开始 |
| `tool_call_update` | 视 status：completed/failed → `tool_result` | 工具状态更新 |
| `available_commands_update` | 忽略 | 命令列表更新 |

**flushTranslator** 在 prompt 完成时调用（`stopReason` 来自 `PromptResponse`）：

1. 先 emit 累积的 `pendingThinking` 为 `thinking` 事件
2. 若 `stopReason === "cancelled"`：emit `error` + `completed(finalMessage="")`
3. 若 `pendingAssistant` 非空：emit `assistant_message(final=true)` + `completed`
4. 若 session 已 announced 但无内容：emit `error("kimi returned empty completion")`

[源码锚点] `src/adapters/backend-kimi/eventTranslator.ts:96-127`

**关键设计**：ACP 不区分 "thinking" 和 "assistant_message" 的流式边界，所有文本 chunk 都通过 `agent_message_chunk` / `agent_thought_chunk` 传递。SuperMatrix 在 flush 时才将累积的文本转换为事件。这与 Claude/Codex 的即时 emit 模式不同。

**工具调用映射**：
- `tool_call` update 含 `toolCallId` 和 `title` → `tool_call` 事件，`args: {}`（ACP 不 stream 参数）
- `tool_call_update` 含 `status: completed/failed` → `tool_result` 事件，`result.output` 从 content 数组提取，`exitCode` 由 status 决定 [源码锚点] `src/adapters/backend-kimi/eventTranslator.ts:64-90`

[测试对账] `tests/adapters/backend-kimi/eventTranslator.test.ts`

### 4.5 Kimi Backend 与 Claude/Codex 的对比总结

| 维度 | Kimi | Claude/Codex |
|------|------|--------------|
| 进程数/turn | 0（共享单进程） | 1（独立子进程） |
| 取消语义 | `acp.cancel(sessionId)`（协议级） | `kill(child.pid)`（OS 级） |
| usage 支持 | ❌ 无 | ✅ 有 |
| 附件支持 | 文本内联描述 | native image / `--file` / `--image` |
| 流式粒度 | chunk 累积后 flush | 即时 line-by-line emit |
| 错误恢复 | ensureReady 可重试 | 每次 run 都是新进程，天然无状态 |
| 会话恢复 | `loadSession()`（需 ACP 支持） | `--resume` / `resume` CLI 参数 |

---

## 5. 飞书网关（LarkCliGateway）

### 5.1 架构分层

Lark 适配器分为三层：
- `LarkCliGateway`（`index.ts`）：实现 `LarkGateway` port，编排 inbound/outbound 逻辑
- `LarkSdkClient`（`client.ts`）：纯 TypeScript 接口定义
- `createRealLarkClient`（`realClient.ts`）：基于 `lark-cli` 子进程的真实实现

[源码锚点] `src/adapters/lark-cli/index.ts:23-131`、`src/adapters/lark-cli/client.ts:6-30`、`src/adapters/lark-cli/realClient.ts:620-1067`

### 5.2 WebSocket 订阅

`subscribeInbound` 通过持续 spawn `lark-cli event +subscribe` 子进程实现 WebSocket 长连接：

```bash
lark-cli event +subscribe \
  --as bot \
  --event-types im.message.receive_v1,card.action.trigger \
  --compact --quiet
```

[源码锚点] `src/adapters/lark-cli/realClient.ts:882-890`

**关键设计**：
- `detached: true`：创建独立进程组，stop 时可通过负 PID kill 整个树（node wrapper + Go binary）
- 自动重连：子进程异常退出时按指数退避重连（2s → 4s → 8s ... 最大 30s）
- 双防 echo 机制：
  1. **Primary**：outbound ID tracking。所有 sendText/sendCard 返回的 `message_id` 记录在 `outboundIds` Set 中（LRU，最大 500 条），subscribe callback 中通过 `outboundIds.delete(messageId)` 跳过自消息 [源码锚点] `src/adapters/lark-cli/realClient.ts:628-638`
  2. **Secondary**：`sender_type === "app"` 时直接跳过（但 `--compact` 可能缺失该字段，因此 ID tracking 才是可靠机制）

[源码锚点] `src/adapters/lark-cli/realClient.ts:873-1067`

### 5.3 消息解析

`subscribeInbound` 的 line handler 解析流程：

1. 跳过空行和以 `[` 开头的行（lark-cli 的日志前缀）
2. JSON parse
3. `eventType === "card.action.trigger"` → `extractCardActionMessage` → 构造 `LarkRawMessage`，text 前缀为 `CARD_ACTION:`
4. `eventType === "im.message.receive_v1"` → 常规消息解析：
   - 提取 `messageId`、`chat_id`、`sender_id`、`content`、`timestamp`
   - `@bot` 检测：`eventMentionsBot` 多层次匹配（mentions 数组、inline at tag、compact `@_user_` 占位符），必要时通过 `fetchMessageDetail` 回查 [源码锚点] `src/adapters/lark-cli/realClient.ts:652-667`
   - 附件提取：`extractAttachments` 支持四种格式：`<file key name>`、`<image key>`、`[Image: img_xxx]`、`{"image_key":"xxx"}` [源码锚点] `src/adapters/lark-cli/realClient.ts:107-171`
   - merge_forward 扩展：通过 `+messages-mget` 获取父消息，提取 `<forwarded_messages>` 包装器内的 transcript，按 30 行/4000 字符截断 [源码锚点] `src/adapters/lark-cli/realClient.ts:173-246`
   - 纯图片/文件消息：将 content 替换为 `[用户发送了图片]` / `[用户发送了文件]` 占位符

[源码锚点] `src/adapters/lark-cli/realClient.ts:942-1038`

### 5.4 附件下载

附件在 `handleRaw` 中不立即下载，而是包装为 lazy `fetch()` 函数：

```typescript
fetch: async () => {
  await mkdir(dir, { recursive: true });
  const safeName = `${raw.messageId}_${att.originalName.replace(/[^\w.\-]/gu, "_")}`;
  const localPath = join(dir, safeName) as AbsolutePath;
  await deps.client.downloadAttachment({ messageId, fileKey, type, destPath: localPath });
  return { localPath };
}
```

[源码锚点] `src/adapters/lark-cli/index.ts:56-72`

**下载实现**：`lark-cli im +messages-resources-download --as bot --message-id <id> --file-key <key> --type <image|file> --output <filename>`，cwd 设为附件目录 [源码锚点] `src/adapters/lark-cli/realClient.ts:842-871`。下载后校验文件非空。

### 5.5 卡片操作（create/update/finalize）

**create**：`postCard` 发送 schema 2.0 的 interactive message，header template 初始为 `blue`，body 含单个 markdown element。返回 `message_id` 作为 `CardId` [源码锚点] `src/adapters/lark-cli/realClient.ts:794-800`。

**update**：`updateCard` 通过 PATCH `/open-apis/im/v1/messages/{message_id}` 更新卡片内容。带 2 秒节流（throttle），避免高频流更新触发 Feishu 限流 [源码锚点] `src/adapters/lark-cli/realClient.ts:802-814`。

**finalize**：`finalizeCard` 是卡片的最终状态更新，包含三层降级策略：

1. **First attempt**：PATCH 完整卡片（含 processLog 折叠面板）
2. **Retry without log**：若第一次失败且存在 processLog，尝试不带 processLog 的 PATCH（processLog 是最常见的超限来源）
3. **Fallback to text**：若两次 PATCH 均失败，发送纯文本消息（卡片 header 会 stuck 在 running，但至少用户能看到结果）

[源码锚点] `src/adapters/lark-cli/realClient.ts:586-618`、`src/adapters/lark-cli/realClient.ts:816-840`

**Card JSON Schema 2.0** [源码锚点] `src/adapters/lark-cli/realClient.ts:544-578`：
- `schema: "2.0"`
- `config.wide_screen_mode: true`
- Header：title + template（blue/green/red/grey）
- Body：markdown element + 可选的 collapsible_panel（stream log）
- processLog 截断：最大 20,000 字符，超限后追加 `…(已截断 stream log，完整请看 DB message_run)` [源码锚点] `src/adapters/lark-cli/realClient.ts:529-536`

**template 选择**：
- `completed` → green
- `failed/timeout` → red
- `cancelled` → grey
- `running` → blue
- 若未提供 runStatus，则以文本前缀判断：`text.startsWith("❌") ? red : green`

[源码锚点] `src/adapters/lark-cli/realClient.ts:511-523`

### 5.6 P2P 拒绝策略

`handleRaw` 中显式拒绝私聊消息：

```typescript
if (raw.chatType === "p2p") {
  deps.logger.info("ignored p2p message", { userId: raw.userId });
  await deps.client.sendText(asLarkGroupId(raw.groupId), "⚠️ 私聊不可用，请在对应的群组中使用命令");
  return;
}
```

[源码锚点] `src/adapters/lark-cli/index.ts:42-50`

这是产品层面的安全决策：所有 SuperMatrix 操作必须在群组上下文中进行，以确保会话归属和审计可追溯。

[测试对账] `tests/adapters/lark-cli/index.test.ts:161-186`

---

## 6. SQLite Store

### 6.1 整体架构

`SqliteBindingStore` 实现 `BindingStore` port，是 SuperMatrix 唯一的持久化层。依赖：
- `db.ts`：`better-sqlite3` 封装，启用 WAL 和 foreign_keys
- `migrations.ts`：基于文件的 migration 系统
- `rowMappers.ts`：DB row → Domain `Session` 对象的映射

[源码锚点] `src/adapters/store-sqlite/index.ts:52-1604`、`src/adapters/store-sqlite/db.ts:1-10`、`src/adapters/store-sqlite/migrations.ts:1-95`、`src/adapters/store-sqlite/rowMappers.ts:1-142`

### 6.2 所有 public 方法的 SQL 语句与参数映射

#### 6.2.1 Session CRUD

**createSession** [源码锚点] `src/adapters/store-sqlite/index.ts:78-116`：
```sql
INSERT INTO sessions
(id, name, alias, avatar, category, scope, backend, model, workdir,
 backend_session_id, purpose, status, parent_id, depth,
 inactivity_timeout_s, max_runtime_s, child_type, trigger_kind,
 post_identity, caller_invocation, continuation_hook, capability_payload,
 heartbeat_enabled, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'initializing', ?, ?, NULL, NULL,
        ?, ?, ?, ?, ?, ?, ?, ?, ?)
```
参数：`id, name, alias, avatar, category, scope, backend, model, workdir, purpose, parentId, depth, childType, triggerKind, postIdentity, callerInvocation, continuationHook, capabilityPayload(JSON), heartbeatEnabled, createdAt, createdAt`

注意：`backend_session_id` 初始为 NULL（resume 后才更新）；`chat_name` 列已冻结（FP v1.0 contract §4），新行不写入 [源码锚点] `src/adapters/store-sqlite/index.ts:81-88`。

**createSessionWithBinding** [源码锚点] `src/adapters/store-sqlite/index.ts:353-396`：
使用 `db.transaction()` 包裹 sessions INSERT + bindings INSERT，保证原子性。

**deleteSessionAndBinding** [源码锚点] `src/adapters/store-sqlite/index.ts:398-418`：
```sql
-- transaction:
DELETE FROM bindings WHERE session_id = ?;
UPDATE sessions SET status = 'deleted', updated_at = ? WHERE id = ?;
UPDATE sessions SET status = 'deleted', updated_at = ?
WHERE parent_id = ? AND scope = 'child' AND status NOT IN ('deleted', 'error');
```
第三句是 child session 的级联软删除（应用层实现，非 ON DELETE CASCADE）。

**findSessionById** [源码锚点] `src/adapters/store-sqlite/index.ts:118-123`：
```sql
SELECT * FROM sessions WHERE id = ?
```

**findSessionByName** [源码锚点] `src/adapters/store-sqlite/index.ts:125-130`：
```sql
SELECT * FROM sessions WHERE name = ? OR alias = ?
```

**listAllSessions** [源码锚点] `src/adapters/store-sqlite/index.ts:132-136`：
```sql
SELECT * FROM sessions ORDER BY created_at ASC
```

**listActiveSessions** [源码锚点] `src/adapters/store-sqlite/index.ts:138-151`：
```sql
SELECT * FROM sessions WHERE status != 'deleted' AND scope != 'child' ORDER BY created_at ASC
```
明确排除 child sessions（内部执行单元，不应出现在 /list 和 /status 中）。

**updateSessionStatus** [源码锚点] `src/adapters/store-sqlite/index.ts:168-173`：
```sql
UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?
```

**updateSessionBackendSessionId** [源码锚点] `src/adapters/store-sqlite/index.ts:233-238`：
```sql
UPDATE sessions SET backend_session_id = ?, updated_at = ? WHERE id = ?
```

#### 6.2.2 Binding

**createBinding** [源码锚点] `src/adapters/store-sqlite/index.ts:318-323`：
```sql
INSERT INTO bindings (group_id, session_id, created_at) VALUES (?, ?, ?)
```

**findByGroup / findBySession** [源码锚点] `src/adapters/store-sqlite/index.ts:325-347`：
```sql
SELECT * FROM bindings WHERE group_id = ?
SELECT * FROM bindings WHERE session_id = ?
```

#### 6.2.3 Message Run

**startMessageRun** [源码锚点] `src/adapters/store-sqlite/index.ts:465-500`：
```sql
INSERT INTO message_runs
(id, session_id, group_id, prompt, card_id, started_at, finished_at, status,
 final_message, error_message, sender_id)
VALUES (?, ?, ?, ?, NULL, ?, NULL, 'running', NULL, NULL, ?)
```
存在退化路径：若 `sender_id` 列不存在（migration 回滚），则使用 10 列版本。

**finishMessageRun** [源码锚点] `src/adapters/store-sqlite/index.ts:502-536`：
```sql
UPDATE message_runs
SET status = ?, finished_at = ?, final_message = ?, error_message = ?, stream_log = ?
WHERE id = ?
```
同样存在退化路径：若 `stream_log` 列不存在，使用 4 列 UPDATE。

**findRunningMessageRunBySession** [源码锚点] `src/adapters/store-sqlite/index.ts:562-594`：
```sql
SELECT * FROM message_runs
WHERE session_id = ? AND status = 'running'
ORDER BY started_at DESC LIMIT 1
```

**listRecentCompletedMessageRuns** [源码锚点] `src/adapters/store-sqlite/index.ts:630-668`：
```sql
SELECT * FROM message_runs
WHERE session_id = ? AND status = 'completed'
  AND prompt != '' AND final_message IS NOT NULL AND final_message != ''
ORDER BY started_at DESC LIMIT ?
```

#### 6.2.4 Token Usage

**recordTokenUsage** [源码锚点] `src/adapters/store-sqlite/index.ts:872-894`：
```sql
INSERT OR IGNORE INTO token_usage
(session_id, message_run_id, backend, model,
 input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
 raw_usage_json, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```
使用 `INSERT OR IGNORE` 防止重复记录。

**getTokenUsageSummary** [源码锚点] `src/adapters/store-sqlite/index.ts:817-870`：
这是 Store 中最复杂的 SQL，使用 Recursive CTE 遍历 session 的所有后代：
```sql
WITH RECURSIVE descendants(id) AS (
  SELECT id FROM sessions WHERE id = ?
  UNION ALL
  SELECT s.id FROM sessions s JOIN descendants d ON s.parent_id = d.id
)
SELECT
  COALESCE(SUM(CASE WHEN tu.created_at >= ? THEN tu.input_tokens ELSE 0 END), 0) AS today_input,
  -- ... 共 15 个 today/week/all 聚合列
FROM token_usage tu
WHERE tu.session_id IN (SELECT id FROM descendants)
```
参数：sessionId + 6 个 todayStart + 6 个 weekStart。

#### 6.2.5 Cross Session / Spawn Predicate

**logCrossSessionComm** [源码锚点] `src/adapters/store-sqlite/index.ts:952-962`：
```sql
-- transaction (when spawnPredicate provided):
INSERT INTO cross_session_log (...)
INSERT INTO spawn_predicates (...)
```

**patchSpawnPredicate** [源码锚点] `src/adapters/store-sqlite/index.ts:1044-1118`：
```sql
-- transaction:
SELECT p.*, c.from_session_id, c.to_session_id FROM spawn_predicates p
LEFT JOIN cross_session_log c ON c.id = p.spawn_comm_id WHERE p.spawn_comm_id = ?
UPDATE spawn_predicates SET predicate_json = ?, predicate_hash = ?, version = ?,
  last_patched_by_session_id = ?, updated_at = ? WHERE spawn_comm_id = ?
INSERT INTO spawn_predicate_patches (...) VALUES (...)
SELECT COUNT(*) AS c FROM spawn_predicate_patches
WHERE spawn_comm_id = ? AND created_at >= ?
INSERT INTO watcher_state (...) ON CONFLICT(spawn_comm_id) DO UPDATE SET ...
```

### 6.3 事务策略

SqliteBindingStore 使用三种事务模式：

1. **隐式单语句**：大多数读操作和简单写操作（如 `UPDATE sessions SET status = ?`）不使用显式事务，依赖 SQLite 的 autocommit。
2. **`db.transaction()` 包裹**：`createSessionWithBinding`、`deleteSessionAndBinding`、`logCrossSessionComm`、`patchSpawnPredicate` 等需要多语句原子性的操作使用 `better-sqlite3` 的 transaction API [源码锚点] `src/adapters/store-sqlite/index.ts:362-390`、`src/adapters/store-sqlite/index.ts:398-417`、`src/adapters/store-sqlite/index.ts:957-962`、`src/adapters/store-sqlite/index.ts:1046-1114`。
3. **WAL 模式**：`db.pragma("journal_mode = WAL")` 确保读写不互斥 [源码锚点] `src/adapters/store-sqlite/db.ts:7`。

### 6.4 迁移系统（migrations.ts）

#### 6.4.1 迁移文件组织

迁移文件位于 `migrations/` 目录，命名格式 `NNN_description.sql`（critical）或 `NNN_description.opt.sql`（optional）。当前共 29 个迁移（001~029）。

[源码锚点] `src/adapters/store-sqlite/migrations.ts:7-8`、`tests/adapters/store-sqlite/migrations.test.ts:7-15`

#### 6.4.2 执行流程

`applyMigrations(db)`：

1. `ensureVersionTable(db)`：若 `schema_version` 表不存在则创建
2. 读取 `schema_version` 中已应用的版本号
3. 列出所有 `.sql` 文件，排序后分为 critical 和 optional
4. **Pass 1**：执行 critical 迁移，失败 throw（boot 终止）
5. **Pass 2**：执行 optional 迁移，失败记录到 `degraded` 数组但不 throw
6. 返回 `{ degraded }`

[源码锚点] `src/adapters/store-sqlite/migrations.ts:23-57`

#### 6.4.3 isAlreadyApplied 逻辑

`runOne` 执行单个迁移时：

```typescript
try {
  const tx = db.transaction(() => {
    db.exec(sql);
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(version, Date.now());
  });
  tx();
} catch (err) {
  if (isAlreadyApplied(err)) {
    // Schema is already at target state, just missing version record — backfill
    db.prepare("INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)")
      .run(version, Date.now());
    return;
  }
  throw err;
}
```

`isAlreadyApplied` 检查错误消息是否匹配以下模式：
- `/duplicate column name:/i`
- `/table .+ already exists/i`

[源码锚点] `src/adapters/store-sqlite/migrations.ts:13-21`、`src/adapters/store-sqlite/migrations.ts:59-83`

**意义**：这处理了 schema drift 场景——当 DBA 手动执行过 ALTER TABLE 但忘记更新 `schema_version` 时，迁移不会失败，而是自动补录版本记录。这是 production 环境中常见的运维容错。

[测试对账] `tests/adapters/store-sqlite/migrations.test.ts:30-44`

#### 6.4.4 可选迁移的降级语义

Optional 迁移（`.opt.sql`）用于非破坏性的增强功能：
- `008_cross_session_log_sync_tracking.opt.sql`：添加 `synced_at`、`bitable_record_id` 列
- `010_cross_session_log_full_message.opt.sql`：添加 `final_message` 列
- `016_stream_log.opt.sql`：添加 `stream_log` 列到 `message_runs`

如果这些迁移失败（例如因为列已存在但被手动删除），Store 提供退化路径：
- `hasStreamLogColumn()` 和 `hasSenderIdColumn()` 通过 `PRAGMA table_info` 运行时探测列存在性 [源码锚点] `src/adapters/store-sqlite/index.ts:538-556`
- `finishMessageRun` 和 `startMessageRun` 根据探测结果选择 SQL 语句

---

## 7. 文件系统（NodeWorkspaceFs）

### 7.1 职责与接口

`NodeWorkspaceFs` 实现 `WorkspaceFs` port，提供基于 Node.js `fs/promises` 的文件系统抽象。它是 session 脚手架和操作文件系统的唯一入口。

[源码锚点] `src/adapters/workspace-node/index.ts:11-69`

### 7.2 git init 实现

`gitInit` 调用 `runGit(workdir, ["init", "-q"])` [源码锚点] `src/adapters/workspace-node/index.ts:55-57`。`runGit` 的实现：

```typescript
const fullArgs = [
  ...(identity ? ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`] : []),
  ...args,
];
spawn("git", fullArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
```

[源码锚点] `src/adapters/workspace-node/git.ts:8-28`

identity 在构造函数中从 `NodeWorkspaceFsOptions` 传入，默认值为 `gitUserName` 和 `gitUserEmail`。

### 7.3 gitCommit 实现

`gitCommit` 的工作流程：

1. 若 `paths.length > 0`：执行 `git add -- <paths...>`（显式路径，避免扫到嵌套 repo）
2. 执行 `git commit --allow-empty -m <message>`

[源码锚点] `src/adapters/workspace-node/index.ts:59-68`

**关键设计**：`git add -- <paths>` 而非 `git add -A`。这避免了 deepsearch 失败模式——当工作目录中存在仅含 `.git/` 目录（无 checkout）的嵌套 repo 时，`git add -A` 会 fatal。显式路径确保只提交预期的文件。

[测试对账] `tests/adapters/workspace-node/index.test.ts:52-73`

### 7.4 symlink、copyFile、writeFile

- `symlink(target, linkPath)`：直接调用 `fs.promises.symlink` [源码锚点] `src/adapters/workspace-node/index.ts:47-49`
- `copyFile(src, dest)`：直接调用 `fs.promises.copyFile` [源码锚点] `src/adapters/workspace-node/index.ts:43-45`
- `writeFile(path, content)`：`utf8` 编码写入 [源码锚点] `src/adapters/workspace-node/index.ts:39-41`
- `readFile(path)`：`utf8` 编码读取 [源码锚点] `src/adapters/workspace-node/index.ts:35-37`
- `exists(path)`：`access` 封装，catch 返回 false [源码锚点] `src/adapters/workspace-node/index.ts:18-25`
- `mkdir(path)`：`recursive: true` [源码锚点] `src/adapters/workspace-node/index.ts:27-29`
- `rmrf(path)`：`recursive: true, force: true` [源码锚点] `src/adapters/workspace-node/index.ts:31-33`
- `listDir(path)`：`readdir` 封装 [源码锚点] `src/adapters/workspace-node/index.ts:51-53`

### 7.5 Session 脚手架步骤

Session 创建时的文件系统脚手架（在 `sessionLifecycle.ts` 中调用，非 adapter 内部实现但依赖 adapter 方法）：

1. `mkdir(sessionWorkdir)`
2. `gitInit(sessionWorkdir)`
3. `writeFile(.gitignore, ...)`
4. `symlink(sessionCatalogPath, join(workdir, "session-catalog.json"))`
5. `symlink(templatePath, join(workdir, "console-principles.md"))`（同理 coding/business）
6. `writeFile(CLAUDE.md, renderedTemplate)`
7. `writeFile(AGENTS.md, renderedTemplate)`
8. `mkdir(join(workdir, "sop"))`
9. `writeFile(sop/INDEX.md, ...)`
10. `symlink(sopTemplatePath, join(workdir, "sop/TEMPLATE.md"))`
11. `gitCommit(sessionWorkdir, "bootstrap session", [...allPaths])`

[源码锚点] `00-skeleton.md` 文件系统布局章节、`src/app/sessionLifecycle.ts:89-294`

---

## 8. 事件总线

### 8.1 InMemoryEventBus 的发布订阅模型

`InMemoryEventBus` 实现 `EventBus` port，用于 session 生命周期事件的发布订阅（如 `session_created`、`session_deleted`）。

**核心数据结构** [源码锚点] `src/adapters/event-bus-memory/index.ts:10-16`：
- `subs: Set<Subscription>`：所有订阅者，每个 Subscription 包含 `kinds: Set<SessionEvent["kind"]>` 和 `handler: EventHandler`
- `queue: SessionEvent[]`：事件队列
- `draining: boolean`：是否正在 drain
- `running: boolean`：是否已 start

**publish** [源码锚点] `src/adapters/event-bus-memory/index.ts:18-23`：
- 若未 start，直接返回（静默丢弃）
- 将事件推入 queue
- 若未在 drain，触发 `void this.drain()`（不 await，publish 立即返回）

**drain** [源码锚点] `src/adapters/event-bus-memory/index.ts:42-63`：
- `setTimeout(r, 0)` 将处理推迟到 macrotask，确保 publish() 先返回
- 按 FIFO 顺序处理 queue 中的事件
- 对每个事件，遍历所有订阅者，匹配 `sub.kinds.has(event.kind)`
- handler 错误被捕获并记录，不传播（不影响其他订阅者）
- drain 完成后重置 `draining = false`

**subscribe** [源码锚点] `src/adapters/event-bus-memory/index.ts:25-31`：
- 返回 unsubscribe 函数（从 `subs` Set 中删除）

**关键特性**：
- publish 是 fire-and-forget，handler 在下一个 macrotask 执行
- 单线程顺序处理：queue 中的事件按顺序 drain，但不同事件之间不保证 handler 完成顺序
- 无持久化：stop() 时直接清空 queue

[测试对账] `tests/adapters/event-bus-memory/index.test.ts`

### 8.2 InMemoryTopicBus 的 ring buffer 与 replay

`InMemoryTopicBus` 实现 `TopicBus` port，用于 topic 发布订阅（如 spawn 结果投递、event_awaited_worker 的 topic gate）。

**核心数据结构** [源码锚点] `src/adapters/topic-bus-memory/index.ts:20-25`：
- `subs: Map<string, Set<TopicHandler>>`：topic → handlers
- `buffers: Map<string, TopicPayload[]>`：topic → retention buffer
- `bufferPerTopic`：默认 64，单 topic 最大保留消息数

**publish** [源码锚点] `src/adapters/topic-bus-memory/index.ts:31-65`：
1. 构造 `TopicPayload { topic, payload, publishedAtMs }`
2. **先写入 retention buffer**：`buf.push(msg)`，若超限则 `splice(0, buf.length - bufferPerTopic)` 丢弃最旧的
3. 再 fan-out 到 live subscribers
4. handler 错误被捕获，不影响其他 subscriber

**subscribe** [源码锚点] `src/adapters/topic-bus-memory/index.ts:67-103`：
1. 注册 handler 到 `subs`
2. 若 `replay !== false`，异步 replay buffer 中的所有历史消息
3. replay 使用 `buf.slice()` 快照，防止并发修改问题
4. 返回 unsubscribe 函数

**recent(topic)** [源码锚点] `src/adapters/topic-bus-memory/index.ts:105-107`：
返回 buffer 的浅拷贝，用于诊断或轮询。

**关键设计**：
- **buffer-first**：先写 buffer 再 fan-out，确保在 write 和 fan-out 之间新 subscribe 的 handler 仍能通过 replay 看到该消息
- **ring buffer**：固定大小，防止内存泄漏
- **异步 replay**：`subscribe()` 返回后才 fire replay handler，避免 caller 在赋值 unsubscribe 函数前就被回调
- **topic 隔离**：不同 topic 完全独立

[测试对账] `tests/adapters/topic-bus-memory/index.test.ts`

---

## 9. 其他 Adapters

### 9.1 Logger Pino

`createPinoLogger` 包装 `pino` 库，将 `Logger` port 的调用风格（`(msg, fields?)`）映射到 pino 的 `(fields, msg)` 风格。

- 支持自定义 `sink` 函数（用于测试捕获）
- `child(fields)` 返回嵌套 logger

[源码锚点] `src/adapters/logger-pino/index.ts:12-41`

[测试对账] `tests/adapters/logger-pino/index.test.ts`

### 9.2 Process Lister (ps)

`createPsProcessLister` 基于 `/bin/ps` 命令实现进程列表：

- `list(filter)`：`ps -e -o pid=,ppid=,command=`，按 `cmdPattern`、`ppid`、`cwdPrefix` 过滤
- `extractBackendSessionId(cmd)`：正则匹配 `--resume <uuid>` 或 `resume <uuid>`，用于 boot reconcile
- `killAll(pids)`：SIGTERM → 等待 2s → 对仍存在的进程 SIGKILL
- `getCwd(pid)`：通过 `/usr/sbin/lsof -a -p <pid> -d cwd -Fn` 获取进程工作目录

[源码锚点] `src/adapters/process-lister-ps/index.ts:1-99`

[测试对账] `tests/adapters/process-lister-ps/index.test.ts`

### 9.3 Predicate DB Registry

`loadSqlitePredicateDbRegistry` 从 JSON 文件加载 spawn watcher 的断言数据库注册表：

- 默认路径：`/Users/LOCAL_USER/SuperMatrixRuntime/config/spawn-watcher-db-registry.json`
- 仅支持 `kind: "sqlite"` 的条目
- 支持 `path` 或 `path_env` 解析数据库路径
- 默认 `readonly: true`

[源码锚点] `src/adapters/predicate-db/sqliteRegistry.ts:1-84`

---

## 10. 不变式清单

以下是在 Adapters 层必须维持的不变式。违反任何一条都可能导致框架行为异常。

1. **Hexagonal 依赖方向**: `adapters` 只能依赖 `adapters`、`ports`、`domain`。`scripts/check-deps.ts:7-14` 在 CI 中强制执行。

2. **Claude/Codex 子进程必须 unref**: `child.unref()` 必须在 spawn 后立即调用，否则 backend 子进程会阻止主进程退出 [源码锚点] `src/adapters/backend-claude/process.ts:35`、`src/adapters/backend-codex/process.ts:71`。

3. **Parser state 必须跨 chunk 共享**: `ClaudeStreamState` 和 `CodexStreamState` 由 `spawnAndStream` 创建并跨所有 `data` 事件复用。若每 chunk 新建 state，会导致 duplicate `started` 事件 [源码锚点] `src/adapters/backend-claude/process.ts:128`、`src/adapters/backend-codex/process.ts:161`。

4. **Claude usage double-count 防护**: 一旦从 assistant 记录 emit 过 usage，`state.usageEmitted = true`，result 记录的 usage 必须跳过。违反会导致 token usage 数字翻倍 [源码锚点] `src/adapters/backend-claude/streamParser.ts:17-22`、`src/adapters/backend-claude/streamParser.ts:178-182`。

5. **Kimi ACP session 加载互斥**: `KimiBackend.sessionLocks` 保证同一 session 的并发 run 不会同时调用 `newSession` 或 `loadSession`。违反可能导致 ACP 进程状态竞争 [源码锚点] `src/adapters/backend-kimi/index.ts:29-69`。

6. **Kimi ACP update 路由必须在 prompt finally 中清理**: `AcpClient.prompt` 的 finally 块必须调用 `updateRouters.delete(args.sessionId)`，否则 late update 会被投递到已结束的消费端 [源码锚点] `src/adapters/backend-kimi/acpClient.ts:213-224`。

7. **lark-cli 子进程必须使用 detached 模式**: `detached: true` 创建独立进程组，stop 时通过负 PID SIGTERM 杀整个树。违反会导致 lark-cli Go binary 孤儿进程持有 Feishu 单实例锁 [源码锚点] `src/adapters/lark-cli/realClient.ts:898-899`。

8. **卡片 finalize 的三层降级不可跳过**: PATCH with log → PATCH without log → text fallback。跳过 retry 会导致 oversized card 的 header stuck 在 running [源码锚点] `src/adapters/lark-cli/realClient.ts:586-618`。

9. **SQLite migration 的 critical/optional 区分**: critical 失败必须 throw（boot 终止），optional 失败必须 degrade。违反会导致 schema 不一致或启动阻塞 [源码锚点] `src/adapters/store-sqlite/migrations.ts:40-56`。

10. **WAL 模式必须启用**: `db.pragma("journal_mode = WAL")` 保证读写不互斥。若使用 DELETE journal mode，长查询会阻塞写入（如 message_run 更新），导致前端卡片更新卡顿 [源码锚点] `src/adapters/store-sqlite/db.ts:7`。

11. **EventBus drain 的 macrotask defer**: `await new Promise(r => setTimeout(r, 0))` 确保 publish() 在 handler 执行前返回。若改为同步执行，可能导致 publish 侧的死锁或重入问题 [源码锚点] `src/adapters/event-bus-memory/index.ts:44`。

12. **TopicBus buffer-first 顺序**: publish 必须先写 buffer 再 fan-out。违反会导致在 write 和 fan-out 之间 subscribe 的 handler 丢失该消息（无法通过 replay 补偿） [源码锚点] `src/adapters/topic-bus-memory/index.ts:38-45`。

---

## 11. 反例场景

以下场景展示了当 invariant 被违反或边界条件被触发时系统的行为。

### 11.1 反例 1：Claude parser state 未共享 → duplicate started 事件

**场景**：开发者错误地在每个 `data` 事件回调中重新 `createClaudeStreamState()`，而非复用同一个 state。

**后果**：Claude 的 stream-json 每行都含 `session_id`，导致每个 chunk emit 一个 `started` 事件。下游 replier 收到多个 `started` 后可能重复创建卡片或更新 backendSessionId。

**测试覆盖**：`tests/adapters/backend-claude/streamParser.test.ts:34-45` 明确测试了 shared state 的 dedup 行为。

### 11.2 反例 2：Codex token_count 与 turn.completed 交错 → usage 丢失或重复

**场景**：Codex CLI 在某个 turn 中先发送 `turn.completed`（coarse usage），后发送 `token_count`（rich usage）。如果 parser 的 `isSameTurn` 逻辑错误（例如严格比较 input_tokens 而不是兼容比较），会将同一 turn 误判为不同 turn，导致 duplicate usage event。

**后果**：下游 `replier.accumulateUsage` 将两个 usage 相加，token 数字虚高，可能影响计费或配额判断。

**测试覆盖**：`tests/adapters/backend-codex/streamParser.test.ts:278-303` 测试了 flush 时 rich 优先于 coarse 的 merge 行为。

### 11.3 反例 3：Kimi ACP 进程崩溃后未 dispose → 后续 run 永远挂起

**场景**：`kimi acp` 子进程因 OOM 被系统 kill，`AcpClient.state` 被 exit listener 设为 `"dead"`。但 `KimiBackend` 未调用 `dispose()`，而是继续尝试 `ensureReady()`。

**后果**：`ensureReady()` 检查 `state === "dead"` 时 throw Error [源码锚点] `src/adapters/backend-kimi/acpClient.ts:71`。若上层未捕获，该 backend 实例永久不可用，所有 Kimi session 的后续 run 都会失败。

**正确做法**：boot self-check 中的 `reconcileBackendProcessesCheck` 应检测死掉的 ACP 进程并重启；或在 `run()` 中捕获 `ensureReady()` 错误并触发重新初始化。

### 11.4 反例 4：lark-cli 卡片 PATCH 超限且无 fallback → 卡片 stuck 在 running

**场景**：一个长 scheduler run 产生 25,000 字符的 stream log。`finalizeCard` 的 PATCH 因 Feishu 卡片 payload 上限而失败，但代码未实现 retry-without-log 和 text fallback。

**后果**：卡片 header 永远显示 `blue`（running），用户看不到最终答案。同时因为 PATCH 失败，运行状态对终端用户不可见。

**实际修复**：`finalizeCardWithFallback` 函数实现了三层降级 [源码锚点] `src/adapters/lark-cli/realClient.ts:586-618`，且 `MAX_PROCESS_LOG_CHARS = 20_000` 截断了 log [源码锚点] `src/adapters/lark-cli/realClient.ts:529`。

[测试对账] `tests/adapters/lark-cli/realClient.test.ts:677-753`

### 11.5 反例 5：SQLite migration 回滚后 startMessageRun 崩溃

**场景**：运维将数据库回滚到 migration 015 之前的状态（无 `sender_id` 列），但应用代码版本仍期望 `sender_id` 存在。

**后果**：`startMessageRun` 的 INSERT 语句包含 `sender_id` 列，执行时 throw "no such column: sender_id"。

**实际防护**：`SqliteBindingStore` 通过 `hasSenderIdColumn()` 运行时探测列存在性，自动选择退化路径（10 列或 11 列 INSERT）[源码锚点] `src/adapters/store-sqlite/index.ts:465-500`、`src/adapters/store-sqlite/index.ts:548-556`。这允许应用在降级数据库上继续运行，只是丢失了 sender tracking 功能。

### 11.6 反例 6：TopicBus 无 buffer 时 late subscribe 丢失消息

**场景**：`spawnClosure` 的 `eventbus_publish` sink 在 child session 完成前 publish 结果到 topic。如果 `event_awaited_worker` 的 subscribe 发生在 publish 之后，且 TopicBus 没有 retention buffer...

**后果**：event_awaited_worker 永远收不到 topic 消息，卡在 `waiting` 状态直到超时。

**实际防护**：`InMemoryTopicBus` 默认保留 64 条消息，且 `subscribe` 默认 `replay: true` [源码锚点] `src/adapters/topic-bus-memory/index.ts:31-45`、`src/adapters/topic-bus-memory/index.ts:75-94`。只要 publish 和 subscribe 之间的时间差不超过 buffer 覆盖范围，late subscriber 仍能通过 replay 收到消息。

[测试对账] `tests/adapters/topic-bus-memory/index.test.ts:31-42`

---

## 12. 测试覆盖矩阵

| Adapter | 单元测试 | 集成测试 | 关键 fixture |
|---------|----------|----------|--------------|
| backend-claude | `tests/adapters/backend-claude/*.test.ts` | process.test.ts（spawn + cancel + timeout） | `samples/*.jsonl` |
| backend-codex | `tests/adapters/backend-codex/*.test.ts` | tokenUsage.test.ts（端到端 usage 入库） | `samples/*.jsonl` |
| backend-kimi | `tests/adapters/backend-kimi/*.test.ts` | acpClient.test.ts（PassThrough 交叉流） | `samples-acp/*.jsonl` |
| lark-cli | `tests/adapters/lark-cli/*.test.ts` | realClient.test.ts（fake lark-cli 子进程） | 内联 JSON |
| store-sqlite | `tests/adapters/store-sqlite/*.test.ts` | port.test.ts（类型检查） | `:memory:` DB |
| workspace-node | `tests/adapters/workspace-node/index.test.ts` | gitCommit 嵌套 repo 测试 | 临时目录 |
| event-bus-memory | `tests/adapters/event-bus-memory/index.test.ts` | — | 内存事件 |
| topic-bus-memory | `tests/adapters/topic-bus-memory/index.test.ts` | — | 内存 topic |
| logger-pino | `tests/adapters/logger-pino/index.test.ts` | — | 内存 sink |
| process-lister-ps | `tests/adapters/process-lister-ps/index.test.ts` | — | 静态字符串 |

---

*本文档完。所有源码锚点均基于 SuperMatrix 仓库 ce32f76 及之前版本。*
