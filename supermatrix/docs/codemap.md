# Codemap：/now Live Steer 勘察档案

> 更新日期：2026-08-04（新建）。范围：围绕 `/now` 落地（Claude stream-json replay ack、Codex per-run app-server turn/steer、Kimi unsupported）的现状勘察，非全仓覆盖。
> 方案文档：`docs/superpowers/plans/2026-08-04-now-live-steer.md`（untracked）。
> 版本锁定已核实与本机一致：Claude Code 2.1.220、codex-cli 0.146.0（`codex app-server` 子命令存在，标注 experimental）、kimi 0.30.0。

## 1. 相关现有能力清单（谁已经在做类似的事）

### 命令路由 / 命令实现
- `src/app/commandRegistry.ts`（746 行）— 声明式命令表（name → Command + placeholderHandler），`buildCommandRegistry()` 末尾强制 `assertCommandRegistryPolicy`。`/next` 声明在 L608-624（scope user、rest 参数 `text`），`/cancel` 在 L147-175。
- `src/app/commandRegistryPolicy.ts` — **硬编码审批白名单**（29 条，name → owner + scopes，双向校验）。`/now` 尚未在表内；不加白名单则 `buildCommandRegistry()` 启动即 throw。
- `src/app/commandRouter.ts`（44 行）— scope 检查（L27-29）+ 调 handler + UserError/SystemError → `❌` 文案统一转换。
- `src/domain/parseCommand.ts` — NFKC、shell tokenize、canonicalizeToken、param scope 消费。
- `src/app/commands/help.ts` — 从 registry 自动渲染 help/签名/notes；新命令写好 description/params/notes 即零额外工作。
- `src/app/commands/next.ts`（40 行）— **与 /now 最接近的样板**：`resolveUserGroupSession(msg.groupId)` 拿绑定 → `findSessionByName` → 拒 deleted/error → **origin 自查 `msg.origin !== "lark_user"` 静默 return**（L26-28）→ enqueuePendingNext → `{ replyText }`。busy 判定只看 `session.status`，不查 message_runs。
- `src/app/commands/cancelSession.ts`（49 行）— user/root 双 scope 参数兼容、`clearPendingNext` + `deps.cancel(session.id)`，无 busy 校验。

### dispatcher 主链（busy guard / FIFO / run 创建）
- `src/app/dispatcher.ts`（1205 行）`handleInbound` L527 起：
  - **命令分支 L616-668，末尾 L668 `return` —— 任何注册进 registry 的 slash 命令天然在 busy guard 之前路由完毕**；busy guard 在其后：L722 `session.status === "busy"` + L731 `findRunningMessageRunBySession` 双道。`/now` 不需要任何"绕过 busy guard"的新机制。
  - `allowCommandRouting = msg.origin !== "framework_synthetic"`（L572-579）是命令入口的信任门。
  - `EMPLOYEE_BLOCKED_COMMANDS`（L60-76）：员工 category 的命令黑名单，不含 next/cancel；`/now` 是否加入是一个显式决策点。
  - `/next` FIFO：类型/消费端在 dispatcher（`PendingNextStore = {has, shift, restoreFront}` L50-54；`drainPendingNext` L485-525，防重入 + idle 且无 running 行才 drain + `framework_synthetic` 合成消息递归 `handleInbound`），**队列容器在 bootstrap**（L947-981 `pendingNextMap`，enqueue 只属于 handler 侧）。
  - run 创建：L816 `runId = asMessageRunId(idFactory())` → L818 `startMessageRun` → L827 置 busy；RunInput 构造 L869-899。**runId 只流向 replier/tokenUsage/codexRuntimeRecovery，从不进 RunInput。**
- `src/app/runOnSession.ts`（369 行）— 第二个生产 run creator（API 面）。L85-92 busy 双查（明确「refuse rather than queue，API 要 409」）；L114 startMessageRun；**L166-170 RunInput 只有 `{session, prompt, attachments: []}`（连 execution 都不传）**。
- `src/app/childSession.ts`（1350 行）`runPrompt` — 第三个生产 run creator。L832-840 startMessageRun；L847 `runInput = { session, prompt }`；**唯一把 runId 外发的钩子是 `hooks.onRunStarted/onBackendStarted({session, messageRunId})`（L845/L960）**。

