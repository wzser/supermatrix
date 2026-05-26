# Heartbeat 心跳机制功能说明

状态：当前实现说明  
更新时间：2026-05-09  
Owner session：`heartbeat`  
主类目：平台 session

## 1. 一句话说明

Heartbeat 是一个平台级巡检 session。它每 10 分钟检查已开启心跳的 SuperMatrix session，识别“应该继续推进但停住了”的工作，并用受控动作把原 session 推回正确轨道。

它解决的不是“替业务做决策”，而是“不要让已经明确要完成的事项静默停住”。

## 2. 主要功能

### 2.1 定时巡检 session

当前由 scheduler 每 10 分钟触发一次。任务名仍是历史名称 `heartbeat-hourly-patrol`，实际 cron 已改为 `*/10 * * * *`：

```bash
<SM_WORKSPACE_ROOT>/heartbeat/scripts/heartbeat-patrol
```

巡检入口会读取 SuperMatrix 主库：

```text
<SM_RUNTIME_ROOT>/data/supermatrix.db
```

被扫描的 session 必须满足：

- `heartbeat_enabled = 1`
- session 没有被删除
- session 不是 child session
- session 不是 `heartbeat` 自己

换句话说：heartbeat 面向普通业务/平台 session；child session 和 heartbeat 自身不会被递归巡检。

### 2.2 识别未完成事项

Heartbeat 会重点识别几类信号：

1. 最新 run 失败、超时、取消或错误。
2. run 仍在 running，但已经超过 stale 阈值。
3. session 已经按一个明确的多步计划完成前几步，然后停在“要不要继续剩余步骤”这类机械继续点。
4. cross-session 子任务 pending/running 太久。
5. cross-session 子任务失败或超时。
6. session 自身处于 `error` 状态。

已经修正的关键规则：

- 非 stale 的 running run 必须跳过，不再触发心跳。
- 普通 `busy/running` session 状态本身不构成触发条件。
- 明确的用户暂停、取消、等待下次，不会被当作应该继续。
- 真实业务选择门，例如需要新参数、新方案、新审批，默认不会自动推进。

### 2.3 预筛，减少模型浪费

早期方案是每轮巡检把所有 session 最近消息都发给模型判断。现在不是这样。

当前实现先走本地 deterministic prefilter：

```text
heartbeat_patrol/prefilter.py
```

只有本地规则发现候选信号时，才把该 session 的 bounded packet 发给模型。没有候选信号的 session 只写本地 `session_prefilter_skip` 事件，不调用模型，也不同步到飞书。

这解决了两个问题：

- 避免每轮全量喂历史消息给模型造成 token 浪费。
- 避免正常 idle/completed session 被模型过度解读。

### 2.4 用 MiniMax M2.7 做主控判断

当前主控模型默认是 MiniMax M2.7：

```text
HEARTBEAT_CONTROLLER_PROVIDER=minimax
HEARTBEAT_CONTROLLER_MODEL=MiniMax-M2.7
```

主控模型只做一件事：对候选 session 输出结构化 JSON 决策。

默认策略是 conservative：

- 没有明确证据就 `skip`
- 不把真实用户选择门自动继续
- 不碰非 stale 的 running run
- 不把一个已完成且无剩余事项的回答再拉起来

如果 MiniMax 调用被限流，或者 JSON 修复失败，系统会走升级模型：

```text
HEARTBEAT_ESCALATION_MODEL=gpt-5.5
```

升级路径只用于控制判断或复杂风险，不再使用 gpt-5.4 作为升级模型。

### 2.5 支持多种触发动作

模型决策只允许以下动作：

| 决策 | 含义 | 用户是否可见 |
|---|---|---|
| `skip` | 无动作，仅本地记录 | 否 |
| `alert` | 缺参数/真人决策阻塞；bot 提醒，同时以 user 身份触发原 session 向用户明确提问 | 是 |
| `spawn_collect` | spawn 子 session 收集证据 | 通常是目标 session 可追溯 |
| `spawn_execute` | spawn 子 session 执行明确、可逆、owner 范围内的后续动作 | 通常是目标 session 可追溯 |
| `escalate` | 用 gpt-5.5 处理高影响风险 | 通常是目标 session 可追溯 |
| `user_resume` | 以 user 身份往原 session 群发一句自然推进消息 | 是 |

