# Spawn 闭环异常裁决

socail-king 子 session 被 watcher 唤起后,对一条卡住的 async spawn 做裁决的步骤。

## 这个 SOP 在治什么

新版 spawn 闭环机制(设计见 `docs/superpowers/specs/2026-05-18-spawn-closure-reliability-redesign-design.md`)分两层:

- **常规 + 直接处理 = 纯代码**:每条 spawn 默认走 sync,框架在 `/api/spawn` 当场查通讯/执行/投递三段,失败同步重试一次。还不过 → 登记 `spawn_async_items` 转 async。watcher(SK 的一个 scheduler 任务)扫 `spawn_async_items`,对"纯重推/转投就能解决"的 D 类直接写 heartbeat 待办,不动脑、不惊动 SK。
- **裁决 = LLM 介入**:只有需要判断"到底哪儿错了"的 J 类,watcher 才 spawn 一个 SK 子 session 来跑本 SOP。

本 SOP 就是那个 SK 子 session 的操作手册。一次唤起,处理一条 async 项。

## 什么时候会被唤起(J 类)

watcher 把下面几种判给裁决:

- **J1** 重推用尽(`attempt_count` 到上限)仍不闭环。
- **J2** B 反复产出空。
- **J3** 检查结构性坏——指向不存在的会话/群/表。
- **J4** 约定被反复 patch(churn)——"算成功"的定义本身在抖。
- **J5** 一条 async 项卡过时长阈值,兜底升级。

## 核心铁律

1. **一次裁决处理一条 async 项**(一个 `ref`)。不批量。
2. **现场拍一次定一次**。裁决过程中不重新拉现场造成版本漂移。
3. **判断不出来直接升级用户,别硬撑**。SK 不是兜底神,异常的最后一站是用户。
4. **verdict 一定写回 `spawn_async_items`**。它是权威终态,watcher 靠它决定还扫不扫这条。不写回 = watcher 不知道你裁决过,会重复唤起 SK。
5. **只信检查结果,不信 `status` 字段**。`cross_session_log.status=completed` 不代表 A 拿到了东西——这正是整套机制要治的病。

## Step 0:先查是不是已知的代码层漏网(2026-05-21 新增)

在拉现场之前,先花 30 秒查 `rules/framework-fix-tracker.md`:这条 async 项的 `failure_kind` 是不是已有框架修复方案但还没部署。然后做最小现场确认,确认 shortcut 依赖的一手 artifact 都读得到。

**如果命中未部署的修复方案,且一手 artifact 齐全 → 走 shortcut,不进入全量裁决:**

- `failure_kind=late_result` 且结构化检查明确给出 `executionPassed=false` + `executionTerminal=false`(child 仍在跑):
  → 判 `false_alarm`,verdict_reason 写 "late_result: child still running; framework fix pending (classifyAsyncItem noop branch)"
- `failure_kind=empty_output` 且实际 `cross_session_log.prompt` 或 message_run 上下文含"无须回复":
  → 判 `parked`,verdict_reason 写 "fire-and-forget empty_output; framework fix pending (checkExecution skip for fire_and_forget)"
- `failure_kind=delivery_missing` 且本 comm 的 `result_sink_attempts` 有 `status=skipped` + note 含 `sync_inline handler owns delivery`:
  → 判 `false_alarm`,verdict_reason 写 "sync_inline delivery skip misclassified; framework fix pending (deliveredSinkAttemptExists extend)"

**shortcut 证据门槛:**
- shortcut 只能引用本次现场能直接读到的 artifact:`spawn_async_items`、`cross_session_log`、message_run、`result_sink_attempts`、predicate/patch 记录、watcher 结构化检查结果。
- `cross_session_log` 无行、prompt/final/message_run/sink 任何关键字段读不到、或只能看到用户转述/同批 pattern/timestamp/storm 归类时,禁止 shortcut。进入 Step 1;仍判断不出来就 Step 4 升级,不要把推断写进 verdict。
- "prompt 含无须回复"必须来自实际 prompt 或可审计的 message_run/context,不能从 storm 同型、历史印象、用户截图摘要里倒推。
- 同 prompt storm 只能当 radar(雷达),不能当 evidence(证据)。storm 告诉你"该查",不允许直接产出"EP-3/false_alarm/parked"结论。

**shortcut 规则:**
- 可以不访谈 A/B,但草稿必须写清 artifact 来源和为什么访谈零增量
- 不重推(B 没坏,重推无用)
- 不升级用户(框架修了自然消)
- verdict 照样回写 `spawn_async_items`(watcher 需要知道裁决过了)
- 草稿只写一行 `status=closed`,内容 ≤ 3 句(不铺全量 snapshot)

**如果没有命中 → 进入正常裁决流程(Step 1)。**

## Step 1:收现场

watcher 给的入参:一条 `spawn_async_items` 的 `ref`(及其 `comm_id`)。拉齐:

