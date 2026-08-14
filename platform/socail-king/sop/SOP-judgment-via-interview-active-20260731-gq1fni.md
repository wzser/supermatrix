---
id: gq1fni
name: judgment-via-interview
description: 当 scheduler 06:00 日常复盘或扫 cross_session_log 命中沟通失败信号时用；不覆盖 spawn 闭环 J 类异常裁决（走 SOP-spawn-exception-transaction）与原始业务任务执行。
status: active
owner: socail-king
created: 2026-04-28
updated: 2026-07-31
---

# SOP: 双边访谈出判断

## 核心目标（一句话）

从 `cross_session_log` 雷达挑疑似「A 没拿到成果」的案例 → 立刻访谈 A/B 拿一手视角 → 出一条人话 judgment 落本地 jsonl + 飞书表 → 追到闭环。治的是「状态 completed 但成果没闭环」的假成功；成功指标是**闭环率**不是判断条数。

## When to Use

触发：① scheduler 06:00 日常复盘子会话；② 扫 `cross_session_log` 命中 Step 1 的任一信号。｜**不适用**：spawn 闭环 J 类异常裁决走 `SOP-spawn-exception-transaction-*.md`；原始业务任务不自己做（转对应 owner）。

## Prerequisites

- `scripts/lookup-session.sh` / `closure-report.py` / `check-daily-review-outcome.sh` 可用；SK 绑定群 chat_id 已知；wendangwang `feishu-sync-enqueue` 可达；访谈走 `/api/spawn2.0`（body 带 `from`），不 sqlite3 直读别人库。

## Step 1：扫雷达

### 这一步在干嘛

扫 cross_session_log 增量，找"A 没拿到成果"的蛛丝马迹。**不下结论**，只是挑出"值得当下立刻去问的对象"——挑到就立刻进 Step 2，不要继续往下挑、堆候选。

### 信号（命中任一就触发当下取证）

- **prompt 没说清楚要什么**：A 没写目标 / 没写期望的输出形式 / 没写关键 ID（任务 ID、文件路径、ASIN 等）。B 大概率在猜。
- **final_message 跟 prompt 不对题**：B 没正面回应 A 的问题，或答了别的事。
- **同一对 A↔B 短时间多次反复**：一次没拿到才会再问。
- **B 的回答里有困惑信号**：「请问」「不太确定」「能否再说明」「我没找到」之类。
- **灰区命中**：to_session 落在 `rules/gray-zones.md` 的 8 个混淆区——比如发给 amzdata 但请求是原始 SQL（更应该 amz-sql）。
- **跨 session 约定或平台 workaround 影子**：同一接口 / 字段 / 回执格式在 7 天内跨 ≥ 2 对 A↔B 反复出现，且伴随"校验 / workaround / 临时约定 / 回执格式 / anchor / predicate / 权限报错 / 静默吞 / 解析不上"等词；详见 `rules/judgment-thresholds.md` 信号 F。它只触发取证，不直接下"涌现态"结论。

### 先过滤的系统噪声（不算沟通问题）

- B 的 codex backend（执行后端）有当次错误、超时、空输出等运行证据 → 系统问题；不要只因为 B 是 codex 就过滤
- 子会话 timeout / rate limit → 框架问题
- alias 路由命中 → 不算找错人

### 用什么工具

- `scripts/lookup-session.sh by-id <sess_xxx>` 把 UUID 解析成 name / purpose
- `scripts/lookup-session.sh resolve-child <sess_child_xxx>` 把 child id 解析回 parent
- `rules/gray-zones.md` 看是不是混淆区
- `rules/judgment-thresholds.md` 看信号 F 是否只是雷达，避免把跨仓涌现影子当成正式 evidence
- `state/judgments.jsonl` 看历史，避免跟刚否过的同类型再撞

## Step 2：当下取证（不许跟 Step 1 之间留延迟）

### 这一步在干嘛

还原 A 的真实意图、B 的真实理解，把"字段推断"换成"双方亲口说"。

**关键铁律：Step 1 命中就立刻进这一步。** 不要等"今天的候选挑齐"——挑齐再问的时间内，原始 evidence 已经在凉。

### 问 A 的模板

```
我是 socail-king。看到你 [时间] spawn 给 [B 的 name + 别名] 一条请求，prompt 摘要：「[摘要]」。

想问你三件事：
1. 你当时在做什么事？为什么需要找 [B]？
2. 你期望 [B] 给你什么具体的东西（一个答案？一个动作？一个判断？）
3. 你拿到 [B] 的回复后，事情有没有继续推下去？还是又得问别人 / 自己重做一遍？

如果本案命中"跨 session 约定或平台 workaround 影子",再追问一句：
4. 这是不是你们临时发现的平台行为或新约定？你知道还有哪些 session 可能会撞到吗？
```

### 问 B 的模板

```
我是 socail-king。看到 [时间] [A 的 name] 给你发了一条请求：

「[完整 prompt]」

想问你三件事：
1. 你收到这条请求时，理解的是什么意思？
2. 你为什么用「[final_message 摘要]」这种方式回？
3. 你回完之后觉得自己答到位了吗？还是其实没把握 / 觉得 prompt 没说清楚？

如果本案命中"跨 session 约定或平台 workaround 影子",再追问一句：
4. 这是不是临时 workaround / 新回执格式 / 平台隐性行为？它是否应该由某个 owner 沉淀成共享约定？
```