当前最重要的是 `user_resume`。它用于处理“原 session 已经可以继续，但停在那里等一句人类确认”的情况。

## 3. Todo Pool 主动消化

Heartbeat 还维护一个本地 per-session 待办池。它和历史卡住事项不冲突，当前优先级是：

```text
1. hard alert / escalation / explicit execution blocker
2. ready recovery todo
3. normal heartbeat user_resume / spawn_collect
4. normal todo pool
```

普通待办仍然只在“没有历史卡住动作，且 session 当前是 idle”时消化。恢复型待办例外：如果历史动作只是 timeout 等软异常，而待办池里已经有 ready 的 async/child/状态对齐恢复项，heartbeat 会优先注入 recovery todo。

硬阻塞不会被待办绕过。尤其是缺参数、需要真人确认或高风险升级时，`alert` 会先触发原 session 向用户明确提问；在参数没有补齐前，不主动消化后面的待办。

待办写入使用本地 SQLite 幂等：

```text
(target_session, logical_key)
```

同一个目标 session 和同一个 logical key 重复写入时不会生成第二条待办。

### 3.1 Auto Batch

待办支持自动合批，写入方不必强制提供 `batch_key`。生成优先级是：

1. 显式 `batch_key` 优先。
2. 如果有 `source_ref`，按 `target_session + source_session + todo_type + source_ref` 自动生成 batch。
3. 如果没有 `source_ref`，复用同一 `target_session + source_session + todo_type` 最近 open 的时间窗口 batch。
4. 如果需要单独执行，可以用 `batch_mode=single` 关闭合批。

批次 ready 的条件：

- 达到 `expected_count`
- 或最后一条待办进入后超过 `settle_after_seconds`
- 或批次总等待超过 `max_wait_seconds`

ready batch 会合成一条 user message 注入，例如：

```text
以下是同一批待办，请一次性处理并汇总：

批次：<batch_key>
1. <todo message 1>
2. <todo message 2>

请按这些输入统一处理，完成后给出汇总结论。
```

注入成功后，同批所有 todo 都会标记为 `injected`，避免重复注入。

### 3.2 Recovery Todo

恢复型待办用于解决“异常表象其实只是异步回收”的场景。当前优先类型：

- `async_handoff_recovery`：例如 ATP / async child 报告已经回到 `comm_*` 或 result sink。
- `child_recovery`：child 已 timeout/dead，需要原 session 做明确补做。
- `child_result_delivery`：child 已完成，但原 session 还缺最后交付/同步动作。
- `handoff_ack`：handoff 已幂等写入，需要原 session ack/收口。
- `spawn_closure`：spawn 闭环 watcher 已确认需要重推目标 session，交给 heartbeat 注入唤醒。
- `status_reconcile`：底层工作已完成，但旧 pending/spawn 状态需要对齐或关闭。

### 3.3 Enqueue CLI

当前本地写入入口：

```bash
scripts/enqueue-heartbeat-todo \
  --session <name> \
  --key <stable-key> \
  --message "<exact user instruction>" \
  --source <source> \
  --source-session <source-session> \
  --source-ref <source-ref> \
  --todo-type <type> \
  --expected-count <n>
```

`--source-ref` 和 `--expected-count` 适合 fan-out/fan-in 场景：例如 15 个子 session 陆续返回时，可以共享同一个 `source_ref`，达到 15 条后一次性注入汇总任务。

## 4. `user_resume` 是怎么做的

`user_resume` 是 heartbeat 里最敏感的动作，因为它会用 `--as user` 往目标 session 的群里发消息，等同于用真人身份推动原 session 继续。

当前实现有几层保护。

### 4.1 主控只决定“应该 user_resume”，不直接写回复

主控模型输出的是 composer guidance，不是最终要发出去的话。例如：

```json
{
  "decision": "user_resume",
  "logical_key": "first-principle:mr_123_rate_limit",
  "reason": "latest run failed due to transient provider rate limit and original prompt still has unfinished work",
  "prompt": "Ask the session to continue the interrupted work from the rate-limit failure without adding new requirements."
}
```

### 4.2 回复内容由 heartbeat 自己的子 session 生成

生成最终 user 消息时，系统调用：

```text
HeartbeatApi.compose_user_resume_message(...)
```

它不是基于目标 session 自己开子 session 生成，而是 target 到 `heartbeat` 自己：

