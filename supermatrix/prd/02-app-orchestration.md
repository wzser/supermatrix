# App Orchestration 深度 PRD

> 版本: v1.0-draft
> 日期: 2026-05-20
> 源码锚定: 基于 SuperMatrix 主仓库 commit 范围 ce32f76 及之前
> 术语基线: `prd/00-skeleton.md`

---

## 1. 消息分发（Dispatcher）

### 1.1 总体职责

`Dispatcher` 是飞书消息进入 App 层的唯一总线。它负责：
- 识别消息来源（Root Group vs User Group）
- 提取并解析 Card Action
- 路由 Slash Command
- 执行 Prompt（驱动 Backend Run）
- 守卫外部 Session 信任边界
- 调度 `/next` 排队消息的 drain

[源码锚点] `src/app/dispatcher.ts:316-744`

### 1.2 handleInbound 完整流程图

```
飞书 InboundMessage
    │
    ▼
┌─────────────────────────────────────┐
│ 1. NFKC-fold 检查 ~ 前缀（静音）      │  [源码锚点] dispatcher.ts:368
│    → 以 ~ 或 ～ 开头 → 直接丢弃       │  [测试对账] tests/app/dispatcher.test.ts:599-657
└─────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────┐
│ 2. @bot mention 剥离                  │  [源码锚点] dispatcher.ts:370-373
│    stripLeadingBotMention(text)      │
└─────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────┐
│ 3. 判定 scope（root / user）          │  [源码锚点] dispatcher.ts:375
│    msg.groupId === rootGroupId ?     │
└─────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────┐
│ 4. Card Action 提取与分发             │  [源码锚点] dispatcher.ts:376-399
│    extractCardActionDispatch()       │
│    ├─ 来自真实卡片回调               │
│    └─ /btw mock（仅 root 群）        │  [测试对账] dispatcher.test.ts:771-841
└─────────────────────────────────────┘
    │ 非 card action
    ▼
┌─────────────────────────────────────┐
│ 5. Slash Command 检测                 │  [源码锚点] dispatcher.ts:404-405
│    NFKC-fold 仅用于前缀检测           │
│    原始文本保留给 LLM                │  [测试对账] dispatcher.test.ts:659-740
│    同时支持 bare heartbeat shortcut: │
│      "stop heartbeat [N]" → /heartbeat stop N
│      "resume heartbeat"   → /heartbeat resume
└─────────────────────────────────────┘
    │
    ├── 是 command ──► router.route() ──► lark.sendMessage / postCard
    │                      [源码锚点] dispatcher.ts:437-472
    │                      [测试对账] dispatcher.test.ts:121-149
    │
    └── 非 command
         │
         ▼
    ┌─────────────────────────────────────┐
    │ 6. 外部 Session 守卫（mention gate）  │  [源码锚点] dispatcher.ts:415-434
    │    category="外部" 且未 @bot → 丢弃  │  [测试对账] dispatcher.test.ts:843-945
    │    non-owner 发送 /command → 拒绝    │  [测试对账] dispatcher.test.ts:947-987
    └─────────────────────────────────────┘
         │
         ▼
    ┌─────────────────────────────────────┐
    │ 7. 非 slash 在 root 群 → 静默丢弃     │  [源码锚点] dispatcher.ts:477-480
    │    防止 bot echo loop                │  [测试对账] dispatcher.test.ts:742-769
    └─────────────────────────────────────┘
         │
         ▼
    ┌─────────────────────────────────────┐
    │ 8. Prompt 执行路径                    │  [源码锚点] dispatcher.ts:482-741
    │    a) 查找 binding → session          │
    │    b) 状态检查（deleted/error/busy）  │  [测试对账] dispatcher.test.ts:563-597
    │    c) 附件获取（外部 non-owner 跳过） │  [源码锚点] dispatcher.ts:531-559
    │    d) resolveAttachments()           │
    │    e) 外部 session prompt 包装        │  [源码锚点] dispatcher.ts:565-572
    │    f) startMessageRun + status=busy  │  [源码锚点] dispatcher.ts:576-592
    │    g) backend.run() → replier.consume│
    │    h) finishMessageRun + status=idle │
    │    i) drainPendingNext()             │  [测试对账] dispatcher.test.ts:258-382
    └─────────────────────────────────────┘
```

### 1.3 关键行为细节

**Card Action 的异步 spawn 模型**: Card action 不会同步等待 child session 完成。`postCardActionSpawn` 是 fire-and-forget 的 [源码锚点] `dispatcher.ts:262-268`。它内部调用 `spawnCardActionChild`，构造一个 `one_shot_delegation` 类型的 child，结果 sink 为 `pollable_endpoint`，并附带一个 `inbox-message` 类型的 verification predicate [源码锚点] `dispatcher.ts:271-314`。

**外部 Session Prompt 包装**: 当 `session.category === "外部"` 时，原始 prompt 会被 `buildExternalSessionPrompt` 包装。Owner 的消息标记为 `owner`，non-owner 标记为 `external_non_owner`，并附加规则约束 [源码锚点] `dispatcher.ts:163-190`。

**Codex Resume ID 清理策略**: 如果 Codex backend 返回 `"Bad Request"` 或 `"no rollout found for thread id"` 错误，且 `runBackendSessionId` 与 persisted 值相同（或 run 未返回新 ID），则自动清除 `backendSessionId`，防止下次 resume 再次失败 [源码锚点] `dispatcher.ts:124-150`。此行为有完整测试覆盖 [测试对账] `dispatcher.test.ts:449-561`。

**drainPendingNext 的并发保护**: `drainingNextSessions` Set 确保同一 session 的 drain 不会并发执行。如果 drain 过程中失败，条目会通过 `restoreFront` 重新入队 [源码锚点] `dispatcher.ts:323-362`。

---

## 2. 会话生命周期（SessionLifecycle）

### 2.1 核心操作矩阵

| 操作 | 状态前提 | DB 变更 | 飞书变更 | 进程操作 | 事件 |
|------|----------|---------|----------|----------|------|
| create | 名称唯一 | 插入 session+binding | 建群+邀 owner | 无 | session_created, session_status_changed |
| delete | 非 busy | status→deleted, 删 binding | 解散群 | 无 | session_deleted |
| reset | 非 busy | backendSessionId→null, status→idle | 无 | 无 | session_status_changed |
| restart | busy 时可强制 | 同 reset | 无 | SIGTERM backend | session_status_changed |
| clearSessionContext | 任意 | backendSessionId→null, status→idle | 无 | 无 | session_status_changed |

[源码锚点] `src/app/sessionLifecycle.ts:64-366`

### 2.2 create 完整流程（16 步）

