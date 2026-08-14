# 判断尺度

socail-king 写一条判断时用的标准。

## 顶层尺度：一次沟通 = 一次成果

A 一次 spawn 出去，必须拿到他要的东西。拿不到就是这次沟通失败——不管 B 回了句话、跑了流程、还是 status 显示 completed。

判断成果不看状态字段，看实质：A 想要的事有没有发生。

这条尺度需要双方亲口确认才能用，光看 log 字段推不出来。所以必须问双方。

## 这份文件的位置

这里的"信号"只是用来**触发当下取证**的，不是用来直接下判断的。

**信号一响，立刻 spawn 双方问真实视角——不要堆候选批量处理。** 拖到事后再问，evidence 已经凉了：状态变了、记忆模糊、相关上下文丢了，原始对话甚至可能根本不在 log 里（飞书直聊）。

跳过访谈直接从信号写判断 = 脑补。详细流程见 `sop/SOP-judgment-via-interview-active-20260711-gq1fni.md`。

---

## 一、触发当下取证的信号

下面这些信号一旦命中，**立即**进入访谈环节，不要继续往下挑、堆候选。**信号本身不是结论。**

### 信号 A：prompt 没说清要什么

A 给 B 的 prompt 缺以下任一项时，B 大概率在猜：

- **目标**：这次想达成什么——"帮我查 X" 不算，"我要知道 X 的当前值用来做 Y 决策" 才算
- **期望的输出形式**：B 怎么知道交付到位了——一句话？JSON？文件？
- **关键 ID 或路径**：run_id / file path / asin / session id 等具体指针——不带就靠 B 猜
- **必要背景**：B 需要的非默认上下文——比如"这是 04-22 那次重构后的"，不带 B 会用旧假设

四项缺 ≥ 2 项 → 候选。

### 信号 B：B 的回复有困惑迹象

final_message 里出现「请问」「不太确定」「能否再说明」「我没找到」「能否提供」之类，或者反问 A → 候选。

### 信号 C：final_message 跟 prompt 不对题

B 答的不是 A 问的，或者只回了"我已处理"这种空话 → 候选。

### 信号 D：同一对反复来回

同一对 A↔B 在短时间内多次 spawn → 一次没拿到才会再问 → 候选。

### 信号 E：灰区命中

to_session 落在 `rules/gray-zones.md` 的 8 个混淆区之一，且 prompt 内容更像应该找另一个 session → 候选"找错人"。

### 信号 F：跨 session 约定或平台 workaround 影子

这类信号只说明"可能有涌现态",不能直接写 judgment。命中后按普通流程访谈 A/B,只判断这次 A 有没有拿到成果。

命中条件:

- 同一接口 / 工具 / 字段 / 回执格式在 7 天内出现在 ≥ 2 对不同 A↔B 的 prompt 或 final_message 里,且伴随"校验 / workaround / 临时约定 / 回执格式 / anchor / predicate / 权限报错 / 静默吞 / 解析不上"等词。
- 同一对 A↔B 在 24 小时内围绕回执格式或 closure 约定反复来回 ≥ 2 次,例如 `OK <task_id>`、`ACK`、`REPORT:`、anchor、predicate、receipt token 新旧格式并存。
- B 的 final_message 明确说"我这边先加校验 / 先绕过 / 按新格式回 / 旧格式解析不了 / 需要某 owner 升级原则",但 A 的 prompt 只是想拿一个业务结果。

处理规则:

- 只把它当优先访谈雷达,不要新建横向 listener,不要扫各 session git diff。
- 访谈时额外问一句:"这是不是你们临时发现的平台行为或新约定? 还有哪些 session 可能会撞到?"
- judgment 正文仍按一次沟通写:如果 A 拿到成果,不写失败;如果没拿到,写这次损失,并在 evidence 里标注这是"涌现态影子"。

### 信号 G：静默死亡——comm pending 但 child 已 deleted

命中条件: `cross_session_log.status='pending'` 且其 `child_session_id` 在 sessions 表里 `status='deleted'`,悬空超过 1 小时。典型成因是 console 重启的 boot reconcile 把在途 child 判 orphaned 删除,但 comm 不置 failed、caller 零通知(2026-07-15 一次重启即产生 6 条,2 条永久悬空,见 judg-2026-07-16-001)。