```json
{
  "target": "heartbeat",
  "from": "heartbeat",
  "backend": "codex",
  "mode": "sync_inline",
  "model": "<child_model>",
  "prompt": "<user resume compose prompt>"
}
```

这样做的原因是：回复内容必须站在 heartbeat 的控制视角生成，而不是让目标 session 自己补完一段看起来像“我已经交付了”的话。

### 4.3 composer 的回复规则

composer prompt 明确要求：

- 只返回要发到群里的正文。
- 使用目标 session 的语言和上下文。
- 语气自然、简短、具体。
- 不提 heartbeat、自动化、child session、spawn、scheduler 或内部系统。
- 不提出新需求、新参数、新审批、新业务选择。
- 不替目标 session 声称“已经完成、已经交付、已经修正、已经发出”。
- 不以目标 session 的身份说话。

### 4.4 发送前还有正则保护

发出前会经过：

```text
_normalize_user_resume_message(...)
```

它会拒绝一些目标 session 视角的危险句式，例如：

- “修正版已经交付到群里了”
- “已经按要求修正”
- “我继续跟进”
- “已经完成/处理/提交”

如果命中这些模式，本次 `user_resume` 会失败并释放 claim，不会把错误内容发出去。

### 4.5 去重保护

`user_resume` 使用 `action_claims` 表做幂等：

```text
PRIMARY KEY (action_type, target_session, logical_key)
```

同一个 session、同一个 logical key，已经成功发过一次，就不会在后续巡检里重复发同一句推动消息。

## 5. 运行链路

一次完整心跳大致是这样：

```text
scheduler every-30-min task
  -> scripts/heartbeat-patrol
    -> load_config()
    -> PatrolRunner.run_once()
      -> state.start_patrol()
      -> reader.list_enabled_sessions()
      -> 并发处理每个 session
        -> reader.build_packet()
        -> prefilter.should_check_with_model()
        -> build_controller_prompt()
        -> MiniMax M2.7 / gpt-5.5 输出 JSON 决策
        -> parse_decision() 做 schema 和 safety 校验
        -> runner 根据 decision 执行动作
      -> state.finish_patrol()
      -> 如果配置了飞书日志表，同步成功触发事件
```

每个 session 的输入包主要来自：

```text
sessions / bindings
message_runs
cross_session_log
```

每条 recent run 会保留：

- run id
- prompt
- started_at / finished_at
- status
- final_message
- error_message

长文本会截断到安全长度，避免单个 session 历史过大。

## 6. 模型输出和校验

模型必须返回 JSON，不允许 markdown：

```json
{
  "session": "target-session-name",
  "items": [
    {
      "logical_key": "target-session-name:stable-key",
      "severity": "info",
      "decision": "user_resume",
      "reason": "evidence-grounded reason",
      "target_session": "target-session-name",
      "child_model": "gpt-5.4-mini",
      "prompt": "composer guidance or child prompt"
    }
  ]
}
```

解析器会强校验：

- 顶层 `session` 必须等于当前 packet 的 session name。
- `target_session` 必须等于当前 packet 的 session name。
- `logical_key` 必须以 `<session-name>:` 开头。
- `decision` 必须在允许列表内。
- `escalate` 必须用 `gpt-5.5`。
- `prompt` 不能含有危险跨 session 指令，例如要求自己 spawn scheduler、调用 ATP、修改 unrelated state 等。
- 每次最多 12 个 item。

这保证模型不能随意跨 session 发散，也不能把 heartbeat 变成任意任务分发器。

## 7. spawn 动作怎么执行

对于 `spawn_collect`、`spawn_execute`、`escalate`，heartbeat 调用本机 SuperMatrix HTTP API：

```http
POST http://localhost:3501/api/spawn
```

payload 形态：

```json
{
  "target": "<target_session>",
  "from": "heartbeat",
  "backend": "codex",
  "mode": "async_kickoff",
  "model": "<child_model>",
  "prompt": "<bounded child prompt>"
}
```

这里使用 `async_kickoff`，避免心跳主循环被长任务卡住。

每个 spawn 会先 claim：

```text
child_spawns(target_session, logical_key)
```

如果同一个 logical key 已经有 child 在跑，就记录 `spawn_skipped_duplicate`，不会重复 spawn。

子 prompt 会自动追加 no-cascade 约束：

