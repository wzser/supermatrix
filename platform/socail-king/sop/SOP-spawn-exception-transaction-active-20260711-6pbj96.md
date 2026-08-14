---
id: 6pbj96
name: spawn-exception-transaction
description: 当 watcher 把需要判断"到底哪儿错了"的 J 类卡住 async spawn 交给 SK 子 session 时用；不覆盖 D 类纯重推（watcher 直接处理）与日常沟通复盘（走 SOP-judgment-via-interview）。
status: active
owner: socail-king
created: 2026-05-14
updated: 2026-07-11
---

# SOP: Spawn 闭环异常裁决

## 核心目标（一句话）

watcher 唤起 SK 子 session 裁决一条卡住的 J 类 async spawn：一次一条 `ref`，分清 B 的锅 / 约定的锅 / 误报 / 挂起，把权威 verdict 写回 `spawn_async_items` 让 watcher 停止重复唤起。只信三段检查结果，不信 `status=completed`。

## When to Use

触发（watcher spawn J 类，入参一条 `ref` + `comm_id`）：**J1** 重推用尽仍不闭环 / **J2** B 反复产空 / **J3** 检查结构坏（指向不存在的会话·群·表）/ **J4** 约定被反复 patch churn / **J5** 卡过时长阈值兜底。｜**不适用**：D 类"纯重推/转投就能解决"由 watcher 直接写 heartbeat 待办、不唤 SK；D+1 事后沟通复盘走 `SOP-judgment-via-interview-*.md`。

## Prerequisites

- `rules/framework-fix-tracker.md` / `rules/exception-patterns.md` 可读；`scripts/lookup-session.sh` 可查 SK 绑定群 chat_id；能读 `spawn_async_items` / `cross_session_log` / `message_runs` / `result_sink_attempts` 与三段检查日志，并能写回 `spawn_async_items.verdict` / `verdict_reason`。
- 双层机制背景（sync 三段检查 + async 分流 D/J）见文末 Companion Files 指针，不挡在 Step 0 前。

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

- **B 的锅、可救** → 走当前 watcher redrive 路径:程序化重发原 `/api/spawn2.0`(原 caller/target/prompt, 并带 `client_request_id=<YYYY-MM-DD>:<caller>:<target>:spawn-redrive:<logicalKey>`), 不写 heartbeat 待办、不向 B 注入裸控制消息。`spawn_async_items` 置 `status='re_driving'`、`verdict='retrying'`。
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
cd /Users/LOCAL_USER/SuperMatrixRuntime/workspaces/socail-king && \
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

## Companion Files（背景下沉处）

- 双层闭环机制（sync 三段检查 + async D/J 分流）与设计背景：`docs/superpowers/specs/2026-05-18-spawn-closure-reliability-redesign-design.md`
- Step 0 shortcut 依据的已知未部署框架修复索引：`rules/framework-fix-tracker.md`；同型异常沉淀：`rules/exception-patterns.md`

## 异常枚举（§5 — 必填，≥3 行，红线）

> 每类裁决结果一行，含权威 verdict 与升级时限。「判断不出来」不是"硬塞分类"，是升级用户（末行）。

| Case | 触发条件（可机械判定） | 判定方式 | 应对动作 | 通知对象 | 升级时限 |
|---|---|---|---|---|---|
| B 的锅·可救 | `failed_phase`=执行 且 `attempt_count`<上限 且 B backend 无结构损坏 | Step 2 分类(a) + 三段检查 | 程序化 redrive 原 spawn2.0（`client_request_id=<date>:<caller>:<target>:spawn-redrive:<key>`）；`status='re_driving'` `verdict='retrying'` | 不通知（自动重推） | redrive 再失败 → 转"B 的锅·救不动" |
| B 的锅·救不动 | `attempt_count` 到上限 或 B backend 结构性坏 | 检查结果 + 重推历史 | 发群升级人；`status='closed'` `verdict='escalated'` | SK 绑定群（`lookup-session.sh` 查 chat_id） | 发出即终态，等人接管 |
| 约定的锅 | 检查指向不存在会话·群·表，或 path-glob 过宽/过严误判 | Step 2 分类(b) | patch 该约定（本次裁决**最多 1 次**）；`status='pending'` 重新观察；`verdict='contract_fixed'` | 不通知（解封重进观察） | 同约定再抖 → 挂起(parked) |
| 误报 | 三段检查显示其实早闭环 / 约定写错但无害 | 检查结果 | `status='closed'` `verdict='false_alarm'` | 只通知直接 caller | 终态 |
| 挂起 | 约定坏到当前没法 patch / churn 无解 | Step 2 挑不出可行动类 | `status='parked'` `verdict='parked'`；解封条件唯一=该约定被 patch | — | — |
| 判断不出 / A 不配合 | Step 2 两类都挑不出，或 spawn A/B 用尽 2 次仍无回应 | 现场 + 2 次 spawn 上限耗尽 | 发飞书升级用户（≤100 字模板，Step 4） | SK 绑定群 | 用户不回 → 保持未闭 `open`，靠 watcher 重唤（**不写回 verdict 即会重来**） |

## 禁用项 (Do NOT during execution)

- **一次裁决处理多条 async 项 / 一次 patch 多个约定**。**Why**：批量裁决共用现场会串味；一约定多 patch 让 A 拉锯。**How to apply**：Step 1-3 一次一条 `ref`、一约定最多 patch 1 次。
- **判断不出来硬塞一个分类**。**Why**：SK 不是兜底神，硬分类会写错权威终态。**How to apply**：Step 2 挑不出类 → Step 4 升级用户。
- 裁决过程中重新拉现场 → 版本漂移。一次定一次。
- 一条约定一次裁决里 patch 多次 → 让 A 拉锯。最多 1 次。
- verdict 不写回 `spawn_async_items` → watcher 不知道你裁决过,会重复唤起。
- 把裁决结果广播给所有相关 session → 噪声。只通知直接 caller。
- 升级用户的消息超 100 字 → 用户看不下去,等于没升级。
- 信 `status=completed` 就当真闭环了 → 假成功,正是要治的病。