### 怎么 spawn

```bash
curl -s -X POST http://localhost:3501/api/spawn2.0 \
  -H "Content-Type: application/json" \
  -d '{
    "from": "'"$SM_SESSION_NAME"'",
    "target": "<name>",
    "prompt": "...",
    "client_request_id": "'"$(date +%F)"':'"$SM_SESSION_NAME"':<name>:judgment-interview:<comm-or-case-id>",
    "closure": { "kind": "message", "target": { "type": "inline" } }
  }'
```

两个访谈请求都走 HTTP API spawn2.0。需要并发时，用 shell 后台任务或连续发两条 `curl`，不要用模型内置的 subagent / `run_in_background` 工具；那不是跨 session 协作的权威路径。等双方回执都拿到再进 Step 3。如果返回里只有 `childSessionId` 或 `switched_async`，用 `GET /api/sessions/:childSessionId/result` 轮询结果，不要直接读底层数据库。

定时任务 prompt 里也必须写 `/api/spawn2.0`，并且 body 带 `from` 字段。旧 `/api/spawn` legacy endpoint（旧端点）已禁用，继续写旧地址只会先吃 410 再改口，属于无意义噪声。

### 如果 log 里其实没找到（用户口头提的、或飞书直聊的）

这种情况第一手取证更紧迫：

- 直接 spawn 双方问"最近你跟 X 讨论 Y 这件事的全过程是怎样"
- 如果连双方都记不清，立刻回去问用户要线索（大致时间、关键词、对方是谁）
- **不要硬靠 log 字段拼一个故事**——没第一手 evidence 就标"取证不可达"挂起，宁愿不写也不脑补

## Step 3：综合双方视角写判断

### 这一步在干嘛

拿到双方真实视角后，回头看那条 log，写一条人话判断。

### 判断的写法

**说人话。** 写之前默念："旁边坐个人，我会用嘴这么对他说吗？" 不会就重写。

判断主体只讲"发生了一件什么事 + 实际影响"，不堆术语、不用勾不用表格。

### 判断要包含的字段（飞书表对应）

- **theme**: 沟通不畅 / 找错人 / 假成功 / 重复劳动 / 其他
- **user_visible_symptom**: 用户看到了什么现象（频次 + 可见症状）
- **function_loss**: 实际损失了什么——功能、信任、时间
- **evidence**: 哪条 cross_session_log + A 怎么说 + B 怎么说
- **confidence**: high / medium / low
  - high = 双方视角清晰 + 损失可量化
  - medium = 双方视角拿到但损失需要推断
  - low = 双方视角不完整或互相矛盾
- **gray_zone_hit**: 命中 #1~#8 哪条 / none
- 如果 Step 1 命中"跨 session 约定或平台 workaround 影子",只在 evidence 或 interpretation 里标注 radar_hit=emergent_shadow；不要新增飞书字段,也不要把"可能涌现"本身写成 judgment。

### 没拿到双方视角怎么办

不写判断。挑下一个候选。**没访谈过的判断 = 脑补，不算成果。**

## Step 4：落本地 + 推飞书

### 落本地

append 到 `state/judgments.jsonl`。一条 JSON 一行，包含上面所有字段 + `interview_a` + `interview_b` 两个字段（双方原话摘要）+ 时间戳 + judgment_id。

**手写 append 一律走 `scripts/append-journal.sh`（2026-07-31 巡警整改方向②，机械收口）**：`echo '<row-json>' | scripts/append-journal.sh state/judgments.jsonl`。脚本按真实落盘时刻强制覆盖 `ts`（带 `ts_ms` 则同步覆盖），LLM 不得自填 ts——07-29 commit 876a7dd 06:19:50 的树内含 ts=06:20:00/06:21:00 的预填行，文字禁令没拦住，改为机制拦截。（`closure-report.py --emit` 与 `check-daily-review-outcome.sh` 自产行本就打真实时刻，不经过本脚本。）

**append 前先查重（2026-07-07 巡警整改）**：`grep -c '"id": "<judgment_id>"' state/judgments.jsonl` ——同 id 主判断行已存在就**不准再 append 主判断行**；要补充或修正内容走 `revision` 行。尤其是本步骤后半（飞书入队/读回）失败重试时，只重跑失败的子步骤，绝不从头重发主判断行（judg-2026-07-07-001 即因此写重）。兜底：`closure-report.py` 每轮检测「重复主判断行」，`--emit` 自动生成 `dedupe-annotation` 标记行。

### 推飞书（走已登记的 data-time enqueue 轨道，不要 lark-cli 手写）

这张表是已登记的 wendangwang 资产 `socail-king.judgment.判断记录`（唯一键 `judgment_id`、按 judgment_id 幂等 upsert、field_split）。落表走 enqueue 脚本——它幂等去重（同 judgment_id 不会写第二行）+ 写后读回 receipt（直接给 record_id）。**不要再用 `lark-cli base +record-batch-create` 手写行**：它没幂等，而且这表 keyword/filter search 读不回（返回空），手写一旦重发就静默写成 2 行还查不出来（2026-06-15 judg-2026-06-15-002 即如此，靠表格王 reconcile 删重）。