### Port 契约与持久层
- `src/ports/AgentBackend.ts`（42 行，全文即契约）— `RunInput` 字段：session/execution?/prompt/attachments?/systemHint?/answerOnly?/cardAskEnabled?/cardAskChatId?/conversationFork?。**无 messageRunId；`AgentBackend` 只有 kind/run/cancel，无 steer**。方案 Task 1 的两处契约扩展（`RunInput.messageRunId` + `steer?`）都是净新增。
- `src/ports/BindingStore.ts` + `src/adapters/store-sqlite/index.ts`：
  - **`findRunningMessageRunBySession(sessionId)` 已存在**（port L704；sqlite L1472-1505，`status='running' ORDER BY started_at DESC LIMIT 1`，返回完整 MessageRun）。/now 的 running 行查询零新增。
  - `startMessageRun` L1362（硬编码 status="running"）、`finishMessageRun` L1402、`findRunningMessageRuns()` 全库版 L1706（boot reconcile 用）。
  - `RuntimeConfigMutationGuard = {kind:"active-run", messageRunId}`（port L145-147）已是「带 WHERE 当前态的原子守卫」先例。
  - fake：`tests/fakes/fakeBindingStore.ts` 两个方法均已实现（L947/L986）。

### backend-claude adapter（Task 2 改造对象）
- `commandBuilder.ts`（155 行）— `ClaudeCommand = { args, stdin?: string }`。**`--input-format stream-json` + stdin JSON user envelope 的拼装已存在，但只在有 native image 时启用**（L134-144，单行 `{"type":"user","message":{...}}` + `\n`）；默认路径 prompt 走 argv 尾参。全仓无 `--replay-user-messages`。
- `process.ts`（195 行）— `spawnAndStream`。**stdin 一次性**：无 stdin 串则 fd0=`"ignore"`（连管道都没有）；有则 `child.stdin.end(opts.stdin)` 写完即关（L119-122）。`StreamHandle = {iterable, cancel, pid}`，**不带 session/run 标识、不暴露 stdin writer**。detached 进程组 + SIGTERM→SIGKILL、inactivity/maxRuntime 双 timer、手写 queue+waiter、iterator `return()` 即 cancel。
- `index.ts`（152 行）— `inflight = Map<SessionId, StreamHandle>`（L35，**key 无 runId，resume retry 会覆盖 entry**）；`start()` 注入 `SM_SESSION_NAME` + per-run caller attestation；`runWithResumeRecovery`（L97-141）缓冲 started 事件、thinking-block poison 时以 `backendSessionId: null` 重开 —— 方案要求「注入文本不得从失败 resume 跳进 fresh retry」正是打在这段的换 handle 竞态上。
- `streamParser.ts`（306 行）— `type:"user"` 分支（L144-170）**只认 `tool_result` block，replay 的 text user block 会被静默丢弃**；`AgentEvent` union（`src/domain/events/agentEvent.ts`）只有 started/thinking/tool_call/tool_result/assistant_message/error/completed/usage，无 replay/ack 事件类型。replay ack 的匹配逻辑需在此或 process 层新增。

