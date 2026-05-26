# [DEPRECATED 2026-04-25] 旧 PMO 报告流程，已废弃

> **不要按这个 SOP 工作。** 新流程见 `sop/judgment-via-interview.md`。
>
> **为什么废弃**：这套 PMO 七问八答的报告流程光扫 cross_session_log 字段就下结论，不访谈通讯双方，做不出真判断。用户在 2026-04-25 直接说"长报告冗长且没效果"，新方向是每天 1-2 条「问过双方再下判断」的人话陈述。
>
> 留着不删，作为反思参考——下面这套结构本身没错，错在跳过了"问双方"这一步。

---

# 核心目标（旧）

这是一个 **Procedures（操作流程）** SOP，用来指导 `socail-king` 每天审阅 `cross_session_log` 的增量记录，并输出一份符合 PMO（项目管理办公室）视角的跨 session（会话）沟通诊断报告。  
目标不是复述“谁跟谁说了什么”，而是稳定回答组织层面的固定问题：摩擦在哪里、为什么卡住、哪些可以标准化、短中长期该怎么改。

## Step 1: 读取增量与全量背景

### 要解决的问题（Problem）

如果只读当天新增记录，会丢失历史背景；如果只读全量，又无法看出“今天有没有变化”。因此报告必须同时拿到“增量窗口”和“全量背景”两层视角。

### 输入（Input）

- `supermatrix.db` 数据库
- `cross_session_log` 表
- 上次游标文件 `state/cross-session-review-state.json`

### 处理（Processing）

- 读取增量记录：`event_time > cursor` 的记录
- 同时读取全量 `cross_session_log` 作为背景基线
- 生成新的 cursor（游标）

### 产物（Output）

- 增量记录集合
- 全量背景记录集合
- 新 cursor

### 下一步消费方（Next）

Step 2 使用这两层数据做 PMO 诊断。

## Step 2: 按 PMO 必答题做诊断

### 要解决的问题（Problem）

普通统计摘要会退化成流水账。PMO 诊断必须强制回答固定问题，即使答案是“证据不足”也不能跳题。

### 输入（Input）

- 增量记录
- 全量背景记录

### 处理（Processing）

每次报告都必须逐题回答以下 7 个问题：

1. 当前最突出的系统性摩擦点集中在哪些业务环节？
2. 这些摩擦更像“人”的问题还是“系统”的问题？
3. KPI（关键绩效指标）互斥或权责灰区出现在哪里？
4. 哪些沟通可以被 SOP（标准作业程序）或自动化替代？
5. 谁是当前最像“基准制定者”的 session（会话）？
6. 短期要建立怎样的 PDCA（计划-执行-检查-处理）止血闭环？
7. 长期来看系统建设应该往哪里重构？

输出要求：

- 每题必须包含“结论”
- 每题必须包含“证据等级”
- 每题必须包含“证据”
- 不允许跳题；证据不够时必须明确写“证据不足”
- 每次报告还必须单独产出“本次新增认知”章节
- “本次新增认知”必须跟上一次报告不完全重复；每天 1 个高质量主洞察即可，不追求数量
- 主洞察必须像 PMO（项目管理办公室）诊断一样回答：发生了什么、实际机制如何运行、它偏离了什么更简单高效的工作方式、为什么这是系统问题、下一步应如何修正
- 主洞察必须额外写出“我推测这件事实际产生的影响是什么”，并明确这是推测/判断，不要写成已证实事实；最好给出置信度，方便用户反馈校正
- 主洞察必须来自具体沟通内容或源文件链路，而不是记录数量、状态分布、发送次数等表层统计
- 每次报告还必须单独产出“本次思考题”章节
- “本次思考题”必须由本次阅读自己提出，不能复用固定模板
- 这道题必须基于所有沟通记录或全量背景做检查，不能只看当天增量
- “本次思考题”至少要写清：问题、检查范围、发现、回答解答
- 关键结论不能只来自数量统计，必须回到 `prompt / result_preview / error_message` 的内容本身
- 每个重点判断至少要附 1 条代表性内容片段，证明这条判断是“读内容得出”，不是只看次数猜的

### 产物（Output）

- 七题诊断结果
- 支撑这些结果的数据证据

### 下一步消费方（Next）

Step 3 把诊断组织成 Markdown 报告。

## Step 3: 生成报告并留档

### 要解决的问题（Problem）

报告不能由主 session 直接一把写完。用户已经明确要求：每次定时任务出报告时，必须先 spawn 一个子 session 起草，再由主 session 审核并给出反馈，最后让子 session 按反馈修订，只有修订后的 final 版本才允许落盘和发给用户。