1. 备 `rows.json`（绝对路径），一条判断一个对象。**只写程序权威（local）字段**：`judgment_id / ts / theme / user_visible_symptom / function_loss / evidence / confidence / gray_zone_hit / applied_to_rule`。**绝不写 `user_verdict` / `user_note`**——它们是飞书人工权威（field_split），程序写会覆盖用户反馈。
   - `ts` = 毫秒时间戳（数字），不是 ISO 字符串
   - select 字段（theme / confidence / gray_zone_hit）传枚举名字符串
2. 入队（默认 `--op bitable_rows_upsert`，按 judgment_id 幂等）：
   ```bash
   /Users/LOCAL_USER/SuperMatrixRuntime/workspaces/wendangwang/bin/feishu-sync-enqueue \
     --asset socail-king.judgment.判断记录 --from socail-king \
     --key "$(date +%F):socail-king:judgment:<judgment_id>" \
     --rows /abs/path/rows.json
   ```
3. **完成判据**：exit 0 + stdout `ok:true` 只证入队；写成看 stdout `drained.done>=1`，或表格王仓 receipt 行 `read_back_verified:true`（`/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/wendangwang/data/receipts/<date>-sync-queue.ndjson`，按 dedupe_key 定位）。从 receipt 拿 `record_id`，append 一条 `{"id":"<judgment_id>","kind":"feishu-record-bind","ts":"...","record_id":"..."}` 到 jsonl。`duplicate:true` = 幂等命中、安全不重复写。**别再用 lark-cli search/get 读回**（这表 search 返回空假阴性）；真要本地核验用 `lark-cli base +record-list --as user --filter-json '{"logic":"and","conditions":[["judgment_id","==","<id>"]]}'`。
4. spawn2.0 只在改 schema（建表 / 加字段 / 改权威规则）时用（schema-time）；日常写行数据不走 spawn2.0、不唤 LLM。
5. 06:00 scheduler 触发的日常复盘到这里已经由 SK 自己闭环；不要再把完整 REPORT、飞书记录摘要、判断全文或解析结果回传给 scheduler。需要给当前调用方一个最终消息时，只说本轮已在 SK 侧收口，不带业务正文。
6. **落表后刷新 freshness 快照**：跑 `scripts/build-judgments-snapshot.sh` 重生成 `state/judgments-snapshot.json`。wendangwang 的每日 freshness 审计（Plan A，2026-07-04 起）以这个「一 judgment 一条、按 id 去重、latest-state」的派生快照为 local 口径——**不是 raw jsonl 行数**（jsonl 是 append 事件日志，line-count ≠ record-count）。落表后不刷新 → 下轮审计误报 drift。

## Step 5：吃用户反馈

### 怎么吃

用户在飞书表里改 `user_verdict`（准 / 偏了 / 抓歪了）+ 写 `user_note`。我每天扫一遍飞书表，把新增的 verdict append 到 jsonl（不原地改原判断行）。

### 反馈的去处

- **准**：判断验证。把 evidence 里的访谈模式提炼成 `rules/coordination-patterns.md` 的一条。
- **偏了**：方向对但细节有问题。在 jsonl append 一条修订行，说明哪里偏。
- **抓歪了**：方向错了。在 `rules/judgment-thresholds.md` 的"识别误区"加一条反例。

### 回填 applied_to_rule（同样走 enqueue，别碰人工字段）

`user_verdict` / `user_note` 是飞书人工权威，**程序只读不写**（上面「怎么吃」是把用户在飞书填的 verdict 读回 jsonl，不是写回飞书）。SK 唯一要写回飞书的是 `applied_to_rule`（local 权威），同样走 enqueue upsert、按 judgment_id 幂等：

```bash
# rows.json: [{"judgment_id":"<id>","applied_to_rule":"<规则文件/规则项指针>"}]
/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/wendangwang/bin/feishu-sync-enqueue \
  --asset socail-king.judgment.判断记录 --from socail-king \
  --key "$(date +%F):socail-king:judgment:<judgment_id>:applied" --rows /abs/rows.json
```
upsert 按 judgment_id 命中既有行、只更新 `applied_to_rule`；payload 里不放 `user_verdict` / `user_note`，飞书人工值不被动。**不再用 `lark-cli base +record-upsert --record-id`**——那条路要先有 record_id、且绕开了幂等键 judgment_id。

## Step 6：沉淀业务协作模式

### 这一步在干嘛

攒出"我们自己业务的沟通协作机制"。

### 怎么沉淀

每攒到 ≥ 3 条同类型判断（例如"after-sales 问业务问题没说清楚"），合并提炼成 `rules/coordination-patterns.md` 的一条：

```
## 模式：<一句话>

- 观察来源: judgment_id 列表
- 出现频率: 几次/周
- 典型表现: 一个具体实例
- 建议改动: 发起方该怎么写、接收方该怎么读
```