```text
Do not spawn other sessions unless heartbeat explicitly asked you to.
Return this structure: evidence found, action taken, remaining blocker, human attention needed.
```

## 8. 日志和飞书同步

### 8.1 本地日志是权威

本地 SQLite 是权威日志：

```text
<SM_WORKSPACE_ROOT>/heartbeat/data/heartbeat.sqlite
```

核心表：

| 表 | 用途 |
|---|---|
| `patrol_runs` | 每轮心跳的整体记录 |
| `heartbeat_events` | 每个事件的细粒度日志 |
| `child_spawns` | spawn 幂等和 child 生命周期 |
| `action_claims` | `user_resume` 等 user 动作幂等 |
| `todo_batches` | 待办自动合批状态 |
| `session_todos` | per-session 待办池 |
| `patrol_state` | 巡检游标等轻量状态 |

`heartbeat_events` 会记录：

- `event_type`
- `target_session`
- `logical_key`
- `decision`
- `child_session_id`
- `child_model`
- `status`
- `summary`
- `error`
- `feishu_synced_at`

对于 `user_resume_sent`，`summary` 里会记录真实发出的 user 消息：

```text
<reason>; user_message=<actual outgoing text>
```

这解决了“日志里看不到到底以 user 身份发了什么”的问题。

### 8.2 飞书只同步成功触发记录

飞书表是给人看的，不是完整审计账本。

当前只同步这些成功触发事件：

```text
spawn_started
alert_sent
user_resume_sent
todo_injected
```

不会同步：

- `skip`
- `session_prefilter_skip`
- `spawn_skipped_duplicate`
- `user_resume_skipped_duplicate`
- `todo_enqueued`
- `todo_enqueue_duplicate`
- `todo_skipped_session_busy`
- patrol started/finished
- 本地错误和无动作噪音

所以如果飞书表为空，不代表 heartbeat 没跑；只代表没有成功触发需要人看的动作。是否真的跑过，以本地 SQLite 为准。

飞书同步入口：

```bash
scripts/sync-heartbeat-events
```

也会在 `scripts/heartbeat-patrol` 末尾自动尝试同步，只要配置了：

```text
HEARTBEAT_LOG_FEISHU_BASE_TOKEN
HEARTBEAT_LOG_FEISHU_TABLE_ID
HEARTBEAT_LOG_FEISHU_AS
```

当前日志表目标：

```text
base_token: <HEARTBEAT_LOG_BASE_TOKEN>
table_id: <HEARTBEAT_LOG_TABLE_ID>
```

## 9. 关键配置

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `SM_API_BASE` | `http://localhost:3501` | SuperMatrix 本地 API |
| `SM_DB_PATH` | `<SM_RUNTIME_ROOT>/data/supermatrix.db` | SuperMatrix 主库 |
| `HEARTBEAT_STATE_DB` | `data/heartbeat.sqlite` | heartbeat 本地权威日志 |
| `SM_LARK_CLI_PATH` | `lark-cli` | 飞书 CLI |
| `HEARTBEAT_SESSION` | `heartbeat` | heartbeat 自己的 session name |
| `HEARTBEAT_CONTROLLER_PROVIDER` | `minimax` | 主控 provider |
| `HEARTBEAT_CONTROLLER_MODEL` | `MiniMax-M2.7` | 主控模型 |
| `HEARTBEAT_ESCALATION_MODEL` | `gpt-5.5` | 升级模型 |
| `HEARTBEAT_MAX_RECENT_RUNS` | `12` | 每个 session 读取最近 run 数 |
| `HEARTBEAT_STALE_RUNNING_MINUTES` | `90` | running run 多久算 stale |
| `HEARTBEAT_CHILD_SLA_MINUTES` | `180` | child/cross-session 多久算 stale |
| `HEARTBEAT_MAX_SESSIONS_PER_PATROL` | `0` | 每轮最多扫几个 session，0 表示全量 |
| `HEARTBEAT_CONTROLLER_CONCURRENCY` | `0` | 主控并发上限，0 表示按 session 数全量并发 |
| `HEARTBEAT_ESCALATION_CONCURRENCY` | `3` | gpt-5.5 升级并发上限 |
| `HEARTBEAT_MODEL_PREFILTER` | `1` | 是否开启本地预筛 |

MiniMax key 优先读取：