```
输入: { backend, name, purpose, model?, workdir?, chatName? }
    │
    ▼
1. 校验名称正则: /^[a-z0-9][a-z0-9_-]{0,39}$/u     [源码锚点] sessionLifecycle.ts:52,90-92
    失败 → UserError，零副作用
    │
    ▼
2. 查重名 session                                   [源码锚点] sessionLifecycle.ts:93-96
    │
    ▼
3. 确定 workdir（新建 vs 复用已有）                [源码锚点] sessionLifecycle.ts:98-99
    │
    ▼
4. rollback 栈初始化: []                           [源码锚点] sessionLifecycle.ts:100-109
    │
    ▼
5. 新建 workdir 分支:
   a) mkdir(workdir)                               [源码锚点] sessionLifecycle.ts:122
      rollback.push(() => rmrf(workdir))
   b) gitInit(workdir)                             [源码锚点] sessionLifecycle.ts:124
   c) copy .gitignore                              [源码锚点] sessionLifecycle.ts:125-126
   d) gitCommit("init: scaffold session {name}")   [源码锚点] sessionLifecycle.ts:127-129
    │
   复用 workdir 分支:
   a) 检查目录存在，否则 UserError                  [源码锚点] sessionLifecycle.ts:114-116
    │
    ▼
6. createGroup: 群名 = {chatNamePrefix}-{name}-{backend}
                                                [源码锚点] sessionLifecycle.ts:133-140
   rollback.push(() => dissolveGroup(groupId))
    │
    ▼
7. inviteUser(groupId, ownerUserId)               [源码锚点] sessionLifecycle.ts:144
    │
    ▼
8. createSessionWithBinding → session row         [源码锚点] sessionLifecycle.ts:149-161
   状态为 initializing
    │
    ▼
9. emit session_created event                     [源码锚点] sessionLifecycle.ts:164
    │
    ▼
10. 新建 workdir 脚手架（非复用分支）:
    a) session-catalog symlink + git commit        [源码锚点] sessionLifecycle.ts:169-178
    b) principles symlinks (3 files) + git commit  [源码锚点] sessionLifecycle.ts:180-196
    c) SOP 目录 (INDEX.md + TEMPLATE.md symlink) + git commit
                                                [源码锚点] sessionLifecycle.ts:198-225
    d) CLAUDE.md + AGENTS.md 从模板渲染 + git commit
                                                [源码锚点] sessionLifecycle.ts:228-251
   所有失败仅告警，不阻断
    │
    ▼
11. 复用 workdir: ensure catalog symlink（失败仅告警）
                                                [源码锚点] sessionLifecycle.ts:257-266
    │
    ▼
12. status → idle                                 [源码锚点] sessionLifecycle.ts:270
    emit session_status_changed (initializing→idle)
    │
    ▼
13. regenerateCatalog                             [源码锚点] sessionLifecycle.ts:283-290
    │
    ▼
14. syncSessionTableToLark()（异步，不阻塞）       [源码锚点] sessionLifecycle.ts:292,54-62
    │
    ▼
15. 返回 { session: ready }

回滚策略: 任何步骤在 "rollback cliff"（第 8 步之前）失败，
         按逆序执行 rollback 栈（删目录、解散群）。
         第 8 步之后不再回滚，错误通过飞书消息告警。
         [源码锚点] sessionLifecycle.ts:100-109,295-299
```

[测试对账] `tests/app/sessionLifecycle.create.test.ts:38-192`

### 2.3 remove（delete）流程

1. 查找 session，不存在则 UserError [源码锚点] `sessionLifecycle.ts:302-304`
2. busy 状态拒绝 [源码锚点] `sessionLifecycle.ts:305-307`
3. 解散飞书群（失败继续） [源码锚点] `sessionLifecycle.ts:309-314`
4. `deleteSessionAndBinding`（物理删 binding，软删 session） [源码锚点] `sessionLifecycle.ts:316`
5. emit `session_deleted` [源码锚点] `sessionLifecycle.ts:317`
6. regenerateCatalog [源码锚点] `sessionLifecycle.ts:318`

[测试对账] `tests/app/sessionLifecycle.delete.test.ts:38-68`

### 2.4 reset vs restart

```
reset:
  前提: session 非 busy
  动作: clearSessionContext(name)
  效果: backendSessionId=null, status=idle
  不可逆（对话上下文永久丢失）

restart:
  前提: 任意状态（busy 时会先取消）
  动作: 若 busy → cancelBackend(session.id)
       然后 clearSessionContext(name)
  效果: 同 reset，但会发送 SIGTERM
  等价于 /cancel + /reset
```

[源码锚点] `sessionLifecycle.ts:323-355`
[测试对账] `tests/app/sessionLifecycle.resetRestart.test.ts:38-78`

### 2.5 clearSessionContext 原子操作

```
clearSessionContext(sessionName):
  1. 查找 session（不存在 → UserError）
  2. updateSessionBackendSessionId(id, null)
  3. updateSessionStatus(id, "idle", now)
  4. 若 prev !== "idle": emit session_status_changed(prev→idle)
```

[源码锚点] `sessionLifecycle.ts:323-336`

---

## 3. 子会话服务（ChildSession）

### 3.1 三种 Child Type 生命周期对比

| 类型 | 首次 run 后状态 | 可 resume | 结果投递时机 | 自动清理 |
|------|----------------|-----------|-------------|----------|
| `one_shot_delegation` | deleted | ❌ | run 结束后 | 即时 |
| `ephemeral_conversation` | idle | ✅ | run 结束后 | 10 分钟 idle（/btw） |
| `event_awaited_worker` | waiting（ gated ） | ❌ | topic 触发后 | topic 到达或超时 |

[源码锚点] `src/app/childSession.ts:113-115`（terminalStatusForChildType）

### 3.2 spawnChild 完整流程

```
输入: SpawnChildInput
    │
    ▼
1. 校验 type ∈ validChildTypes                     [源码锚点] childSession.ts:172-174
2. 校验 resultSinks 非空                            [源码锚点] childSession.ts:175-179
3. event_awaited_worker 额外校验:
   - 必须有 eventBusContract.subscribe              [源码锚点] childSession.ts:184-190
   - callerInvocation ≠ sync_inline                 [源码锚点] childSession.ts:191-195
    │
    ▼
4. 查找 parent session                              [源码锚点] childSession.ts:198-199
5. 解析 child model（继承策略）                     [源码锚点] childSession.ts:200-205
   - input.model 显式指定 → 用显式值
   - 同 backend 且未指定 → 继承 parent.model
   - 跨 backend → null
    │
    ▼
6. 深度检查: childDepth = parent.depth + 1
   ≤ policyForType(type).maxDepth                   [源码锚点] childSession.ts:210-217
7. 并发检查: activeChildren < policy.maxBusy        [源码锚点] childSession.ts:219-224
    │
    ▼
8. createSession({ scope: "child", ... })
   状态为 busy                                       [源码锚点] childSession.ts:240-261
9. 若 requestedBy 存在:
   logCrossSessionComm(spawn, prompt, childModel, verificationPredicate)
   commId = `comm_${childId.slice(-8)}_${Date.now()}`
                                                [源码锚点] childSession.ts:264-283
    │
    ▼
10. runPrompt(session, input.prompt, hooks)
    │
    ▼
11. finishCrossSessionComm("completed", preview, finalMessage, messageRunId)
    [源码锚点] childSession.ts:285-299
    │
    ▼
12. 返回 SpawnChildResult
```

[测试对账] `tests/app/childSession.test.ts:140-568`

### 3.3 runPrompt 的流处理与超时

```
runPrompt(session, prompt, hooks):
  1. 计算 timeout = deps.runTimeoutMs ?? policy.maxRuntimeSec * 1000
  2. backendRegistry.get(session.backend).run({ session, prompt })
  3. startMessageRun({ id: runId, sessionId, groupId, prompt, startedAt })
  4. onRunStarted hook（async kickoff 的 202 返回点）
     [源码锚点] childSession.ts:394-408
  5. collectStream(stream, { normalizeCumulativeUsage: backend==="codex" })
     同时与 setTimeout(runTimeoutMs) race
     [源码锚点] childSession.ts:451-545
  6. streamOutcome.then() 后台持久化:
     - recordTokenUsage
     - finishMessageRun(status, finalMessage/error, streamLog)
     - 若超时后流才完成 → restoreSuccessfulTerminalState + onLateSuccess
       [源码锚点] childSession.ts:464-530
  7. Promise.race 结果:
     ├─ 流先完成且无 error → 继续 gating / terminal / sinks
     ├─ 流先完成但有 error → throw RunFailure
     └─ timeout 先触发 → timedOut=true, throw Error
        catch 中: cancel backend, status→error, throw RunFailure
        [源码锚点] childSession.ts:532-710
```