### 这跟 gray-zones.md 的区别

- gray-zones.md：职责重叠的**预测**（"这两个 session 容易被混淆"，来自 first-principle 综合）
- coordination-patterns.md：实地观察出来的**真相**（"after-sales 实际就这么说话"，来自访谈）

## Step 7：收口与升级（closing loop）—— 每轮必跑

### 为什么这步存在

判断做出来 ≠ 通讯问题落地。SK 的成功指标是"发现的问题被**收口**"，不是"出了多少 judgment"。没有这一步，判断永远卡在 pending——2026-07 巡检实测：judgments.jsonl 里 45 条 pending、只有 1 条 fixed，闭环率 1.9%（"为巡检而巡检"）。Step 1-6 是判断力，Step 7 是把判断追到闭环的收口力，缺了它前六步全是空转。

### 状态生命周期（append-only，latest-wins）

judgments.jsonl 只能 append，**不原地改旧行**。改状态靠追加一条 `status-transition`，`for_id` 指向 judgment_id，"最后一条带 status 的记录赢"：

```json
{"kind":"status-transition","for_id":"judg-YYYY-MM-DD-NNN","status":"<新态>","reason":"<机器可读原因>","evidence":"<证据指针>","ts":"<ISO，须晚于该判断已有最新事件>","by":"closure-sweep"}
```

状态机：`pending`（判完未推）→ `awaiting_verdict`（已推用户/飞书、等 verdict=待校准）→ `confirmed`（用户说准）→ `fixed` | `closed`（终态，算收口）

- `fixed`：根因被解决，或模式已沉进 `rules/` 且**落地真实发生**——`coordination-patterns.md` 引用即算（协作模式本身是 SK 的产出）；`framework-fix-tracker.md` 引用**只有该条目 🟢（已部署）或判断带 outcome-verified / fix_evidence 行才算**，🟡/🔴 条目引用 = 只是记录了缺口，判断保持开放、列入「外部修复未达成」追 owner。**记录沉淀不能替代落地**（d29f856 闸门；2026-07-07 复盘 run 曾照本行旧文案手写 fixed 被巡警抓伪收口）。
  - **复发类例外（2026-07-08 巡警整改）**：若该 tracker 条目损失=循环本身（如 heartbeat 对终态 blocker 同 key 无限重烧），条目标机器标记 `verify=next_run_recurrence`。这类条目引用的判断，**owner 回执 / tests passed（fix_evidence / outcome_verified）一律不算收口**——tests 过 ≠ 部署、≠ patrol 进程真加载新代码、≠ 复发真停。唯一收口证据是一条真实下轮实跑行 `{"kind":"next-run-verified","for_id":"<jid>","verdict":"pass|fail","observed_followups":N,"threshold":<阈值>,...}`：`verdict=pass`（同 key follow-up ≤ 阈值）才转 fixed，`verdict=fail`（复发仍在）= 修复没生效、重新追 owner。没拿到实跑行前，`closure-report.py` 把它列入「等实跑复发验证」、绝不收口；owner 回执越闸的既成终态会被自动降级（closure_gate_violation_demote）。
- `closed`：无需再动。reason 枚举——`calibrated_counterexample`（用户抓歪了→反例已进 `judgment-thresholds.md`）/ `business_satisfied_elsewhere` / `stale_cold`（事件已凉、催过仍无 verdict、age>30 天）/ `superseded`。
- 闭环率 = (fixed + closed) ÷ 判定总数。

### 每轮动作（跑脚本 → 收漂移 → 升级 → stale 收口）

