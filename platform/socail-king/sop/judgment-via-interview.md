# 双边访谈出判断

socail-king 每天产出 1-2 条沟通效率判断的具体步骤。

## 核心约束

**三条铁律：**

1. **一次沟通 = 一次成果。** 判断尺度——A 一次 spawn 是不是拿到了他想要的东西。拿到了就不算问题，没拿到才是 socail-king 要查的。
2. **cross_session_log 是雷达不是 evidence。** 它只能告诉我"这里大概有个事"，但 A 真要什么、B 真懂没懂、当时的上下文，都不在字段里。第一手 evidence 必须从双方当时的状态拿。
3. **看到疑似的当下立刻去问，不许堆候选批量处理。** 拖到事后再问，状态变了、记忆模糊、上下文丢了，evidence 就凉了。原始对话甚至可能根本不在 log 里（比如飞书直聊），过几天回头查就更没线索。

## Step 1：扫雷达

### 这一步在干嘛

扫 cross_session_log 增量，找"A 没拿到成果"的蛛丝马迹。**不下结论**，只是挑出"值得当下立刻去问的对象"——挑到就立刻进 Step 2，不要继续往下挑、堆候选。

### 信号（命中任一就触发当下取证）

- **prompt 没说清楚要什么**：A 没写目标 / 没写期望的输出形式 / 没写关键 ID（任务 ID、文件路径、ASIN 等）。B 大概率在猜。
- **final_message 跟 prompt 不对题**：B 没正面回应 A 的问题，或答了别的事。
- **同一对 A↔B 短时间多次反复**：一次没拿到才会再问。
- **B 的回答里有困惑信号**：「请问」「不太确定」「能否再说明」「我没找到」之类。
- **灰区命中**：to_session 落在 `rules/gray-zones.md` 的 8 个混淆区——比如发给 amzdata 但请求是原始 SQL（更应该 amz-sql）。

### 先过滤的系统噪声（不算沟通问题）

- B 的 codex backend（执行后端）有当次错误、超时、空输出等运行证据 → 系统问题；不要只因为 B 是 codex 就过滤
- 子会话 timeout / rate limit → 框架问题
- alias 路由命中 → 不算找错人

### 用什么工具

- `scripts/lookup-session.sh by-id <sess_xxx>` 把 UUID 解析成 name / purpose
- `scripts/lookup-session.sh resolve-child <sess_child_xxx>` 把 child id 解析回 parent
- `rules/gray-zones.md` 看是不是混淆区
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
```

### 问 B 的模板

```
我是 socail-king。看到 [时间] [A 的 name] 给你发了一条请求：

「[完整 prompt]」

想问你三件事：
1. 你收到这条请求时，理解的是什么意思？
2. 你为什么用「[final_message 摘要]」这种方式回？
3. 你回完之后觉得自己答到位了吗？还是其实没把握 / 觉得 prompt 没说清楚？
```

### 怎么 spawn

```bash
curl -s -X POST http://localhost:3501/api/spawn \
  -H "Content-Type: application/json" \
  -d '{"target": "<name>", "prompt": "..."}'
```

两个访谈请求都走 HTTP API spawn。需要并发时，用 shell 后台任务或连续发两条 `curl`，不要用模型内置的 subagent / `run_in_background` 工具；那不是跨 session 协作的权威路径。等双方回执都拿到再进 Step 3。如果返回里只有 `childSessionId` 或 `switched_async`，用 `GET /api/sessions/:childSessionId/result` 轮询结果，不要直接读底层数据库。

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

### 没拿到双方视角怎么办

不写判断。挑下一个候选。**没访谈过的判断 = 脑补，不算成果。**

## Step 4：落本地 + 推飞书

### 落本地

append 到 `state/judgments.jsonl`。一条 JSON 一行，包含上面所有字段 + `interview_a` + `interview_b` 两个字段（双方原话摘要）+ 时间戳 + judgment_id。

### 推飞书

```bash
lark-cli base +record-batch-create --as bot \
  --base-token <SOCIAL_KING_BASE_TOKEN> \
  --table-id <SOCIAL_KING_TABLE_ID> \
  --json '<payload>'
```

注意：
- ts 字段用毫秒时间戳，不是 ISO 字符串
- select 字段（theme / confidence / gray_zone_hit / user_verdict）传枚举名字符串
- 返回里的 `record_id` 要回写到 jsonl，方便后续 PATCH

## Step 5：吃用户反馈

### 怎么吃

用户在飞书表里改 `user_verdict`（准 / 偏了 / 抓歪了）+ 写 `user_note`。我每天扫一遍飞书表，把新增的 verdict append 到 jsonl（不原地改原判断行）。

### 反馈的去处

- **准**：判断验证。把 evidence 里的访谈模式提炼成 `rules/coordination-patterns.md` 的一条。
- **偏了**：方向对但细节有问题。在 jsonl append 一条修订行，说明哪里偏。
- **抓歪了**：方向错了。在 `rules/judgment-thresholds.md` 的"识别误区"加一条反例。

### PATCH 飞书表

```bash
lark-cli base +record-upsert --as bot \
  --base-token <...> --table-id <...> --record-id <recvh...> \
  --json '{"user_verdict":"...","user_note":"...","applied_to_rule":"..."}'
```
注意 record-upsert 用单层 dict（跟 batch-create 的 fields/rows 结构不一样）。

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

## 不该做的事

- 没访谈过双方就写判断 → 脑补
- 一次产出 ≥ 3 条 → 没意义。每天 1-2 条质量就行
- 把字段名 / 勾 / 加号当陈述写 → 不说人话
- 把"同源根因 + 多 session 各自处理"当成"重复劳动" → 1-vs-N fanout 是正常分工（详见 `rules/judgment-thresholds.md` 反例-1）
- 把判断推送给用户后用户没回复就当"准了" → 没 verdict 就保持 pending