[测试对账] `tests/app/childSession.test.ts:329-413`

### 3.4 event_awaited_worker 的 Gating 逻辑

```
当 session.childType === "event_awaited_worker" 且
     gating.subscribeGatesCompletion === true:
    │
    ▼
1. 检查 topicBus 是否 wired（未 wired → Error）   [源码锚点] childSession.ts:572-580
2. 检查 parent 是否已被级联删除（isDeletedNow）
   → 是则直接返回 deleted 状态，不进入 waiting   [源码锚点] childSession.ts:585-592
3. status → waiting                                [源码锚点] childSession.ts:594-600
4. waitForGate(topic, maxRuntimeMs, topicBus)
   - 订阅 topic（replay=true，捕获已发布事件）    [源码锚点] childSession.ts:800-827
   - 与 maxRuntime 超时 race
    │
    ├─ topic 到达 → status → deleted
    │              deliverAndRecordSinks()
    │              返回 result                    [源码锚点] childSession.ts:608-634
    │
    └─ 超时 → status → error
             throw RunFailure("timed out after ...")
             sink 不投递                         [源码锚点] childSession.ts:640-653
```

[测试对账] `tests/app/childSession.test.ts:759-892`

### 3.5 sink 投递

`deliverAndRecordSinks` 在 runPrompt 的 try 成功路径末尾被调用 [源码锚点] `childSession.ts:676-680`。它委托给 `deps.deliverSinks`（即 `resultSinkEngine.deliverResultSinks`），然后调用 `recordDeliverySummary` 将每个 sink 的投递结果写入 `result_sink_attempts` 表。

投递失败不会导致 spawn 失败（non-fatal），错误仅记录到 DB [源码锚点] `childSession.ts:719-738`。

---

## 4. 回复器（Replier）

### 4.1 consume 的流处理逻辑

`replier.consume()` 接收一个 `AsyncIterable<AgentEvent>`，逐事件更新飞书卡片，最终调用 `finalizeCard`。

```
consume(input):
  1. postCard("⌛ 正在处理…", title="running")
     [源码锚点] replier.ts:82
  2. 初始化状态:
     bodyLines[], assistantTexts[], streamLog[]
     finalMessage="", error=undefined
     completedCleanly=false
     usage=undefined, usageWatermark=baseline
     reminderIdx=0, lastReminderLine=undefined
     [源码锚点] replier.ts:84-108
  3. for await (event of stream):
     checkReminder() → 可能更新 lastReminderLine
     switch event.kind:
       started:     bodyLines.push(session 启动), backendSessionId=event.backendSessionId
       thinking:    bodyLines.push(💭 truncate(120)), streamLog.push
       tool_call:   bodyLines.push(🔧 name), streamLog.push(+callId,+command)
       tool_result: bodyLines.push(✅ name), streamLog.push(+callId,+command)
       assistant_message:
         bodyLines.push(💬 truncate(240))
         assistantTexts.push(event.text)
         streamLog.push({final})
         if event.final:
           finalMessage=event.text
           completedCleanly=true
           // 清除非 terminal 的先前 error
           if error && !isTerminalErrorMessage(error): error=undefined
       error:
         bodyLines.push(❌ message)
         streamLog.push
         if !completedCleanly || isTerminalErrorMessage(message):
           error = message
       completed:
         if event.finalMessage.trim(): finalMessage=event.finalMessage
         completedCleanly=true
       usage:
         if codex + baseline: normalizeCumulativeUsageEvent()
         usage = accumulateUsage(usage, event)
         if usage.model: runtimeModel = usage.model
     await updateCard()
     [源码锚点] replier.ts:136-225
  4. catch (err):
     if !completedCleanly || isTerminalErrorMessage(err.message):
       error = err.message
     [源码锚点] replier.ts:226-233
  5. 构建 finalText:
     finalMessage > assistantTexts.join > error > "(no content)"
     [源码锚点] replier.ts:236-239
  6. finalizeCard(finalText, title(suffix), processLog, runStatus)
     [源码锚点] replier.ts:242-248
  7. 返回 ConsumeResult
```

[测试对账] `tests/app/replier.test.ts:15-804`

### 4.2 completedCleanly 语义

`completedCleanly` 是 replier 的核心状态门，解决以下问题：
- **Trailing error after completion**: backend 已返回完整结果，之后 CLI 退出码非零或发出 recoverable error。`completedCleanly=true` 确保这些后期噪音不会翻转卡片为 failed [测试对账] `replier.test.ts:94-123`。
- **Terminal error override**: 如果后期 error 是 `[TIMEOUT]` 或 `cancelled by user`（terminal error），则必须覆盖 `completedCleanly`，将卡片标记为 timeout / cancelled [测试对账] `replier.test.ts:130-164`, `274-304`。
- **Recoverable errors before final**: Codex 的 "Reconnecting... N/5" 系列 error 发生在 final assistant_message 之前。这些错误会先设置 `error`，但随后的 `final=true` 事件会清除非 terminal error [测试对账] `replier.test.ts:315-363`。

[源码锚点] `replier.ts:102,189-208`

### 4.3 Card 更新策略

- **Running 阶段**: 每个事件触发 `updateCard()`，卡片显示 `bodyLines` 拼接的 process trace + 可能的 reminder line [源码锚点] `replier.ts:112-115`。
- **Title 动态构建**: `buildTitle(suffix, usage)` 组合 `sessionName | modelDisplay · suffix [| contextUsage]` [源码锚点] `replier.ts:74-80`。
- **Finalize**: `finalizeCard` 接收最终文本、标题（含 runStatus suffix）、processLog（可折叠面板）、runStatus [源码锚点] `replier.ts:242-248`。

### 4.4 Reminder 调度

默认提醒时间表: `[60s, 180s, 420s, 900s, 1800s]`，之后每 30 分钟重复一次 [源码锚点] `replier.ts:65-66`。

`checkReminder()` 比较 `monotonic() - startedAt` 与 schedule。当跨越阈值时，生成 `lastReminderLine = "⏱ 已运行 Xs，最近活动：{lastBodyLine}"` [源码锚点] `replier.ts:117-134`。

[测试对账] `replier.test.ts:758-794`

### 4.5 streamLog 构建

`streamLog` 是 `StreamLogEntry[]`，持久化到 `message_runs.stream_log`。每个事件产生一条带 `ts`（clock.now()）的条目：

| 事件类型 | streamLog kind | 记录字段 |
|----------|----------------|----------|
| thinking | `thinking` | text |
| tool_call | `tool_call` | name, args, callId?, command? |
| tool_result | `tool_result` | name, result, callId?, command? |
| assistant_message | `assistant_message` | text, final |
| error | `error` | text |

[源码锚点] `replier.ts:43-48, 136-225`

---

## 5. 命令系统

### 5.1 CommandRegistry 注册模型