1. 跑 `python3 scripts/closure-report.py`：latest-wins 归约，打印闭环率、状态分布、"漂移(已沉进规则却没标终态)"、"升级候选(开放态≥7天)"。它扫 `rules/*.md` 里的 judgment_id 引用当落地信号。
2. **收漂移 + 证据卫生**：`python3 scripts/closure-report.py --emit >> state/judgments.jsonl` 把"规则已引用但没标终态"的判断补成 fixed/closed（证据=规则文件），同时自动生成重复主判断行的 `dedupe-annotation` 和伪收口的降级转移（`closure_gate_violation_demote`）。脚本自动把 ts 打在该判断已有最新事件之后，避免同日转移被后建 base 行盖过。**红线：fixed/closed 终态转移只能来自本脚本 --emit 或 Step 5 用户 verdict 路径**——手写终态（尤其 evidence 指向 tracker 非🟢条目的 `pattern_sunk_to_rule`）= 绕闸假收口，下一轮 --emit 会自动降级并出现在报告「伪收口」节。
3. **升级超期**：开放态（pending / awaiting_verdict / confirmed）≥ 7 天的，**一次性发 ONE digest** `/api/notify`（level=warn、走本 session 绑定群）催用户补 verdict——**绝不逐条 ping**（47 条分开发=骚扰）；发完 append 一条 `{"kind":"escalation",...}` 记 message_id + scope 当审计。
4. **stale 收口**：已 escalation 过、age > 30 天、仍无 verdict 的开放判断 → append `status-transition` status=`closed` reason=`stale_cold`（事件已凉，硬留 pending 只是噪声）。
**⚓ 受锚要求（2026-07-23 巡警整改：封 closure-report 自证环，#5/#6 共用，恒必做）**：#5/#6 的每条复检/landing 行「本轮已复检」**不再由自报 `ts` 判**——07-23 实测 daily-review child 把 `ts` 预填成未来时刻（commit `53c9ee3` 06:11:40 的树内已含 `ts=06:40:00` 的行、晚 28 分钟），照样过 `owed=[]` 假绿。**因此每条 `next-run-verified` / `recheck-skipped-with-reason` / `landing-checked` 行必须带独立锚**，缺任一 `closure-report.py` 一律不认、判断继续 owed：
   - `"run_id"`：本轮 scheduler child run_id。**取法**：`curl -sf "http://localhost:3502/tasks/068f4358-49c7-47d1-aa4c-4850b5b68a48/runs?limit=5"`，取 `triggeredAt` 当天最大那条的 `id` = 本轮 run_id；其 `triggeredAt`（epoch ms）转 ISO = `run_start`（Gate2 用同一取法，二者必然选同一条）。
   - `"receipt"`：`{"kind":"notify_receipt|queue_receipt|owner_artifact","ref":"<外部 handle>","produced_at":"<ISO，须晚于 run_start>"}`。receipt 是**做复检这个动作、本轮新产出**的外部回执，**不是**被核对的旧 owner 产物（旧 commit 早于 run_start，不能当 receipt——它写进 `evidence` 供巡警交叉核）。**默认取法**：复检完把一句话结论 `POST http://127.0.0.1:${SM_API_PORT:-3501}/api/notify`（§245，走本 session 绑定群），返回 `messageId` 当 `ref`、其服务端时刻当 `produced_at`（**一轮一张卡即可，多条行共用同一 receipt**）；或本轮 `feishu-sync-enqueue` 的 queue receipt 当 `ref`。
   - **红线**：`ts` = **真实落盘时刻**，手写 append 一律走 `scripts/append-journal.sh`（脚本强制覆盖 `ts`/`ts_ms` 为 now，自填无效——2026-07-31 巡警整改方向②把文字禁令升级为机制拦截；07-29 commit `876a7dd` 06:19:50 的树内仍含 ts=06:20:00/06:21:00 预填行）；巡警下轮从 :3502/:3501 取本轮 run 时间窗、逐条对拍 journal 新增行——任何晚于其 commit 时刻的 `ts` 保留异常）；`produced_at` 必须晚于 `run_start` 且指向真实外部 handle，`receipt.ref` 的真伪由巡警解析回真实外部时刻交叉核。自检：`python3 scripts/closure-report.py --recheck-worklist --run-id <本轮> --run-start <ISO>`，看目标 jid 出没出 `owed`、`anchor_reject` 是不是空。

5. **复发类每轮强制复检（执行层强制留痕，2026-07-11 巡警整改，恒必做——不许静默漏检）**：跑 `python3 scripts/closure-report.py --recheck-worklist`（**先按上「⚓ 受锚要求」取本轮 run_id/run_start**），对 `owed` 里**每一条**判断，本轮**必须** append 一条**带锚**复检行，二选一，绝不留空：
   - **拿到真实下轮样本**（修复 owner 声称部署时点之后、blocker 恢复后 ≥1 个真实巡检周期，heartbeat case = pause 到期 + ≥1 轮 10 分钟巡检）→ 机械复发计数：查 `cross_session_log` 同 `logical_key`（或同 comm chain / 同 mr_ 目标）在修复后窗口内的 follow-up 连发次数，与 tracker `threshold` 比。`≤threshold` 且**确系新 backoff 逻辑把真实 re-fire 拦停** → `{"kind":"next-run-verified","for_id":"<jid>","verdict":"pass","observed_followups":N,"threshold":<阈值>,"run_window":"<起止>","evidence":"<计数出处>","run_id":"<本轮>","receipt":{"kind":"notify_receipt","ref":"<messageId>","produced_at":"<晚于 run_start>"},"ts":"<真实 materialization 时刻>","by":"daily-review-<date>"}`，下轮 `--emit` 自动转 fixed(next_run_verified)。`>threshold`（复发仍在）→ 同结构 `verdict":"fail"`，判断留「实跑验证未通过」、重新 handoff owner。
   - **没有新鲜样本**（触发条件未复发 / 采不到能验证修复的实跑 / 修复尚未部署）→ append `{"kind":"recheck-skipped-with-reason","for_id":"<jid>","reason":"<机器可读原因,如 no_fresh_recurrence_sample>","observed_followups":N,"threshold":<阈值>,"window":"<复检窗口>","detail":"<一句话:看了什么、为什么不判 pass/fail、保持异常优先>","next_check":"<下次>","run_id":"<本轮>","receipt":{"kind":"notify_receipt","ref":"<messageId>","produced_at":"<晚于 run_start>"},"ts":"<真实 materialization 时刻>","by":"daily-review-<date>"}`。**它不是收口证据**——不改状态、不算 pass，只证「本轮确实复检过、没漏」；判断继续留在 worklist，下轮再复检。**注意**：skip 也必须带锚——「没有新鲜样本」是**本轮真去查了 cross_session_log** 得出的结论，receipt 证明这个查的动作本轮真发生过，不是自报。
   - **红线①：`0 次 re-fire` 不等于 `pass`。** 当 0 是因触发条件消失（根因被别处根修、blocker 不再出现）、而非「新 backoff 逻辑把真实 re-fire 拦在 ≤threshold」时，判 `pass` = 拿触发消失冒充复发被拦 = 假成功；必须判 `recheck-skipped-with-reason`。先确认 heartbeat/巡检机制本身仍活跃（对其他 target 有正常出站），排除「机制停摆导致的假静」再下判。
   - **红线②：绝不凭 owner 回执 / tests passed 补 next-run-verified**——那是伪收口。真实下轮没发生也要留 recheck-skipped-with-reason，**不许什么都不写**（judg-2026-07-08-001 07-10 零复检、07-11 仅关无关陈项，即因旧规则「没样本就不 append」静默漏检 2 天，被巡警判 degraded 假成功）。
   - **复发类窗口收口（2026-07-18 巡警整改，item ④）**：损失=循环本身的复发类判断，若原始触发（具体 comm / logical_key）已消失、无法再产生实跑样本（复发-pass 闸门结构上永不可满足），**别无限日复检**——做一次主动收口/降级：append `{"kind":"recurrence-window-closed","for_id":"<jid>","reason":"acute_recurrence_window_elapsed","observed_no_recurrence_days":N,"decision":"<一句话:急性损失何时止、几天零复发、触发为何消失、框架件转谁>"}` + `status-transition` status=`closed`，从复发闸门解绑（不再 owed）。框架修复是否真生效**留 framework-fix-tracker 由 owner 追**（计入暂计、不抬真实闭环率）。judg-2026-07-08-001 即此路径（急性烧 child 循环 07-09 12:40Z 止、10 天零同 key 复发）。