### 输入（Input）

- 七题诊断结果
- 数据支撑明细

### 处理（Processing）

1. 主 session 先写上下文文件：
   - `reports/context/YYYYMMDDHHMMSS-cross-session-review-context.json`
2. 主 session 通过 `/api/spawn` 拉起一个子 session 做首轮 draft：
   - draft 报告：`reports/YYYYMMDDHHMMSS-cross-session-review-draft.md`
   - draft 摘要：`reports/YYYYMMDDHHMMSS-cross-session-review-draft-summary.txt`
3. 主 session 审核 draft，生成审核意见：
   - feedback：`reports/review/YYYYMMDDHHMMSS-cross-session-review-feedback.txt`
4. 主 session 再次 `/api/spawn` 子 session，要求它根据 feedback 修订：
   - final 报告：`reports/YYYYMMDDHHMMSS-cross-session-review.md`
   - final 摘要：`reports/YYYYMMDDHHMMSS-cross-session-review-summary.txt`
5. 只有 final 通过审核门禁之后，才允许：
   - 发送飞书摘要
   - 发送飞书文档
   - 更新 `state/cross-session-review-state.json`

审核门禁固定检查：

- 7 个 PMO 必答题是否齐全
- 是否具体引用了沟通内容片段，而不只是数量统计
- “本次新增认知”是否与上次相比有差异，并且是否形成了 1 个可行动的主洞察
- 主洞察是否还原了事实链：谁产出了什么、谁如何分发或处理、实际结果和理想流程之间的偏差在哪里
- 主洞察是否给出了系统修正建议，而不是停留在“某 session 没做好”的个人归因
- 主洞察是否写清了“实际影响推测”与置信度
- 是否存在“本次思考题”，而且它确实基于全量沟通记录做过检查并给出回答解答
- 摘要是否独立可读
- 摘要是否明确“摘要与文档同时交付”
- 是否同时给出短期 PDCA 和长期系统重构建议

state 文件除 cursor 外，还要保存：

- 上次发送使用过的 insight key（认知键）
- 上次摘要文本
- 上次 final 摘要路径
- 上次 review feedback 路径

### 产物（Output）

- context / draft / feedback / final 全套产物
- 更新后的游标文件

### 下一步消费方（Next）

Step 4 负责把报告发送给用户，并验证调度链路正常。

## Step 4: 发送给用户并验证调度

### 要解决的问题（Problem）

文档如果只落盘、不发送，用户不会主动去翻；调度如果只建不验，很容易停留在“看起来已配置”。

### 输入（Input）

- 报告文件
- session 绑定的 Feishu chat_id
- scheduler 任务配置

### 处理（Processing）

- 先发送 final 摘要文本，再发送 final 报告文件；不能只发文档
- 摘要文本至少包含：
  - 总长度不超过 200 字
  - 只写 1 个问题
  - 这件事的实际影响推测
  - 置信度
  - 已附完整文档
- 摘要还必须明确：
  - 与上次相比的新认识
  - 已附完整文档 / 摘要与文档同时交付
- 文件发送继续使用 `lark-cli im +messages-send --as bot --chat-id <chat_id> --file ./<filename>`
- 首次调整报告逻辑后，必须手动跑一次：
  - 全量报告：验证历史回顾是否合理，而且能走完整的“draft -> review -> revise -> final”链路
  - 增量报告：验证日常模式是否还能正常执行
- 若涉及定时任务改动，检查 scheduler 的 task 详情与最近 run 记录
- scheduler 现在要求每个 `class=sync_job` 任务都有 receipt proof（回执证据）配置；本任务用 `state/cross-session-review-state.json` 的 mtime（修改时间）做证据，因为该文件只在最终审核门禁通过后才会被写入。任务必须包含如下 overrides：
  ```json
  {
    "overrides": {
      "receiptProof": {
        "kind": "external_evidence",
        "engine": "file",
        "target": { "path": "<SM_WORKSPACE_ROOT>/socail-king/state/cross-session-review-state.json" },
        "expectation": "mtime > trigger"
      }
    }
  }
  ```
  若 receipt 校验失败（finalStatus=evidence_missing），先确认 state 文件 mtime 是否晚于 triggeredAt；如否，说明任务真正失败，按上面 Step 1-4 排查；如是，说明 overrides 丢失或被清空，需要重新 PATCH 回去

### 产物（Output）

- 用户已收到报告
- scheduler 任务已验证

### 下一步消费方（Next）

下一个周期继续从 Step 1 开始。