`buildCommandRegistry()` 返回 `Record<string, CommandEntry>`，每个 entry 包含 `command`（元数据）和 `handler`（初始为 placeholder，由 bootstrap 绑定具体实现） [源码锚点] `src/app/commandRegistry.ts:30-543`。

元数据（Command）包含：
- `name`, `description`, `notes`
- `scope`: `"root" | "user"` 数组
- `params`: `{ name, type, required, kind: "positional" | "named" | "rest", scope?, enum? }[]`

[源码锚点] `src/domain/command.ts`（由 commandRegistry 引用）

### 5.2 CommandRouter 路由逻辑

```
route({ scope, msg }):
  1. parseCommand(msg.text, commands, scope)
     → 失败: replyText = "❌ {msg}，使用 /help 查看可用命令"
  2. 查找 registry[parsed.name]
     → 未找到: "❌ 未知命令"
  3. 检查 scope 匹配
     → 不匹配: "❌ 命令 /{name} 不可在...群使用"
  4. 调用 handler({ args, scope, msg })
  5. catch error:
     UserError → "❌ {msg}"
     SystemError → "❌ 内部错误"
     DomainError → "❌ {msg}"
     其他 → "❌ 未知错误"
```

[源码锚点] `src/app/commandRouter.ts:20-41`
[测试对账] `tests/app/commandRouter.test.ts:16-96`

### 5.3 所有命令的输入输出契约表

| 命令 | Scope | 参数 | 成功回复 | 失败回复 | 副作用 |
|------|-------|------|----------|----------|--------|
| `/new` | root | `backend` (enum), `name`, `[--model]`, `[--workdir]`, `[--chat-name]`, `[purpose...]` | "✓ 已创建 session 「{name}」" | UserError: 非法名称/已存在/目录已存在 | 建群、建目录、git init、写文件、插 DB |
| `/delete` | root,user | root: `name`; user: 自动绑定 | "✓ 已删除 session 「{name}」" | UserError: 不存在/busy | 解散群、删 binding、软删 session |
| `/cancel` | root,user | root: `name`; user: 自动绑定 | "✓ 已请求取消..." | UserError: 不存在 | SIGTERM backend、清空 pendingNext |
| `/reset` | root,user | root: `name`; user: 自动绑定 | "✓ session 「{name}」上下文已清空" | UserError: 不存在/busy | backendSessionId=null, status=idle |
| `/restart` | root,user | root: `name`; user: 自动绑定 | "✓ session 「{name}」已强制重启" | UserError: 不存在 | cancel + reset |
| `/spawn` | root | `name`, `[--backend]`, `[--model]`, `[--from]`, `[--reply-to]`, `prompt...` | "✓ 子 session「{name}」已完成" | UserError: 不存在/非法参数 | spawnChild(one_shot_delegation) |
| `/backend` | root,user | root: `name` `backend`; user: `backend` | "✓ 已从 {old} 切换为 {new}" | UserError: 不存在/busy/无效backend | 清空 backendSessionId+model, 更新群名 |
| `/model` | root,user | root: `name|all|all-claude|all-codex` `model`; user: `model` | "✓ 模型已切换为 {model}" | UserError: 不存在/非法模型 | 更新 session.model |
| `/selfcheck` | root | 无 | 自检报告卡片 | 无 | 只读（observe 模式） |
| `/status` | root,user | root: `[name]`; user: 无 | session 详情或全局统计 | UserError: 不存在 | 只读 |
| `/next` | user | `text...` | "✓ 已排队" 或 handled:true | UserError: 未绑定/状态异常 | 入队 pendingNext |
| `/btw` | user | `text...` | 子 session 结果文本 | UserError: 未绑定 | spawn/resume ephemeral_conversation |

[源码锚点] 各 handler 文件位于 `src/app/commands/`
[测试对账] 各命令测试位于 `tests/app/commands/*.test.ts`

### 5.4 /spawn 命令详解

`/spawn` 是 root 群专用的同步 spawn 入口。handler 解析以下内联选项（正则提取，从 prompt 中剥离）：
- `--reply-to <chat_id>` → chat_post sink 的显式目标群 [源码锚点] `commands/spawnChild.ts:43-48`
- `--backend claude|codex` → 覆盖 target session 的 backend [源码锚点] `commands/spawnChild.ts:51-56`
- `--model <model|default>` → 覆盖模型 [源码锚点] `commands/spawnChild.ts:59-64`
- `--from <session-name>` → 设置 requestedBy（cross_session_log 记录来源） [源码锚点] `commands/spawnChild.ts:67-72`

默认结果投递到 parent session 的绑定群（`chatRef: { kind: "parent" }`），身份为 `bot` [源码锚点] `commands/spawnChild.ts:112-118`。

结果消息在群中被截断到 200 字符 + "..." [源码锚点] `commands/spawnChild.ts:122-124`。

[测试对账] `tests/app/commands/spawnChild.test.ts:105-388`

### 5.5 /btw 命令详解

`/btw`（by the way）是 session 群内的侧线对话命令：
- 首次调用：spawn 一个 `ephemeral_conversation` child session [源码锚点] `commands/btw.ts:127-145`
- 后续调用（10 分钟内）：resume 同一 child session [源码锚点] `commands/btw.ts:146-155`
- 10 分钟 idle 后：timer 触发 cleanup → cancel backend → status→deleted [源码锚点] `commands/btw.ts:57-89`
- 每次调用后重置 idle timer [源码锚点] `commands/btw.ts:118,190`

child 使用默认模型：`sonnet`（Claude）、Codex 默认模型、`kimi-k2-thinking`（Kimi） [源码锚点] `commands/btw.ts:22-26`。

对 codex empty completion 有特殊处理：返回友好提示而非抛错 [源码锚点] `commands/btw.ts:111-112,178-187`。

[测试对账] `tests/app/commands/btw.test.ts`

---

## 6. Spawn 闭包

### 6.1 状态机

Spawn Closure 追踪一次异步 spawn 从发起到关闭的完整生命周期。状态机如下：

```
                    ┌─────────────┐
                    │   pending   │  （spawn 请求已接收，等待执行）
                    └──────┬──────┘
                           │ childSpawnResult 返回
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         ┌────────┐  ┌──────────┐  ┌──────────┐
         │ closed │  │adjudicating│  │  closed  │
         │(成功)  │  └─────┬──────┘  │(失败)    │
         └────────┘        │         └──────────┘
                           ▼
                    ┌─────────────┐
                    │ re_driving  │  （sync retry 或 async 降级后重新执行）
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  delivering │  （结果投递阶段，执行 threePhaseCheck）
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         ┌────────┐  ┌──────────┐  ┌──────────┐
         │ closed │  │  closed  │  │  closed  │
         │(成功)  │  │(async item│  │(失败)    │
         └────────┘  │registered)│  └──────────┘
                     └──────────┘
```

注：虽然源码中没有显式的 "状态机类"，但 `closureLog.ts` 定义了所有可能的事件类型，`threePhaseCheck.ts` 定义了 adjudicating 阶段的判定逻辑，`registerAsyncItem.ts` 定义了 async 降级时的注册行为。

### 6.2 ThreePhaseCheck（判定逻辑）

`runThreePhaseCheck` 是 closure 的核心 adjudicator，按顺序执行三个不可跳过的阶段（前面失败则后面 skipped）：