6. **landing/owner-欠账 每轮强制核对（2026-07-18 巡警整改，item ①，恒必做——不许静默停 awaiting_verdict）**：`--recheck-worklist` 的 `landing_required` 是「点名 owner 改代码/改合同」的开放判断（经 `landing-enroll` 登记，带 owner + 机械 probe）。对**每一条**本轮**必须**跑 probe 去 owner repo 抽产物核对「真做了没」，append 一条 `landing-checked`，绝不留空：
   - **owner 真 ship 且对症**（**实读 diff / commit body / comm receipt** 确认对上 root cause，不止看 commit subject）→ `{"kind":"landing-checked","for_id":"<jid>","verdict":"landed","evidence":"<读了哪个 commit/comm、为何对症>","run_id":"<本轮>","receipt":{"kind":"notify_receipt","ref":"<messageId>","produced_at":"<晚于 run_start>"},"ts":"<真实 materialization 时刻>","by":"daily-review-<date>"}`，随后 append `status-transition` status=`fixed` reason=`owner_landed`；下轮起退出 landing worklist。（被核对的 owner commit 写进 `evidence`；`receipt` 是本轮做核对动作新产出的回执，不是那个旧 commit。）
   - **未 ship / ship 了但没对症 / 拿不到证据** → 同结构 `verdict":"pending"`（同样带 `run_id`+`receipt`），evidence 写清还缺什么。判断继续留 worklist、下轮再核。
   - **做出新判断且点名 owner 改代码/改合同时** → 当轮就 append 一条 `{"kind":"landing-enroll","for_id":"<jid>","landing_owner":"<session>","landing_probe":"<机械核对命令,如 grep owner repo commit / 核 comm read_back_verified>"}`，别让它无声停在 awaiting_verdict。
   - **红线：`landed` 必须实读产物对症**——只看「commit 存在」或信 owner 回执 = 伪 landed（judg-2026-07-12-001 的 ad-adjust `5e4f750` F-01 是**实读 diff** 确认 fail-closed `evaluate_execution` 对症 switched_async 假成功才判 landed；`959c5bb` 方向不对不足以收口）。`owed` 折叠复发类 + landing 两路，Gate 2 任一漏检即判红。
7. verdict 到了：用户在飞书标 准/偏了/抓歪了 → 按 Step 5 落 verdict 行 + append `status-transition`（准且已沉规则→`fixed`；抓歪了→`closed`/`calibrated_counterexample`）。

### 额外自检：每日复盘健康 `check-daily-review-outcome.sh`（两道判绿 gate + 一道恢复门，每轮必查）

`scripts/check-daily-review-outcome.sh`（可独立运行、不耗 LLM 配额、已挂 scheduler）Gate 1/2 任一红即判红并 `/api/notify` 告警本 session 绑定群；Gate 3 是动作门、不改判绿：