### backend-codex adapter（Task 3 改造对象）
- `index.ts`（177 行）— `inflight = Map<SessionId, StreamHandle>`；`run()` 顺序：commandHealthCheck（只探 `--version`）→ card-ask 健康降级 → `preflightCodexState` 改写 input → `start` → finally 清 inflight + revoke attestation。`SM_CODEX_CLI_PATH` env 优先。
- `commandBuilder.ts`（112 行）— `buildCodexArgs`：`exec [resume <id>] --json`、answerOnly→`--sandbox read-only --ephemeral`（且强制不 resume）、否则 `--dangerously-bypass-approvals-and-sandbox`、`--model`、`-c model_reasoning_effort=`（含 effort 归一 evidence 回调）、card-ask 走 4 组 `-c mcp_servers.askserver.*` TOML override、非 resume 才 `--cd`、`--image` 变参 + `--` 终止符、conversationFork 直接 throw。`resolveCodexExecutionModel/Effort` 是 model pin 单一来源（不落库）。
- `process.ts`（259 行）— `stdio: ["ignore","pipe","pipe"]`（**无 stdin 管道**）；`normalizeCodexChildEnv`（proxy 大小写补齐，forkBootstrap 复用）；stderr 已知噪声过滤（stdin-prompt 提示、model_manager 超时正则）与 exec 强绑定；进程组 kill / timer / queue 结构与 claude process.ts 同构。
- `streamParser.ts`（509 行）— exec `--json` **snake_case** 事件全表 → AgentEvent（thread.started/turn.completed/token_count/agent_message commentary/function_call(_output)/item.started|completed/last_assistant_message/error + flush）；usage 归并 `outputTokens = raw - reasoning`、coarse/rich 同 turn 合并。app-server 是 camelCase，这层是纯翻译改写面。
- 周边：`statePreflight.ts`（直读 `~/.codex/state_5.sqlite` 判 resume rollout 有效性，**决定 start vs resume**，answerOnly 跳过）；`forkBootstrap.ts`（独立一次性 `codex exec resume` 子进程，方案明确不扩大 fork 行为，迁移后将是仓内最后一处 exec 调用）；`modelUnavailable.ts`（**对 error message 文本做谓词匹配**——app-server 错误形状变了会断 codexRuntimeRecovery 降级链）；`modelAvailabilityProbe.ts` / `defaultModelResolver.ts` 不在 run 主路径。
- `src/app/codexRuntimeRecovery.ts` — 上游消费者；`createCodexRuntimeRecoveryRun` 的输入已含 `messageRunId`（L86），靠「重开一次 run」做 model 降级重试——迁移后每次重试 = 重开一个 per-run app-server 进程。

### backend-kimi（unsupported 路径 + JSON-RPC 参考件）
- `src/adapters/backend-kimi/acpClient.ts` — 共享单例 ACP client。**内含手写 stdio JSON-RPC 旁路，是仓内现成的最小 JSON-RPC client 范式**：`sendRawRequest(method, params, timeoutMs)`（L612-625，`sm-raw-<n>` id 命名空间 + `rawPending Map` + 超时 reject）、`routeRawResponse(line)`（L728-748，按 id 前缀截流吞行）、行级预过滤多消费者分发、`state/ensureReady/invalidate/waitForChildExit/dispose` 生命周期。注意语义差异：kimi 是进程级共享单例 + updateRouters 路由；codex app-server 是 per-run 进程，路由表不需要，pending/timeout/liveness 那套可直接借鉴。
- `src/app/kimiAutonomousTurnWatch.ts` / `kimiAutonomousTurnStream.ts` — 从 kimi wire.jsonl 文本扫 `"turn.steer"` 字面量的**同名不同物**，与 Codex app-server 协议无关，勿动勿混。
- Kimi steer 可行性已闭环：`runs/2026-08-04-kimi-steer-probe/`（README + probe-steer.mjs + wire.jsonl 275 帧）证明 ACP 面 mid-turn `session/prompt` 被 `-32600 turn.agent_busy` 立即拒绝、无 `session/steer` 方法、引擎内部 steer 能力未暴露。**方案「Kimi 明确 unsupported」的证据无需重做。**

### 测试基建
- `tests/adapters/backend-claude/`：`fakeClaude.sh`（scenario case 分发，**只写不读 stdin**）；`process.test.ts` L25-38 已有「断言 stdin 内容」的 `/bin/sh -c read -r line` 模板；`index.test.ts` 用 `buildArgs: () => ["scenario"]` seam（**从不供 stdin**）；`streamParser.test.ts` 无 replay text user 用例；`samples/` 为合成 fixture（re-record 脚本 `scripts/spike-claude-stream.sh`）。
- `tests/adapters/backend-codex/`：`fakeCodex.sh` 13 个 scenario，同样**只写不读，无请求/响应配对能力**——app-server 测试必须新建能按 id 回响应的 fixture。
- `tests/adapters/backend-kimi/fakeAcpServer.ts` — **现成的「读 stdin JSON-RPC 请求、按 id 回响应」fixture 范式**（L86 手写 response、L213 notification），是 codex fake app-server 的直接参照物。
- `tests/app/codexRuntimeRecovery.test.ts`（1212 行）— 不伪造进程，用 `scriptedRun(AgentEvent[][])` 直产事件流；但 import 了 `buildCodexArgs` 和 modelUnavailable 谓词，argv/错误文本变更会打到它。
- `tests/app/commands/`（30 文件）— 无共享 harness；惯例：直接 import handler + 文件内 `makeSession/msg` 工厂 + 内联 deps + 断言 `result.replyText`；共享件仅 `tests/fakes/fakeBindingStore.ts`。registry 层测试在 `tests/app/commandRegistry.test.ts`（含 policy 审批断言）。