| 阶段 | 检查内容 | 通过条件 | 失败时 failureKind |
|------|----------|----------|------------------|
| communication | child session 是否成功创建 | `!isErrorResult || result.error !== "spawn_failed"` | `spawn_not_started` |
| execution | run 是否成功完成且有输出 | `!isErrorResult && finalMessage.trim() !== ""` | `run_error` / `run_timeout` / `empty_output` |
| delivery | result sink 是否成功投递 | sinks 非空且每条 sink 在 DB 中有 `status='delivered'` 记录 | `delivery_missing` |

[源码锚点] `src/app/spawnClosure/threePhaseCheck.ts:31-145`
[测试对账] `tests/app/spawnClosure/threePhaseCheck.test.ts:83-197`

### 6.3 watcher 路由决策

当 sync spawn 的 ThreePhaseCheck 未通过时，系统执行 watcher 路由决策：

1. **第一次 sync attempt 失败**:
   - 若 failureKind 为 `run_timeout` 或 `late_result` → `status = "waiting_child"`
   - 否则 → `status = "pending"`
   - 注册 `spawn_async_items` 行 [源码锚点] `src/app/spawnClosure/registerAsyncItem.ts:14-48`

2. **Sync retry**: `/api/spawn` 的 sync 模式会重试一次 sync spawn。若仍失败，彻底降级为 async [源码锚点] `src/cli/apiServer.ts:492-637`（在 00-skeleton 中引用）。

3. **Async 执行**: 返回 202 `{childSessionId, messageRunId}`，后台继续执行，结果通过 sink 投递。

### 6.4 ClosureLog 事件类型

`logClosureEvent` 统一记录所有 spawn 生命周期事件：

| event | 含义 |
|-------|------|
| `admission_validation` | spawn 请求准入检查（accepted/rejected） |
| `phase_check` | threePhaseCheck 执行（first/repeat/retry） |
| `sync_retry` | 同步重试触发或结果 |
| `async_switch` | 降级为异步（registered / sync_error） |
| `state_transition` | 闭包状态迁移（pending → closed 等） |

[源码锚点] `src/app/spawnClosure/closureLog.ts:13-110`

---

## 7. Spawn 断言

### 7.1 断言评估总线

`evaluateSpawnPredicate(predicate, context)` 是所有 predicate 的统一入口：
- 使用 `withTimeout` 包装实际 evaluator，超时视为 `transient_fail` [源码锚点] `src/app/spawnPredicate/evaluate.ts:75-99`
- 错误分类：`classifyError` 根据错误消息中的关键词（timeout, SQLITE_BUSY, ECONNRESET 等）判定为 transient 或 permanent [源码锚点] `evaluate.ts:32-46`
- 结果类型：`"true" | "false" | "transient_fail" | "permanent_fail"`

[测试对账] `tests/app/spawnPredicate/evaluate.test.ts:18-144`

### 7.2 所有 Evaluator 类型

#### git-log

**输入**: `{ type: "git-log", repo_path, since, path_globs?, message_regex?, author_regex?, min_count? }`

**判定逻辑**:
1. lint + path allowlist 检查 [源码锚点] `evaluators/gitLog.ts:48-52`
2. `git -C repo_path rev-parse --show-toplevel` 验证仓库可读性
3. `git log --format=%H%x1f%an%x1f%s --max-count=1000 {sinceArgs} [-- path_globs]`
4. 对每行 `sha\x1fauthor\x1fmessage` 应用 `message_regex` 和 `author_regex`
5. `matched = count >= min_count`（默认 1）

**since 类型**: `spawn_created_at` | `timestamp_ms` | `commit`
[源码锚点] `src/app/spawnPredicate/evaluators/gitLog.ts:14-91`

#### db-row

**输入**: `{ type: "db-row", db_ref, schema?, table, where_all[], require_columns?, min_count }`

**判定逻辑**:
1. lint + dbRegistry 解析（仅支持 sqlite） [源码锚点] `evaluators/dbRow.ts:109-118`
2. 动态注册 SQLite `regexp()` 函数
3. 将 `where_all` 和 `require_columns` 编译为 SQL WHERE 子句
   - 支持 op: eq, ne, gt, gte, lt, lte, contains(LIKE), matches(regexp), is_null, not_null, in
4. `SELECT COUNT(*) ...`
5. `matched = count >= min_count`

[源码锚点] `src/app/spawnPredicate/evaluators/dbRow.ts:1-150`

#### file-mtime

**输入**: `{ type: "file-mtime", root_path, path_glob, since, min_count?, min_size_bytes? }`

**判定逻辑**:
1. lint + path allowlist [源码锚点] `evaluators/fileMtime.ts:121-126`
2. 解析 `since`（spawn_created_at 或 timestamp_ms）
3. `path_glob` 含 `*?` 时走 glob 递归匹配（最多 10,000 个目录项） [源码锚点] `evaluators/fileMtime.ts:89-119`
   - 不含 glob magic 时走 exact match
4. `fileMatches = isFile && mtimeMs >= since && size >= min_size_bytes`
5. `matched = count >= min_count`

[源码锚点] `src/app/spawnPredicate/evaluators/fileMtime.ts:1-138`

#### http-get

**输入**: `{ type: "http-get", url, expected_status, body_contains_all?, body_contains_any?, json_pointer_equals?, max_body_bytes? }`

**判定逻辑**:
1. lint [源码锚点] `evaluators/httpGet.ts:137-142`
2. `fetch(url, { signal: AbortSignal.timeout })`
3. 读取 body（受 `max_body_bytes` 截断，默认 256KB） [源码锚点] `evaluators/httpGet.ts:34-69`
4. 检查:
   - `status ∈ expected_status`
   - `body_contains_all` 每个 token 都出现
   - `body_contains_any` 至少一个 token 出现（或无此字段）
   - `json_pointer_equals` 每个 pointer 解析值等于预期值
5. `matched = 全部通过`

[源码锚点] `src/app/spawnPredicate/evaluators/httpGet.ts:1-169`

#### inbox-message

**输入**: `{ type: "inbox-message", session_name, field, since, contains_all?, contains_any?, regex?, min_count? }`

**判定逻辑**:
1. lint [源码锚点] `evaluators/inboxMessage.ts:49-54`
2. 打开 framework SQLite DB（`SM_DB_PATH` 或默认路径）只读 [源码锚点] `evaluators/inboxMessage.ts:25-34`
3. 查询:
   ```sql
   SELECT {field} FROM message_runs mr
   JOIN sessions s ON s.id = mr.session_id
   WHERE s.name = ? AND mr.started_at >= ? AND {field} IS NOT NULL
   ORDER BY mr.started_at DESC
   ```
4. 对每行应用 `contains_all`、`contains_any`、`regex`
5. `matched = count >= min_count`

[源码锚点] `src/app/spawnPredicate/evaluators/inboxMessage.ts:1-87`

### 7.3 断言 schema 与校验

所有 predicate 通过 Zod schema 校验：
- `expected_window_sec`: 默认 3600s，范围 [60, 604800]
- `evaluation_timeout_ms`: 默认 10000ms，范围 [100, 30000]
- `retry_on_transient_fail`: 默认 2，范围 [0, 5]
- 字符串长度、数组长度均有上限限制
- `canonicalJsonStringify` + SHA-256 生成 `predicate_hash`，用于去重和版本追踪

[源码锚点] `src/app/spawnPredicate/schema.ts:1-159`

---

## 8. 结果投递引擎

### 8.1 deliverResultSinks 的 dispatch 逻辑