- **Gate 1 — 复盘子会话健康（2026-07-06）**：scheduler v2 最近 run 的 child session 无 `status=failed`；连不上 scheduler 则跳过本 gate（不判红）。命中新 child-failed → 记 `state/daily-review-health.jsonl` `kind=child-failed` + 告警。
- **Gate 2 — 复检覆盖（2026-07-11 巡警整改；2026-07-18 扩到 landing 类；2026-07-23 加受锚）**：`closure-report.py --recheck-worklist` 的 `owed` 必须为空。`owed` 折叠两路——复发类（Step 7 #5，每条开放复发判断当天留了**带锚**的 next-run-verified / recheck-skipped-with-reason）+ landing 类（Step 7 #6，每条开放 landing 判断当天留了**带锚**的 landing-checked）。**受锚（2026-07-23）**：Gate 2 自动从 :3502 取本轮 run_id/run_start 传给 closure-report——「本轮已复检」只认带 `run_id`+run 开始后 `receipt` 的行（见 Step 7「⚓ 受锚要求」），自报 `ts` 不再放行；封的是「child 把 ts 预填成未来时刻、零真复检也过 owed=[]」的自证环（07-23 实测 commit 06:11:40 的树含 ts=06:40:00 行）。`owed` 非空 = 当日**零产 / 仅 backlog-GC / 只留了无锚假复检行** → 记 `kind=recheck-owed` + 告警 + 判红。**复盘未到点排除（item ③）**：本地时刻 < 复盘应完成时刻（默认 07:00，`SK_REVIEW_DUE_HOUR` 可调）且查的就是今天时，Gate 2 SKIP 不判红（06:00 复盘还没跑，此时 owed 非空是假警）。
- **Gate 3 — 失败恢复半环（2026-07-31 巡警整改方向①，动作门不改判绿）**：检出+告警之后必须有恢复动作，不再「只报不修」（07-26~07-31 实证 4 次 child-failed 全程零 retry）。阶梯：**L1** 今日有 child-failed 且未补跑 → spawn2.0 `todo_pool` 重派本 session 补跑今日复盘（`client_request_id` 按日幂等，记 `kind=backfill-dispatched`）；**L2** 下轮追踪补跑 child——completed 记 `backfill-recovered`，failed 记 `backfill-failed`；**L3** 补跑也失败或连续两日 06:00 连跪且未恢复 → `/api/notify` level=error 升级用户决策（记 `escalated-to-user`，每日最多一次）。隔离演练用 `SK_RECOVERY_DRY_RUN=1`（只打印意图，不真发不写）。

每轮复盘末尾跑一次；Gate 1 命中的失败若连续 ≥ 2 轮无恢复，在圈末自检中上报。**注意**：Gate 2 只在 Step 7 #5/#6 每条 owed 都留了复检行后才会绿——所以它们不是可选项，是判绿前置。

### 圈末自检（专段，必写）

每轮复盘末尾把 `closure-report.py` 的头部四行贴进当轮小结：`判定总数 / 终态数(含暂计) / 暂计数 / 真实闭环率`，外加开放态≥7天堆积数。**真实闭环率已剔除「framework 未部署 / 复发未证 / 窗口收口」的暂计项（2026-07-18 巡警整改 item ②）——播报进 health/notify 的必须是真实闭环率，绝不再贴含暂计的假绿率**（旧版把 coordination-pattern 沉淀即 fixed 但框架 🟡/🔴 未部署的判断当收口，抬到 88% 假绿）。**真实闭环率长期走低、暂计或 backlog 持续涨 = SK 自己该报的警**——主动 `/api/notify` 报用户"判断在积压/框架件没落地"，而不是闷头出新判断。

## 异常枚举（§5 — 必填，≥3 行，红线）

> 每个可预见失败位置一行；「出错时通知人工」= 没写完。radar 类信号（子会话 timeout / rate limit）先按 Step 1 噪声过滤，不写成沟通 judgment。

| Case | 触发条件（可机械判定） | 判定方式 | 应对动作 | 通知对象 | 升级时限 |
|---|---|---|---|---|---|
| 上游无一手证据（原始对话不在 log / 双方都记不清） | `cross_session_log` 无对应行，或 spawn A/B 均答"记不清" | Step 2 访谈双方后仍拿不到一手意图/理解 | 标"取证不可达"挂起，**不写判断、不脑补拼故事** | 回问用户要线索（时间/关键词/对方是谁） | 用户仍给不出 → 该案永久 park，不占 pending |
| 访谈对象不回执 / 子会话 timeout / rate limit | spawn2.0 无 `childSessionId` 或轮询 `GET /result` 超时；backend 有 timeout/rate-limit 运行证据 | Step 1 噪声过滤 + 轮询超时判定 | 判系统问题（非沟通问题），不出沟通 judgment；缺一方视角就挑下一候选 | 无（系统类不惊动用户） | 访谈用满 2 次 spawn 仍缺 → 本候选本轮弃、不硬凑 |
| 落飞书 enqueue / 读回失败 | `feishu-sync-enqueue` exit≠0，或 receipt 无 `read_back_verified`、`drained.done<1` | stdout + receipt ndjson 检查 | **只重跑失败子步骤**；重发主判断行前先 `grep -c` 查重；`duplicate:true`=幂等命中安全 | 本地 jsonl append-only 底稿保留 | 重试仍失败 → 判断留 `awaiting_verdict`，下轮 `closure-report.py` 重扫 |
| 每日复盘子会话静默失败（scheduler 绿但 child failed） | `check-daily-review-outcome.sh` Gate 1：scheduler v2 最近 run 有 child `status=failed` | 脚本查 `GET /api/sessions/:id/result`（不耗 LLM 配额） | 记 `kind=child-failed` + `/api/notify` 告警；**Gate 3 恢复半环（2026-07-31）**：当日一次 spawn2.0 补跑（`backfill-dispatched`）→ 下轮追踪结局（`backfill-recovered`/`backfill-failed`） | 本 session 绑定群（`targetChatId` 钉死 `oc_e49e…`） | 补跑也失败或连续两日连跪 → 当日 `/api/notify` level=error 升级用户决策（`escalated-to-user`，每日最多一次） |
| 复盘零产 / 仅 backlog-GC，漏检开放复发项（scheduler 绿 + child completed 但成果没闭环） | `check-daily-review-outcome.sh` Gate 2：`closure-report.py --recheck-worklist` 的 `owed` 非空 | 本地恒运行、不依赖 scheduler；owed=当天没给开放复发项留复检行 | 记 `kind=recheck-owed` + `/api/notify` 告警 + 判红；回 Step 7 #5 逐条补 next-run-verified/recheck-skipped-with-reason | 本 session 绑定群 | owed 连续 ≥2 轮非空 → 圈末自检上报「复检管道已死」 |
| 判断积压不收口（闭环率走低 / backlog 持续涨） | `closure-report.py` 闭环率下降或开放态≥7 天堆积增长 | 每轮跑 `closure-report.py` | 开放态≥7 天 → 一次性 ONE digest `/api/notify` 催 verdict（**绝不逐条 ping**）；>30 天无 verdict → `closed/stale_cold` | 本 session 绑定群 | 闭环率长期走低 → 主动 `/api/notify` 自报"判断在积压没落地" |