- **`spawn_async_items` 那一行**:`failed_phase`(通讯/执行/投递)、`failure_kind`、`attempt_count`、`status`。
- **`cross_session_log` 那条 spawn**:A、B、prompt 全文、`final_message`、创建时间。
- **三段检查结果 + 关键环节日志**:按 `comm_id` join 框架留的结构化日志(设计 §6),看每段过没过、为什么不过。
- **重推历史**:`attempt_count` 次重推各自的结果。
- 必要时 spawn A 或 B 拉补充 context——同一次裁决里 spawn 上限 2 次,别反复访谈。

把入场现场写进 `state/exception-transactions.jsonl` 一行 `status=open` 的草稿,带 `ref` + snapshot。后续动作基于这份 snapshot。

## Step 2:分类(两类,挑一类)

- **(a) B 的锅**:检查指对了地方,只是 B 没把事做成——B 没干 / 干不动 / 半路挂 / 反复产出空。
- **(b) 约定的锅**:检查或投递约定本身写坏了——指向不存在的会话/群/表;或 path-glob 太宽(别的东西也触发 true)/太严(真做成了也判 false)。B 可能干对了,但这个约定永远不会 true。

挑不出来 = "未定义异常",直接进 Step 4 升级用户,不硬塞。

## Step 3:动手 + 写 verdict

每个动作执行前在 jsonl 草稿记一行 intent,执行后记 outcome。

- **B 的锅、可救** → 走当前 watcher redrive 路径:程序化重发原 `/api/spawn`(原 caller/target/prompt, 并带 `client_request_id=spawn-redrive:<logicalKey>`), 不写 heartbeat 待办、不向 B 注入裸控制消息。`spawn_async_items` 置 `status='re_driving'`、`verdict='retrying'`。
- **B 的锅、救不动**(基础设施类 / 重试已尽)→ 发群通知升级给人;`status='closed'`、`verdict='escalated'`。
- **约定的锅** → patch 那个约定(把检查/投递声明改对)。**同一约定本次裁决最多 patch 1 次**,别让 A 拉锯。patch 完该 async 项解封、`status='pending'` 重新进观察;`verdict='contract_fixed'`。
- **误报**(其实早闭了,或约定写错但无害)→ `status='closed'`、`verdict='false_alarm'`。
- **挂起** → 约定坏到当前没法 patch、或 churn 无解 → `status='parked'`、`verdict='parked'`。**解封条件只有一个:那个约定被 patch**。spawn 那边有别的新动静不解封——结构坏的约定看的地方不对,B 再干也没用。

权威 verdict + `verdict_reason` 回写 `spawn_async_items`;SK 本地 `exception-transactions.jsonl` 留详细底稿。

## Step 4:升级用户

判断不出 / 挑不出类 / 重试还失败 / A 不配合时,发飞书。模板(≤100 字):

```
[SK 异常升级 <ref>]
spawn: <A> → <B> @ <ts>
现状: <一句话,不超过 30 字>
我的判断: <B 的锅 / 约定的锅 / 我看不懂>
建议: <一句话动作建议,或留空让用户选>
```

不要堆现场字段、不要贴日志。一段,用户 1 分钟内能决定。发送:

```bash
cd <SM_WORKSPACE_ROOT>/socail-king && \
  lark-cli im +messages-send --as bot --chat-id <chat_id> --text "<上面这段>"
```

`chat_id` 通过 `scripts/lookup-session.sh` 查 SM 数据库 bindings 表拿 SK 自己绑定的群。

## Step 5:沉淀

权威 verdict 已在 `spawn_async_items`。SK 本地 `exception-transactions.jsonl` 留详细底稿。每周扫一遍:

- 哪类 `verdict` 出现最多 → framework 该收紧的方向。
- 同型异常 ≥3 次 → 抽成 `rules/exception-patterns.md` 一条。

`rules/exception-patterns.md` 跟 `rules/coordination-patterns.md` 的分工:

| 文件 | 来源 | 治什么 |
|--|--|--|
| coordination-patterns.md | daily review judgment | 协作"如何写对" |
| exception-patterns.md | 本 SOP 裁决 | 异常"如何处理对" |

## 跟 daily review 的关系

| | daily review | 本 SOP |
|--|--|--|
| 身份 | 事后判官(D+1 复盘) | 事中裁决者 |
| 触发 | 每日定时 | watcher 把 J 类 async 项 spawn 过来 |
| 节奏 | 一天 1-2 条 judgment | 一次一条 async 项 |
| 输出 | judgment 落 jsonl + 飞书表 | 动作落地 + verdict 回写 spawn_async_items |

两边共用 "interview-based judgment" 方法论:双边访谈、radar≠evidence、说人话。

## 不该做的事

- 裁决过程中重新拉现场 → 版本漂移。一次定一次。
- 一条约定一次裁决里 patch 多次 → 让 A 拉锯。最多 1 次。
- verdict 不写回 `spawn_async_items` → watcher 不知道你裁决过,会重复唤起。
- 把裁决结果广播给所有相关 session → 噪声。只通知直接 caller。
- 升级用户的消息超 100 字 → 用户看不下去,等于没升级。
- 信 `status=completed` 就当真闭环了 → 假成功,正是要治的病。