处理规则:

- 这不是 B 的锅,先查同窗口是否成簇(同一次重启会一锅端多条)——成簇即框架事件,查 `rules/framework-fix-tracker.md`「console restart 孤儿在途 comm 静默死亡」条目状态。
- 关键判断点是 caller 有没有自愈:查同 A→B 的后续重发。有重发且 completed = 该条自愈;无重发 = caller 到现在都不知道请求死了,访谈 A 确认业务是否断掉、并让 A 知情。
- framework 条目 🔴 期间,同型新增案例并进已有 judgment 的 evidence,不另开新判断。

---

## 二、必须先过滤掉的系统噪声（不是沟通问题）

- B 的 codex backend（执行后端）有当次错误、超时、空输出等运行证据 → 系统问题；不要只因为 B 是 codex 就过滤
- 子会话 timeout / rate limit → 框架问题
- alias 路由命中（传 `查数` 命中 dataquery）→ 不算找错人，是设计如此

---

## 三、识别误区（反例库，看到这种形态先停下来）

### 反例-1：1-vs-N fanout ≠ 重复劳动

**误判形态**：看到同一时间窗内多个 session 各自处理同源根因引发的不同 task，把它标成"重复劳动 / 沟通低效 / 缺群体广播"。

**实际**：每个 session 有自己的 task config / overrides / 修复路径，必须独立判断和处理。N 次诊断是工作的必要形态，不是浪费。"同源根因"和"同一份工作"是两件事——上游一个变更引发 N 个不同位置各自适配，本来就是 fanout 的正常分工。

**真正的重复劳动**要同时满足：

- prompt 实质相同（不是格式同源，是字面问题相同）
- 期望的 result 也相同
- 多次执行后 result 也确实相同

例如：同一查询被 self-spawn 3 次返回相同答案——这才是重复。

**判例**：`judg-2026-04-25-001`（用户 verdict: 抓歪了）。我误把 scheduler 1-vs-N 派单当成沟通低效。详见 `state/judgments.jsonl`。

---

## 四、判断的写法

判断主体只讲"发生了一件什么事 + 实际影响"，附录放证据。

### 主体格式

```
[频次] [谁] [做了什么 / 没拿到什么]，导致 [谁] [付出了什么代价]。
```

例如（凭空举的反例，不要直接用）："上周 after-sales 三次问增长天王同一类问题都没拿到能用的答案，导致售后流程那边每次都要自己去翻数据，多花了 N 分钟。"

### 附录字段

- evidence：cross_session_log id + A 怎么说 + B 怎么说
- interview_a / interview_b：双方原话摘要
- confidence：high（双方视角清晰 + 损失可量化） / medium（视角拿到但损失靠推断） / low（视角不完整或互相矛盾）
- gray_zone_hit：#1~#8 哪条 / none

### 说人话

写之前默念："旁边坐个人，我会用嘴这么对他说吗？" 不会就重写。勾、加号、不等号、版本号、中英拼、"反例-1" 这种档案编号——都是给机器看的标签，不是给人说的话。

---

## 五、什么值得推飞书 / 什么只落本地

- **只落 jsonl + 飞书表（不主动打扰用户）**：单次低影响，confidence ≤ medium
- **额外推一条飞书短消息打扰用户**：以下任一触发：
  - severity = high（信任侵蚀类，比如系统假成功）
  - 同类问题 7 天内累计 ≥ 3 次（系统性，非偶发）
  - 涉及用户当天必须可靠的任务（用户关心度地图，待补）

---

## 六、反馈怎么吃

- 每条判断写出时同步 append 到 `state/judgments.jsonl`，初始 user_verdict = 待校准
- 用户在飞书表写 verdict（准 / 偏了 / 抓歪了）+ note → append 一条新行到 jsonl，**不原地改原判断**
- 攒够反馈（每周或 ≥ 5 条）回写本文件 / `rules/gray-zones.md` / `rules/coordination-patterns.md`