## 禁用项 (Do NOT during execution)

- **一次沟通只按一个 outcome 判**。**Why**：B 回复 / 流程跑完 / `status=completed` 都可能是假成功，SK 治的正是这种。**How to apply**：Step 3 判 outcome 只认"A 拿到想要的东西"。
- **`cross_session_log` 只当雷达、不当 evidence**。**Why**：A 真要什么、B 真懂没懂不在字段里。**How to apply**：没双方访谈不写正式 judgment（Step 2/3）。
- **看到疑似不立刻问、先堆候选批量处理**。**Why**：拖到事后状态变了、记忆糊了、飞书直聊原始对话根本不在 log，evidence 变冷。**How to apply**：Step 1 命中即进 Step 2。
- **daily review 成果回流 scheduler**。**Why**：scheduler 是 fire-and-forget，拿到 child ref 就完事；成果只在 SK 侧闭环。**How to apply**：Step 4 收尾只说"已在 SK 侧收口"，不带业务正文。
- **信 scheduler `lastSuccessAt`、不 self-check 前一轮 spawn 成果**。**Why**：它只证触发不证成果；2026-07-05/06 子会话静默失败零告警。**How to apply**：Step 0 / 额外自检查 `daily-review-health.jsonl`。
- 没访谈过双方就写判断 → 脑补
- 一次产出 ≥ 3 条 → 没意义。每天 1-2 条质量就行
- 把字段名 / 勾 / 加号当陈述写 → 不说人话
- 把"同源根因 + 多 session 各自处理"当成"重复劳动" → 1-vs-N fanout 是正常分工（详见 `rules/judgment-thresholds.md` 反例-1）
- 把判断推送给用户后用户没回复就当"准了" → 没 verdict 标 `awaiting_verdict`、按 Step 7 追到收口，**别无限期烂在 pending**（只判断不收口 = 为巡检而巡检，闭环率归零）
- 复发类判断「没拿到真实下轮样本就什么都不 append」（静默漏检）或「把 `0 次 re-fire` 当 pass」（触发消失≠复发被 backoff 拦停）→ 都是假成功。**每轮**对 `--recheck-worklist` 的每条 owed 留 next-run-verified 或 recheck-skipped-with-reason，绝不静默（judg-2026-07-08-001 因此漏检 2 天）
- **复检/landing 行不带锚就 append**（无 `run_id`/`receipt`、或把 `ts` 预填成未来时刻）→ 假复检，`closure-report.py` 不认、判断仍 owed（07-23 实测：三条无锚 landing 行让 owed 假空、Gate2 假绿；07-29 仍有 ts 预填行残留）。每条复检/landing 行按 Step 7「⚓ 受锚要求」带本轮 run_id + run 开始后的真 receipt；**手写 append 一律走 `scripts/append-journal.sh`**，ts 由脚本打真实落盘时刻，自填未来时刻在机制上已不可能
- **同一 `judgment_id` append 第二条 `kind=primary`**（实体行：theme+symptom 非空）→ 复盘 run 重复起草，snapshot/飞书按 id 归约会盖掉一条、closure-report 判「重复主判断行」。同 id 状态推进只 append `status-transition`，绝不再写 primary；已发生的由 `--emit` 自动补 `dedupe-annotation` 标掉（07-23 judg-2026-07-23-001 即两条 primary）
- 只盯"今天出了几条判断"当产出 → SK 的产出是**闭环率**，不是判断条数；圈末不写自检 = 看不见自己在积压