## 2. 入口与分层约定

- 六边形分层 `src/domain/ → src/ports/ → src/adapters/ | src/app/ | src/cli/`，`scripts/check-deps.ts`（`npm run lint:deps`）强制方向。新代码落点：
  - `/now` handler → `src/app/commands/now.ts`（新建，仿 next.ts）；声明进 `commandRegistry.ts` + **白名单进 `commandRegistryPolicy.ts`**；handler 绑定在 `src/cli/bootstrap.ts` L837-945 段（`resolveUserGroupSession` 共享 helper 在 L801-806）。
  - 契约扩展 → `src/ports/AgentBackend.ts`（RunInput.messageRunId + steer?）。
  - Claude steer → `src/adapters/backend-claude/{commandBuilder,process,index}.ts`；Codex app-server → `src/adapters/backend-codex/` 新建 `appServerProcess.ts` / `appServerProtocol.ts`。
- backendRegistry 装配在 `bootstrap.ts` L543-565；dispatcher 装配 L1013-1040（`idFactory: "mr_" + uuid.slice(0,8)`）。
- 测试：vitest，**绝不接管道**（`| tail/head/grep` 会 SIGPIPE 孤儿 worker）。焦点跑法 `npx vitest run tests/adapters/backend-claude` 等；提交前 `npm run lint:deps` + `npm run typecheck` + `npm run verify`。
- 触及 lark-cli / apiServer / adapters 的改动，除自动化测试外跑 `docs/SMOKE.md` 对应段（§5 /cancel、§167 Kimi backend 段是 /now checklist 的挂点）。
- 提交前在 `SM-SOURCE-CHANGES.md` 记 Files/Problem/Change/Verification；仓库 local-only，不加 remote/push/PR。
- 激活走 source-watcher 安全 reload（注意：watcher 只看 `src/` 且全项目 tsc 预检，tests-only 修复不重触发）。

## 3. 别重造清单（已存在，直接用）

1. **busy guard 之前的命令路由**：dispatcher 命令分支 L668 提前 return，天然先于 L722/L731 busy 双道。**不需要任何新的"/now 优先路由"机制**，注册即得。
2. **running 行查询**：`findRunningMessageRunBySession` port+sqlite+fake 三处齐备，已被 busy guard、drainPendingNext、runOnSession、kimiAutonomousTurnWatch 四处消费。/now 直接复用，勿新写 SQL。
3. **stdio JSON-RPC client**：`acpClient.ts` 的 sendRawRequest/rawPending/routeRawResponse + `fakeAcpServer.ts` 测试 fixture。codex appServerProtocol 按此范式写 per-run 版，勿引新依赖（方案也禁新 npm 依赖；注意 `@zed-industries/agent-client-protocol` 是 ACP 专用 lib，codex app-server 不能复用它，能复用的是手写旁路的模式）。
4. **Claude stream-json stdin 拼装**：image 路径已有 `--input-format stream-json` + user envelope 序列化（commandBuilder L134-144），Task 2 是把它扩为全路径默认 + 保持 stdin 打开，不是从零写。
5. **stdin 内容断言测试模板**：`tests/adapters/backend-claude/process.test.ts` L25-38。
6. **Kimi unsupported 证据**：`runs/2026-08-04-kimi-steer-probe/` 已完成四种语义判定 + 二进制静态核对，直接引用。
7. **进程组 kill / inactivity/maxRuntime timer / queue+waiter 事件泵**：claude 与 codex 的 process.ts 已各有一份同构实现（既有重复，二处并存是现状）；appServerProcess 应沿用同一形状，不发明第三种生命周期。
8. **caller attestation / SM_SESSION_NAME 注入、card-ask 健康降级、effort 归一 evidence**：两 adapter 的 run() 已有完整链，app-server spawn 必须原样保留（方案 Task 3 lifecycle 第 1 条），不重写。
9. **原子守卫先例**：`RuntimeConfigMutationGuard {kind:"active-run", messageRunId}` + sqlite `EXISTS(... status='running')` 子查询——「带 WHERE 当前态」的写法已有模板。
10. **/next FIFO**：pendingNextMap（bootstrap）+ drainPendingNext（dispatcher）语义保持不变，/now 不碰它、失败不回落到它（方案红线）。
11. **同名陷阱**：`kimiAutonomousTurnWatch/Stream` 里的 `turn.steer` 字符串扫描是 kimi 引擎内部事件，与 codex `turn/steer` RPC 无关；grep 时勿误判"已有实现"。