```text
HEARTBEAT_MINIMAX_API_KEY
MINIMAX_API_KEY
<CODEX_SKILLS_ROOT>/smallmodel-manager/catalog/secrets.local.yaml
```

## 10. 已处理过的典型误判

### 10.1 autobitable 还在 running 却被心跳触发

原因：旧规则把 active/busy session status 也当成候选，导致非 stale running run 也可能触发。

当前修复：

- `prefilter.py` 只把 `error` session status 作为候选。
- controller prompt 明确要求非 stale running run 必须 skip。

### 10.2 drawing 的 user_resume 站错视角

问题句式类似：

```text
修正版已经交付到群里了，双层结构和配件比例都已经按要求修正；如果还要再调，我继续跟进。
```

这看起来像目标 session 自己在宣布交付，而不是用户在推动 session 继续。

当前修复：

- composer target 固定为 `heartbeat`，不是目标 session。
- prompt 禁止声称已完成/已交付/已修正。
- 发送前用正则拒绝目标 session 视角句式。

### 10.3 first-principle 03:29 大量 rate limit failed 没触发

原因：旧 prompt 没把 transient provider/API rate limit failure 明确归入可继续场景，模型可能保守 skip。

当前修复：

- controller prompt 明确：如果 latest failed/timeout 是临时 provider/API rate limit，且原 prompt 仍有未完成工作、没有真实用户选择门，应使用 `user_resume`。

### 10.4 飞书日志太吵

当前修复：

- 飞书只同步成功触发事件。
- skip、本地预筛跳过、重复跳过不进飞书。
- 本地 SQLite 保留完整事件账本。

## 11. 当前实现文件地图

| 文件 | 作用 |
|---|---|
| `scripts/heartbeat-patrol` | 巡检入口；跑完后尝试同步飞书日志 |
| `scripts/sync-heartbeat-events` | 单独同步本地成功触发事件到飞书 |
| `heartbeat_patrol/config.py` | 环境变量和默认配置 |
| `heartbeat_patrol/sm_reader.py` | 只读 SuperMatrix 主库，构建 session packet |
| `heartbeat_patrol/prefilter.py` | 本地 deterministic 预筛 |
| `heartbeat_patrol/decision.py` | controller prompt、JSON schema、safety 校验 |
| `heartbeat_patrol/api.py` | MiniMax、`/api/spawn`、飞书消息发送 |
| `heartbeat_patrol/runner.py` | 一轮 patrol 的主流程和动作执行 |
| `heartbeat_patrol/state.py` | 本地 SQLite schema、patrol/event/spawn/action 状态 |
| `heartbeat_patrol/event_sync.py` | 成功触发事件同步到飞书多维表格 |
| `tests/` | 单元测试覆盖预筛、决策、runner、日志同步、state |

## 12. 功能边界

Heartbeat 可以做：

- 发现 stale running / failed / timeout / mechanical continuation。
- 对明确可继续的工作以 user 身份轻推原 session。
- 对需要证据的事项 spawn 子 session 收集。
- 对明确、可逆、owner 范围内的动作 spawn 子 session 执行。
- 对高影响风险升级到 gpt-5.5。
- 留本地权威日志，并把成功触发同步到飞书。

Heartbeat 不应该做：

- 替业务选择参数、方案或审批。
- 在没有明确剩余任务时强行继续。
- 对非 stale running run 插手。
- 绕过 owner session 直接改别的 session 私有状态。
- 通过 EventBus 触发状态修改或 spawn。
- 把所有 skip/no-op 噪音同步到飞书。

## 13. 如何验证

单元测试：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests
```

查看最近本地事件：

```bash
sqlite3 data/heartbeat.sqlite \
  "SELECT created_at,event_type,status,target_session,logical_key,summary,error FROM heartbeat_events ORDER BY created_at DESC LIMIT 20;"
```

查看最近 patrol：

```bash
sqlite3 data/heartbeat.sqlite \
  "SELECT patrol_id,started_at,finished_at,status,sessions_scanned,items_detected,alerts_sent,spawns_started,errors FROM patrol_runs ORDER BY started_at DESC LIMIT 10;"
```

手动跑一轮：

```bash
scripts/heartbeat-patrol
```

注意：飞书日志只代表“成功触发过的动作”，不是 heartbeat 是否运行的唯一证据。是否运行、是否跳过、为什么跳过，要看本地 SQLite。