```
deliverResultSinks(session, finalMessage, deps):
  1. 若 session.callerInvocation === "sync_inline":
     → 直接返回 skipped 摘要（HTTP handler 自行投递）
     [源码锚点] resultSinkEngine.ts:101-104
  2. 遍历 session.capabilityPayload.resultSinks:
     对每个 sink 调用 deliverOneSafely()
  3. 返回 DeliverySummary
```

[测试对账] `tests/app/resultSinkEngine.test.ts:43-59`

### 8.2 各 sink 类型行为差异

| Sink 类型 | 行为 | 依赖 | 失败模式 |
|-----------|------|------|----------|
| `http_response` | no-op（sync handler 已返回） | 无 | 永不失败 |
| `pollable_endpoint` | no-op（通过 GET /api/sessions/:id/result 轮询） | 无 | 永不失败 |
| `audit_only` | no-op（cross_session_log 已记录） | 无 | 永不失败 |
| `chat_post` | 调用 `postToChat(chatId, finalMessage, identity)` | `deps.postToChat` | postToChat 未 wired / chat 不可解析 |
| `parent_continuation_inject` | 调用 `injectContinuation({parentSessionId, childSession, finalMessage})` | `deps.injectContinuation` | injectContinuation 未 wired |
| `eventbus_publish` | 调用 `topicBus.publish(topic, {kind:"child_final_message", childSessionId, childName, childType, finalMessage, publishedAtMs})` | `deps.topicBus` | topicBus 未 wired |

[源码锚点] `resultSinkEngine.ts:133-188`
[测试对账] `tests/app/resultSinkEngine.test.ts:61-185`

### 8.3 chat_post 的 chatRef 解析

```
resolveChatRef(chatRef):
  "explicit" → 直接使用 chatId
  "parent"   → findBySession(session.parentId).groupId
  "requester" / "reply_to" → 当前引擎无法解析，记录 warn 并返回 null
```

[源码锚点] `resultSinkEngine.ts:190-214`

### 8.4 redeliverResultSinks

用于 watcher 或手动重投场景：
- 不跳过 `sync_inline`
- 每个 sink 结果写入 `result_sink_attempts` 表
- 失败记录为 `failed`，不抛异常

[源码锚点] `resultSinkEngine.ts:61-89`
[测试对账] `tests/app/resultSinkEngine.test.ts:187-269`

---

## 9. 自检查系统

### 9.1 三阶段检查架构

| 阶段 | 时机 | 失败行为 | 检查项 |
|------|------|----------|--------|
| pre-wiring | 构造 Store 之前 | `process.exit(1)` | local-deps, dual-instance, supervisor-presence, scheduler-health, codex-default-model, kimi-acp-health |
| post-wiring | Store + Migration 之后 | `process.exit(1)` | reconcile-backend-processes |
| runtime | `/selfcheck` 命令或定时触发 | 仅报告，不退出 | local-deps, supervisor-presence, scheduler-health, reconcile-backend-processes |

[源码锚点] `src/app/bootSelfCheck/types.ts:5-6`
[源码锚点] `src/app/bootSelfCheck/index.ts:11-25`（runChecks 短路逻辑）

### 9.2 各检查项详细说明

#### local-deps
- **lark-cli 可执行性**: 探测 `cfg.larkCliPath`，失败时尝试 PATH fallback（`which lark-cli`），若修复成功则 status=warn [源码锚点] `checks/localDeps.ts:55-64`
- **DB 目录可写**: 自动 `mkdir -p` [源码锚点] `checks/localDeps.ts:90-102`
- **Workspace root 可写**: 同上
- **阶段**: pre-wiring, runtime

[测试对账] `tests/app/bootSelfCheck/checks/localDeps.test.ts`

#### dual-instance
- 读取 `.bootstrap.pid`，检查旧 PID 是否仍存活且命令匹配 `tsx .*src/cli/main.ts`
- 额外 ps fallback 扫描（排除自身和 tsx wrapper 的 ppid）
- 通过后才写入当前 PID
- **阶段**: pre-wiring

[源码锚点] `checks/dualInstance.ts:7-56`
[测试对账] `tests/app/bootSelfCheck/checks/dualInstance.test.ts`

#### supervisor-presence
- 沿 PPID 链向上遍历最多 5 层
- 识别 `dev-loop.sh` / `localwatch.sh` / `PM2`
- PPID=1 时 warn（可能是 launchd 或 orphan）
- **阶段**: pre-wiring, runtime

[源码锚点] `checks/supervisorPresence.ts:8-72`
[测试对账] `tests/app/bootSelfCheck/checks/supervisorPresence.test.ts`

#### scheduler-health
- `fetch(SM_SCHEDULER_HEALTH_URL /tasks)`，2 秒超时
- 未配置环境变量则跳过（ok）
- **阶段**: pre-wiring, runtime

[源码锚点] `checks/schedulerHealth.ts:3-30`
[测试对账] `tests/app/bootSelfCheck/checks/schedulerHealth.test.ts`

#### codex-default-model
- 探测 Codex CLI 的可用模型列表
- 缓存到内存 catalog，供后续 `/model` 命令校验
- 探测失败时使用 fallback list（`gpt-5.5`, `gpt-5.4` 等）并 warn
- **阶段**: pre-wiring

[源码锚点] `checks/codexDefaultModel.ts:11-98`
[测试对账] `tests/app/bootSelfCheck/checks/codexDefaultModel.test.ts`

#### kimi-acp-health
- 执行 `kimi info` 探测 CLI 可用性
- 失败时 warn（不影响 claude/codex 用户）
- **阶段**: pre-wiring

[源码锚点] `checks/kimiAcpHealth.ts:7-33`
[测试对账] `tests/app/bootSelfCheck/kimiAcpHealth.test.ts`

#### reconcile-backend-processes
- 扫描 `ppid=1` 且 cmd 匹配 `/(claude|codex|kimi)/` 的孤儿进程
- Kimi ACP 例外：live ACP pid 不视为孤儿
- **execute 模式**:
  - 对 DB 中 status=running 的 message_run：若非 kimi live ACP 则标记 timeout
  - kill 所有孤儿 backend 进程
- **observe 模式**: 只报告数量，不杀进程、不改 DB
- **阶段**: post-wiring, runtime

[源码锚点] `checks/reconcileBackendProcesses.ts:7-134`
[测试对账] `tests/app/bootSelfCheck/checks/reconcileBackendProcesses.test.ts`

### 9.3 报告渲染

- `renderStderrFailReport`: 启动失败时输出到 stderr [源码锚点] `formatReport.ts:3-13`
- `renderAnnounceCheckSection`: 飞书群公告格式 [源码锚点] `formatReport.ts:15-29`
- `renderLarkSelfCheckMessage`: `/selfcheck` 命令回复格式 [源码锚点] `formatReport.ts:31-40`

---

## 10. 进程生命周期

### 10.1 ProcessLifecycle 接口

```typescript
export type ProcessLifecycle = {
  runStarted(): void;      // inFlight++
  runFinished(): void;     // inFlight--, 可能触发 exit
  requestRestart(reason, opts?): void;  // 登记 pending restart
  isPending(): boolean;
  isForce(): boolean;
  reason(): string | undefined;
  source(): string | undefined;
  inFlightCount(): number;
};
```

[源码锚点] `src/app/processLifecycle.ts:8-17`

### 10.2 gracefulStop 的关闭顺序

虽然 `gracefulStop` 的实现在 `cli/bootstrap.ts` 中，但 `ProcessLifecycle` 提供了其核心状态机：