## 4. 可复用扩展点（加功能优先改这里）

- **契约面**：`src/ports/AgentBackend.ts` 加 `RunInput.messageRunId` + `AgentBackend.steer?`；typecheck 会自动揪出三个 run creator（dispatcher L869 / runOnSession L166 / childSession L847）漏传——三处的 runId 局部变量都现成（L816 / L113-114 / L832-840）。
- **handle 身份**：两 adapter 的 `inflight: Map<SessionId, StreamHandle>` 是 steer 原子比对的挂点——handle 需带 `messageRunId`（codex 另加 threadId/turnId）；claude 侧注意 resume retry 覆盖 entry 的窗口（index.ts L111-125）。
- **Claude replay ack**：streamParser `type:"user"` 分支（L144-170）是 replay 消息唯一落点，当前静默丢弃 text block；ack 匹配可在此挂钩或在 process 层旁路，FIFO 匹配归 handle。
- **Codex 迁移面**：commandBuilder 保留 legacy exec 导出（forkBootstrap 还用）；streamParser 的 snake_case→AgentEvent 映射表是 camelCase 翻译的对照基准；`statePreflight` 输出直接决定 `thread/start` vs `thread/resume`。
- **命令侧**：next.ts 的 deps 形状（store + resolveUserGroupSession + 注入动作闭包）即 /now handler 的模板；bootstrap L837-945 加一行绑定。
- **测试**：fakeAcpServer.ts 范式 → 新建 fake codex app-server fixture；fakeClaude.sh 加"读 stdin 并 replay"scenario；`scriptedRun` 模式覆盖 app 层。

## 5. 已核实的风险 / 波及点（拆解任务时要显式覆盖）

- **argv 形状是外部依赖**：`src/adapters/process-lister-ps/index.ts:12-17` 的 `RESUME_RE` 和 `tests/app/bootSelfCheck/checks/reconcileBackendProcesses.test.ts:349` 匹配字面 cmdline `claude -p --output-format stream-json "processing"`——两端 argv 改动会打到 boot 孤儿 reconcile。
- **modelUnavailable 文本谓词**：app-server JSON-RPC error 的 message 若与 exec 文案不同，`isConfirmedCodexModelUnavailable/isCodexModelAtCapacity` 失效 → codexRuntimeRecovery 降级链断。
- **stderr 噪声过滤**：process.ts 的 codex 噪声正则与 exec 输出强绑定，app-server 的 stderr 语义需重新核。
- **statePreflight 假设 app-server 与 exec 共享 `~/.codex/state_5.sqlite` threads 表**——迁移前需实证。
- **commandHealthCheck 只探 `--version`**，不证明 `app-server` 子命令可用。
- **origin 双门**：dispatcher 层 `framework_synthetic` 不进命令路由 + handler 层 `msg.origin !== "lark_user"` 静默——/now 照抄 next.ts 即两门齐备。
- **员工黑名单决策点**：`EMPLOYEE_BLOCKED_COMMANDS` 是否收 /now 需要显式决定（next/cancel 均不在内）。
- **RunInput 差异**：runOnSession 不传 execution、childSession 只传 `{session, prompt}`——加 messageRunId 时三处形状不同，别只改 dispatcher。