```
requestRestart(reason, { force?, source? }):
  ├─ force=true → 立即触发 onExit（无论 inFlight）
  │   [测试对账] processLifecycle.test.ts:35-42
  ├─ inFlight=0 → 立即触发 onExit
  │   [测试对账] processLifecycle.test.ts:44-50
  └─ inFlight>0 → 挂起，等最后一个 runFinished 时触发
      [测试对账] processLifecycle.test.ts:25-33
```

`maybeExit()` 确保 `onExit` 只调用一次（`exiting` 标志） [源码锚点] `processLifecycle.ts:27-39` [测试对账] `processLifecycle.test.ts:60-68`。

### 10.3 超时策略与资源清理

- **不强制超时**: ProcessLifecycle 本身不设置最大等待时间。`force: true` 是管理员（`/reload force`）的强制手段。
- **inFlight 计数**: 仅统计通过 `runStarted/runFinished` 配对的 run。如果 backend 流在 replier 层抛异常，`finally` 块中的 `lifecycle.runFinished()` 确保计数正确递减 [源码锚点] `dispatcher.ts:738-740`。
- **onExit 回调**: 由 bootstrap 提供，负责关闭 WebSocket、HTTP server、清理 PID 文件、退出进程。

[源码锚点] `src/app/processLifecycle.ts:19-71`
[测试对账] `tests/app/processLifecycle.test.ts:1-69`

---

## 11. 不变式清单

以下不变式由 App 层源码和测试共同保证。违反任一条都会导致系统行为偏离设计预期。

1. **命令路径与 prompt 路径互斥**: 同一条 inbound 消息不会同时触发 `router.route()` 和 `backend.run()` [源码锚点] `dispatcher.ts:404-473` [测试对账] `dispatcher.test.ts:121-149`。

2. **Session 状态 busy 时拒绝新 prompt**: 无论是 status=busy 还是 DB 中存在 running message_run，都会拒绝 [源码锚点] `dispatcher.ts:512-529` [测试对账] `dispatcher.test.ts:563-597`。

3. **Rollback cliff 不可跨越**: `sessionLifecycle.create()` 在 `createSessionWithBinding` 之前失败的任何副作用，必须通过 rollback 栈完全撤销 [源码锚点] `sessionLifecycle.ts:100-109,295-299` [测试对账] `sessionLifecycle.create.test.ts:149-155`。

4. **Child depth 与并发硬上限**: `spawnChild` 必须检查 `depth ≤ policy.maxDepth` 和 `activeChildren < policy.maxBusy` [源码锚点] `childSession.ts:210-224` [测试对账] `childSession.test.ts:215-309`。

5. **event_awaited_worker 必须有 topic**: 缺少 `eventBusContract.subscribe` 的 spawn 会被拒绝 [源码锚点] `childSession.ts:184-190` [测试对账] `childSession.test.ts:760-775`。

6. **completedCleanly 门保护 final answer**: replier 中，一旦 `completedCleanly=true`，非 terminal 的后续 error 不会覆盖结果 [源码锚点] `replier.ts:189-208` [测试对账] `replier.test.ts:94-123`。

7. **Terminal error 必须覆盖 completedCleanly**: `[TIMEOUT]` 和 `cancelled by user` 在 `completedCleanly=true` 后仍然有效 [源码锚点] `replier.ts:205-207` [测试对账] `replier.test.ts:130-164`。

8. **sync_inline 的 sink 引擎短路**: `deliverResultSinks` 对 `callerInvocation=sync_inline` 的 session 不执行任何投递 [源码锚点] `resultSinkEngine.ts:101-104` [测试对账] `resultSinkEngine.test.ts:43-59`。

9. **Codex Bad Resume 自动清除**: Codex backend 返回 `"Bad Request"` 或 `"no rollout found"` 时，若 resume ID 匹配，则自动清除 [源码锚点] `dispatcher.ts:124-150` [测试对账] `dispatcher.test.ts:449-561`。

10. **外部 Session 的 non-owner 静默丢弃**: 未 @bot 的消息和 non-owner 的 slash command 被静默拒绝或返回 owner 提示 [源码锚点] `dispatcher.ts:415-451` [测试对账] `dispatcher.test.ts:843-987`。

11. **Message run 的 streamLog 永不为空时丢失**: 只要 backend 发出事件，`streamLog` 就会按到达顺序记录到 `message_runs.stream_log` [源码锚点] `replier.ts:136-225` [测试对账] `replier.test.ts:166-223`。

12. **PendingNext drain 串行化**: `drainingNextSessions` Set 保证同一 session 不会并发 drain [源码锚点] `dispatcher.ts:321,326-327` [测试对账] `dispatcher.test.ts:310-382`。

13. **Boot 双实例检测必须写 PID**: 只有通过了 PID 文件检查和 ps fallback 扫描后，才写入 `.bootstrap.pid` [源码锚点] `bootSelfCheck/checks/dualInstance.ts:30-55` [测试对账] `dualInstance.test.ts`。

14. **Reconcile 不杀 live kimi ACP**: `reconcileBackendProcessesCheck` 必须将 `kimi acp` 的 live pid 排除在孤儿列表之外 [源码锚点] `bootSelfCheck/checks/reconcileBackendProcesses.ts:31-36,128-134` [测试对账] `reconcileBackendProcesses.test.ts`。

15. **Spawn predicate 超时即 transient**: 所有 evaluator 内部异常若在 `withTimeout` 内未解决，统一归类为 `transient_fail` [源码锚点] `spawnPredicate/evaluate.ts:52-68` [测试对账] `evaluate.test.ts`。

16. **BTW child 的 idle 定时器必须重置**: 每次 `/btw` 调用必须 `clearTimeout(existing.idleTimer)` 并重新 schedule [源码锚点] `commands/btw.ts:118,190` [测试对账] `btw.test.ts`。

17. **ProcessLifecycle onExit 只调用一次**: `exiting` 标志确保 `maybeExit` 的幂等性 [源码锚点] `processLifecycle.ts:27-28,34` [测试对账] `processLifecycle.test.ts:60-68`。

---

## 12. 反例场景

以下场景描述的是**当前系统明确不支持的边缘情况或已知的错误模式**。它们不是 bug，而是设计约束或已防护的边界。

### 12.1 并发 drainPendingNext 导致的消息乱序

**假设**: 两个飞书消息几乎同时到达同一 user group，session 处于 idle。

**实际行为**: `handleInbound` 是 async 的，但 `drainPendingNext` 通过 `drainingNextSessions` Set 保护，确保同一 session 的 drain 串行化。两个独立的外部消息仍可能并发进入 `handleInbound`，但第二个消息会在 `findRunningMessageRunBySession` 处看到 busy 而被拒绝（或排队）。

**结论**: 真正的并发 prompt 竞争由 `status=busy` 和 `findRunningMessageRunBySession` 双锁保护，不会导致两个 backend run 重叠。`drainingNextSessions` 仅保护 `/next` drain 的串行化。

[源码锚点] `dispatcher.ts:323-362,512-529` [测试对账] `dispatcher.test.ts:310-382`

### 12.2 外部 owner 在 external session 中发 `/status`

**假设**: 外部 session 的 owner（`msg.userId === ownerUserId`）发送 `/status`。

**实际行为**: 外部 session 的 `category === "外部"` 只影响两条路径：
1. 未 mention bot 的 non-owner prompt → 丢弃（owner 不受此限）
2. non-owner 的 slash command → 拒绝

Owner 的 slash command 会正常路由。但 `/status` 在 user scope 可用，会返回当前 session 的详细信息。由于 external session 的 binding 存在，此命令可以执行。

**结论**: external session 的 owner 拥有完整命令权限，只有 non-owner 受限制。这是设计意图。

[源码锚点] `dispatcher.ts:439-450` [测试对账] `dispatcher.test.ts:989-1000+`

### 12.3 event_awaited_worker 的 parent 在 waiting 期间被删除

**假设**: child session 已进入 `waiting` 状态，等待 topic。此时 parent session 被 `/delete`。

**实际行为**: `deleteSessionAndBinding` 会级联删除 child（status→deleted）。当 topic 稍后到达时，`waitForGate` 的回调已经 resolved，但 `runPrompt` 的 `isDeletedNow()` 检查会在 topic 到达后、status 更新前拦截：
- gate 成功路径: `if (await isDeletedNow()) return { status: "deleted" }` [源码锚点] `childSession.ts:608-616`
- sink 不会被投递

**结论**: 级联删除正确抑制了已删除 child 的后续 sink 投递和状态复活。

[源码锚点] `childSession.ts:585-592,608-616,656-663` [测试对账] `childSession.test.ts:687-718`

### 12.4 Codex 的 cumulative usage 未归一化导致标题显示异常

**假设**: Codex backend 在一次 run 中发出多个 usage 事件，每个事件包含的是累计值而非增量值。

**实际行为**: `replier.consume` 中，codex 路径使用 `normalizeCumulativeUsageEvent(event, usageBaseline)` 将累计值转换为增量值，再 `accumulateUsage()`。如果没有 `usageBaseline`（首次 run），则直接使用事件值。若错误地未启用 `normalizeCumulativeUsage`，标题中的 token 数会呈指数级膨胀（如 24M/272k）。

**结论**: `normalizeCumulativeUsage` 标志和 `usageBaseline` 的存在是正确显示的前提。dispatcher 和 childSession 都会为 codex 传入 baseline [源码锚点] `dispatcher.ts:605-608`, `childSession.ts:380-383`。

[测试对账] `replier.test.ts:653-700`

### 12.5 同一 commId 的 sink attempt 重复记录

**假设**: watcher 多次调用 `redeliverResultSinks` 对同一个 spawnCommId 重投。

**实际行为**: `redeliverResultSinks` 每次生成新的 `sink_attempt_id`（默认 `sink_redeliver_${randomUUID()}`），并独立插入 `result_sink_attempts`。DB 不限制同一 commId 的重复记录。ThreePhaseCheck 在验证 delivery 时只检查 `"delivered"` 记录的存在性，不检查唯一性。

**结论**: 重复投递不会产生数据错误，但可能导致 audit 表膨胀。当前无去重机制。

[源码锚点] `resultSinkEngine.ts:75-77`

### 12.6 /btw 在 child 已被手动删除后再次调用

**假设**: `/btw` 创建了一个 child session。10 分钟 idle timer 触发前，用户通过 `/delete` 或其他手段手动删除了该 child。

**实际行为**: 下一次 `/btw` 调用时，`entries.get(msg.groupId)` 返回旧的 entry。`deps.store.findSessionById(existing.childSessionId)` 会返回 `null` 或 `status="deleted"`。此时 handler 清除 stale entry 并走 spawn 新 child 的分支。

**结论**: `/btw` 对 stale entry 有防御性处理，不会 resume 一个已删除的 session。

[源码锚点] `commands/btw.ts:119-127`

### 12.7 boot 时 running run 的 session 实际不 busy

**假设**: 前一次 console 崩溃前，某个 session 的 message_run 状态为 running，但 session.status 已被错误地更新为 idle。

**实际行为**: `reconcileBackendProcessesCheck` 在 observe 模式下会区分：只报告 `session.status !== "busy"` 的 hanging run [源码锚点] `checks/reconcileBackendProcesses.ts:41-47`。在 execute 模式下，所有 running run 都会被 timeout（无论 session 状态如何），因为 backend 进程已成为孤儿（ppid=1），stdout 流已断，run 不可能自行完成。

**结论**: execute 模式的 reconcile 是 forward-biased 的——宁可将合法 run 误杀（极少见，因为 console 重启时所有 backend 都死了），也不留下永远挂起的 run。

[源码锚点] `checks/reconcileBackendProcesses.ts:63-106` [测试对账] `reconcileBackendProcesses.test.ts`

### 12.8 spawnChild 的 onSessionReady hook 抛异常导致 caller 收到 500

**假设**: HTTP `/api/spawn` async kickoff 模式下，`onSessionReady` hook 抛异常。

**实际行为**: `runPrompt` 中 `await hooks.onRunStarted?.()` 被 try-catch 包裹，错误被 `console.warn`  swallowed，spawn 继续执行 [源码锚点] `childSession.ts:308-319`。HTTP handler 在 async kickoff 模式下已于 `onSessionReady` 时返回 202，不受后续 hook 异常影响。

**结论**: `onSessionReady` 的错误不会污染 spawn 结果，但会丢失 ready 通知（如 202 响应已在之前发送，实际无影响）。

[源码锚点] `childSession.ts:308-319` [测试对账] `childSession.test.ts:937-955`

---

## 附录 A：术语速查表（与 00-skeleton.md 一致）

| 术语 | 定义 | 本 PRD 出现章节 |
|------|------|----------------|
| Session | 基本工作单元 | 2, 3, 5 |
| Message Run | 单次 prompt 执行周期 | 1, 3, 4 |
| Child Session | 派生临时会话 | 3, 6, 8 |
| Spawn Closure | 异步 spawn 全生命周期追踪 | 6 |
| Spawn Predicate | 验证 child 结果的断言 | 7 |
| Result Sink | 结果投递目标 | 3, 6, 8 |
| Event Awaited Worker | 等待 topic 的 child 类型 | 3 |
| Boot Self-Check | 启动健康检查 | 9 |
| ThreePhaseCheck | admission/execution/delivery 判定 | 6 |
| CompletedCleanly | replier 的最终结果门 | 4 |

---

## 附录 B：关键源码文件索引

| 文件 | 职责 |
|------|------|
| `src/app/dispatcher.ts` | 消息分发总线 |
| `src/app/sessionLifecycle.ts` | create/delete/reset/restart |
| `src/app/childSession.ts` | spawnChild/resumeChild/runPrompt |
| `src/app/replier.ts` | consume / card 更新 |
| `src/app/commandRegistry.ts` | 命令元数据注册表 |
| `src/app/commandRouter.ts` | 命令路由与错误处理 |
| `src/app/processLifecycle.ts` | graceful stop 状态机 |
| `src/app/resultSinkEngine.ts` | sink 投递引擎 |
| `src/app/spawnClosure/threePhaseCheck.ts` | closure 判定逻辑 |
| `src/app/spawnClosure/registerAsyncItem.ts` | async 降级注册 |
| `src/app/spawnClosure/closureLog.ts` | 生命周期日志 |
| `src/app/spawnPredicate/schema.ts` | predicate Zod schema |
| `src/app/spawnPredicate/evaluate.ts` | predicate 评估总线 |
| `src/app/spawnPredicate/evaluators/*.ts` | 各类型 evaluator |
| `src/app/bootSelfCheck/index.ts` | 检查执行引擎 |
| `src/app/bootSelfCheck/checks/*.ts` | 各检查项实现 |
| `src/app/commands/*.ts` | 各命令 handler |
