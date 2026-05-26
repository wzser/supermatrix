---
last_updated: 2026-05-15
confidence: high
refresh_cadence: event-driven
parent: null
children: []
unwritten_children:
  - memory-poisoning-defense: "agentic 系统的 memory poisoning 攻击面与防御，目前在 §9 + 引 [S0027]，等更多防御实践再独立"
boundary_with:
  - harness: "harness §4 谈 context engineering 是 memory 的工作 context；本综述谈跨 session / 跨项目的持久化记忆"
  - agent-dreaming: "memory 是 dreaming 的原料与产出场所；dreaming 综述讲反思机制本身"
---

# Memory（Agent 记忆）

---

## 1. 为什么 memory 是独立问题，不是 "长 context window"

早期朴素观点认为：只要模型上下文窗口够大，agent 自然就"记得"。这个假设在过去一年被系统性推翻。核心原因是 **context rot**：窗口填满后输出质量不线性下降，而是塌方 [S0009] [S0041]。哪怕你有 200k tokens，塞满之后效果未必比 20k 好 [S0041]。所以"让 LLM 把所有历史全部带上"既贵又无效。

更根本的是：**memory 不等于历史记录**。Anthropic 在 context engineering 中明确把 memory 与 compaction、tool result clearing 并列为三种独立的 context 管理机制 [S0009] [S0023]。memory 是**可跨 session 检索、被选择性加载的外部状态**；compaction 是压缩当前窗口；tool clearing 是卸下过期工具结果。三者服务不同问题，不能互相替代。Cobanov 在交互式综述里把这层抽象拎到最简：**stateless LLM 调用每轮只看自己的 prompt；agent 是绕着 LLM 的 orchestration loop，决定下一轮往 prompt 里塞什么**——memory 就是那个 loop 里负责"把信息往前带"的部分，所有架构选择都在回答同一道题：这一轮 prompt 应该放什么 [S0159]。

Harrison Chase 把这个判断推到产品哲学高度：**harness 和 memory 是耦合的，谁控制你的 memory 谁就锁定你**。闭源 harness 私有存储 memory 意味着你换 agent 时等于失忆——因此 harness 和 memory 都应该开源、可携带 [S0003]。这从"技术细节"上升到"agent 基础设施归属权"的问题。

---

## 2. Memory 的生命周期：从交互到可复用知识

几乎所有严肃系统都把 memory 当成**有生命周期的管线**处理，而不是"把对话写进数据库"这种朴素做法。

OpenAI cookbook 把生命周期拆成四步 [S0028]：
1. **Distillation**：把一次交互压成可复用的记忆单元（不是全文保留）
2. **Consolidation**：跨多次交互合并同类记忆、去重、消歧
3. **Forgetting**：显式淘汰过期或低价值条目
4. **Injection**：在需要时把相关记忆塞回 prompt

AWS AgentCore 提供了工业级实现：long-term memory pipeline 把原始对话流转成结构化记忆，再按主题/用户/项目维度组织 [S0032]；其 episodic memory 专门处理"experience 级"条目——把"某次任务完整轨迹"作为一条经验存起来，后续类似任务可以直接检索而非从零推理 [S0033]。

Microsoft 的 PlugMem 给了另一种分解视角：**memory = facts + skills**。facts 是陈述性知识（谁、什么、何时），skills 是程序性知识（怎么做）。两者存储和检索路径不同 [S0034]。Microsoft CORPGEN 在企业场景补充了**多任务 memory isolation / tiered memory / adaptive summarization**——不同项目不同命名空间，不同层做不同精细度的压缩 [S0035]。

IBM 的 trajectory-informed memory 更激进：不是从对话提取，而是从 agent 的**执行轨迹**（工具调用序列、成败标志）里提炼可复用经验，实验上相比无 memory baseline +14.3% [S0052]。类似思路的 ERL (Experiential Reflective Learning) 把任务 trajectory 抽象成 heuristics 入库，+7.8% [S0053]。这两条都指向一个趋势：**memory 的原料不只是自然语言，还包括轨迹这种半结构化信号**。

Khaos Brain（开源，MIT）把同一思想做成卡片系统：把"在什么条件下、采取什么动作、成功/失败概率"固化为 **experience card**，存入 Git-版本化本地文件库；同时区分 personal（本机）和 organization（GitHub repo 共享）两层，对应 private 偏好 vs 可复用任务模型的分工 [S0167]。这是 IBM 轨迹提炼 + markdown 文件 + 跨 agent 共享几个思路的工程综合。

---

## 3. Memory 的层级与分工

"一个 memory" 是错的。主流系统都在分层。

认知科学给了一套被各家 agent 框架直接搬来的 4 元 taxonomy [S0159]：**episodic**（带时间戳的事件——"周二用户问起 Berserk 漫画"，按 recency / 时间窗 / 主题检索）/ **semantic**（事实与关系——"用户住在 Highland Park"，按相似度检索）/ **procedural**（学到的技能与工具——什么场景该调哪个 tool，按情境激活）/ **working**（当前 scratchpad——本轮交互正在推理的活跃 context）。同一个 agent 在一次回答里通常四套都用上：episodic vector 搜索回到相关历史 → semantic RAG 拉知识库条目 → procedural 决定触发哪个 tool → working memory 把 system prompt + 检索结果 + tool 输出 + 新消息合并送进 LLM。这套 taxonomy 不是哲学分类，而是"不同存储介质 / 不同写入规则 / 不同检索策略"的工程提示。

**Google** 在多 agent 框架里给出了四层模型 [S0031]：
- **Working Context**：当前 session 内的短期状态
- **Session**：单次会话跨 turn 的持久化
- **Memory**：跨 session 的长期记忆
- **Artifacts**：产出物（文件、数据、图表）

这四层各自有存储介质和生命周期，上层按需下沉。

**OpenClaw** 把 promotion 做成显式 gate [S0049]：短期观察先进 staging，要被 promote 到长期 memory 必须通过 **score / recall frequency / query diversity** 三道闸——得分够、被取用的次数够、取用场景够多样。这是从"朴素时间序"到"价值驱动"的转变。配套 CLI 命令包括 `openclaw memory status / search / index / rem-backfill`（`--stage-short-term` 入暂存、`--rollback` 回滚）[S0049]，以及 gateway / ACP 层的 `openclaw acp` 会话控制 [S0050]——承认 memory 是需要被运维的系统，不是自动生效的黑箱。

**Anthropic** 的 Memory tool 走另一条极简路线 [S0025]：约定一个 `/memories` 目录，Claude 通过六条 tool 命令（`view` / `create` / `str_replace` / `insert` / `delete` / `rename`）对其中的文件做 CRUD，**数据存储完全由客户端掌握**（文件系统 / 数据库 / 云对象存储 / 加密存储都可，ZDR 合规）。设计重点不是"版本化"而是 **just-in-time retrieval**——不在任务开头一次性把历史塞进 context，而是让 Claude 在任务开始时先 `view /memories` 目录、再按需拉具体文件。鼓励 agent 自主 rename / delete 过期文件以保持 memory folder "up-to-date, coherent and organized"。

**subagent memory isolation** 是 Anthropic 另一条独立设计 [S0026]：subagent 有自己的 memory 命名空间，父 agent 看不到 subagent 内部积累的 context，只拿最终返回。这避免了"父 agent context 被子任务细节污染"，同时也意味着 subagent 的学习不会自动回流——需要显式 summary 机制。

把 Cobanov [S0159] 的 6 架构对照矩阵叠在这套层级讨论上有助于看清 trade-off：simple buffer / rolling summary / vector store / knowledge graph / hierarchical（MemGPT）/ self-editing（Letta）这六种方案在 **scale / structure / supersedes / PII gate / sharing / audit** 六个维度上互相补全——vector store 在容量与语义召回上是默认底座，但本身没有时间观与关系观，需要外挂 metadata 与 policy；knowledge graph 给结构与关系，但 scale 受限；hierarchical / self-editing（MemGPT、Letta）则把"agent 自己改写自己的长期 store"做进架构。**生产里通常不是选一个**——常态是 vector + graph + governance 三层叠用，governance 层负责 supersession、PII gate、audit log，把基础设施层缺的能力补齐。


---

## 4. 落到文件：Markdown 作为 portable memory

一个反直觉但被多方采纳的选择：**把长期记忆落成人可读的 markdown，而不是 vector DB**。

Anthropic 的 long-running Claude 做科学计算时，用 `CHANGELOG.md` 作为 portable long-term memory——agent 把每次 session 的关键决策、失败教训、下次要避开的坑写进去，下次开新 session 时直接 cat 进 prompt [S0024]。OpenAI 的 long-horizon Codex 采纳同样思路，把 spec/plan/constraints/status 四类信息固化到独立 markdown 文件，agent 本地就能维护"durable project memory" [S0029]。MorphLLM 把这条工程化为 `CLAUDE.md` + lazy-loading 模式 [S0042]。

为什么选 markdown？三个原因：
1. **人类可审查**。vector DB 的 embedding 是黑箱；markdown 你能打开看。
2. **可携带**。md 文件跟项目走，不绑定某个 harness 或 vendor（和 Harrison Chase 的论点闭环 [S0003]）。
3. **可被 LLM 高效消费**。LLM 对自然语言比对 DB schema 更友好。

OpenClaw 的 DREAMS.md 把这个原则用到极致——dreaming 流程产出的记忆条目全部落进 DREAMS.md，用户可审查、可删改 [S0048]。OpenClaw memory.md 原文进一步把文件组织明确为三件套：`MEMORY.md`（长期事实 / 偏好 / 决策，会话启动自动加载）+ `memory/YYYY-MM-DD.md`（每日笔记，今日与昨日自动加载）+ `DREAMS.md`（dreaming sweep 摘要 + grounded backfill 评审面）[S0049]。

代价是：markdown 在**大规模精确检索**上不如 vector DB，且 agent 需要学会如何"编辑而非追加"（否则文件无限膨胀）。这是当前公开方案的共同未解问题。

---

## 5. Sleep-time compute 与 memory reconsolidation

传统 memory 系统是**被动**的：agent 完成任务，写一条；下次来，查一条。Letta 提出的 **sleep-time compute** 把 memory 变成**主动**的 [S0043] [S0044]。

核心思想：在 agent 空闲（不在处理用户请求）的时段，启动一个独立的 sleep-time agent，让它：
- 重新翻阅最近的 memory blocks
- 做合并、去重、冲突消解
- 把低价值条目 downweight 或 forget
- 产生新的 meta-insight（比如"我多次在 X 场景失败，下次要先检查 Y"）

实验结果显著：test-time compute 降至约 1/5，agentic SWE case study 里的任务完成率提升 [S0044]。架构上，primary agent 和 sleep-time agent **共享 memory blocks**，按 N 步触发 [S0045]。Letta Code 把它内置为 "dream subagent"，周期性反思对话 [S0046] [S0047]。

OpenClaw 走了类似路线但按**固定顺序**分了三段 **Light → REM → Deep**（详见 [concepts/agent-dreaming.md](agent-dreaming.md) §3）：Light 负责 ingest/dedupe/stage，REM 做 concept-tag 主题抽取，Deep 用六信号打分 + 三道闸门（minScore / minRecallCount / minUniqueQueries）把候选晋升进 `MEMORY.md`；产出另有 `DREAMS.md` 作为人类可审查面 [S0048]。配套 `openclaw memory promote` / `rem-harness` 预览、`rem-backfill` 回滚等运维命令 [S0048] [S0049]。

MIRROR (arxiv) 在模型层面提出 Talker / Thinker 异步 deliberation [S0051]：Talker 处理当前对话、Thinker 在背景反思，本质是同一思想的模型内化。

**反模式是"边对话边反思"**——这等于把 memory 管理混进 working context，既拖慢响应又污染当前任务的注意力。必须异步、在 idle 时做。

---

## 6. Memento：模型内生的 context 自管理

另一条与 sleep-time compute 正交的路径，是让**模型本身**学会管理 context，而不是外挂 harness。Microsoft 的 Memento 训练 LLM 识别自己的 context 里哪些该丢、哪些该写到外部 memory、何时该主动请求 recall [S0036]。

这条路线目前效果有限但方向重要：如果 agent 自己能判断"这个信息我等会儿还要用"和"这个信息可以忘"，外部 memory 系统就从"全权管家"退位为"可选仓库"。但同时，**LLM 自管理的失败**恰恰是 harness 崛起的原因（见 [concepts/harness.md](harness.md) §2），所以 Memento 式的方法更可能作为**harness 辅助**而非替代——harness 做兜底，模型做优化。

---

## 7. Benchmark 化：AgentMemoryBench / MemoryArena / CMV

memory 从"工程细节"变成独立研究层的标志是 benchmark 出现。

- **AgentMemoryBench** (openreview, ICLR track) [S0038]：把 memory 拆成 **system memory**（agent 本身学到的操作经验）+ **personal memory**（用户偏好、历史交互），做 continual-learning 评测。
- **MemoryArena** (arxiv) [S0037]：多 session memory 的综合 benchmark，测试跨 session 一致性、取用延迟、淘汰策略。
- **CMV / Contextual Memory Virtualisation** (arxiv) [S0040]：提出"内存虚拟化"框架，把 memory 访问抽象成类 OS paging 的 page-in / page-out。
- **MemAgents Workshop** (ICLR 2026) [S0039]：agent memory 作为独立研究 track。

这几条共同说明：**memory 不再是某个框架的 feature，而是有独立指标、独立赛道的研究对象**。

---

## 8. 企业级实战：OpenAI in-house data agent

理论之外，OpenAI 分享的内部 data agent 给了一个"大规模 memory 现场"的真实样本 [S0030]。核心做法：
- **corrections as memory**：用户每次修正 agent 的 SQL 或图表解读，修正内容直接入库，下次同类问题触发 warning
- **filter conditions as memory**：企业内部有大量"这张表要永远 filter 掉 test 用户"这类隐性约束，显式存进 memory
- **team-level sharing**：一个用户教 agent 的东西，同组其他用户能直接受益

这种 memory 的共性：**不是对话摘要，而是可执行的约束和规则**。和 Microsoft PlugMem 的 "skills" 维度对应 [S0034]。

---

## 9. 安全层面：memory poisoning

memory 一旦 persistent，就成了攻击面。Anthropic 提交给 NIST 的 agentic security RFI 明确把 **persistent memory poisoning** 列为主要风险之一 [S0027]：攻击者通过精心构造的一次交互，往 agent 的长期记忆里种下恶意"事实"或"偏好"，后续所有任务都被污染。

缓解思路（目前多是建议，无定论）：
- 显式 memory diff review（如 OpenClaw 的 DREAMS.md 人可审查）[S0048]
- 客户端托管 + 文件级存储：用户掌握底层 storage（Anthropic Memory tool 把 `/memories` 放在客户端基础设施里，Claude 只通过 `view` / `create` / `str_replace` / `insert` / `delete` / `rename` 六条命令操作），用户层可以自己做 snapshot / backup / rollback [S0025]
- source attribution：每条 memory 带来源，可溯源
- isolation（subagent memory 不影响父 agent）[S0026]
- **lifecycle governance gate**：原子层把 write 当 lifecycle 处理而不是 append——标 `valid from / valid until` 让旧事实显式 superseded 而非覆盖；PII pattern 在写入前过滤掉信用卡 / SSN / 健康信息（Cobanov 给的"naive append vs naive overwrite vs governed"对照展示了相同输入下三条路径的差异：append 漏 PII、overwrite 丢时间维度、governed 同时保留 audit 与时序）[S0159]

multi-agent 场景下，攻击面进一步扩大成一张 graph。Cobanov [S0159] 把 multi-agent memory 的失败模式归成 6 类：**cross-user leakage**（agent A 写到 project 域的偏好被 user B 在另一 session 命中）/ **over-sharing**（私有信息被错误 promote 到组织共享层）/ **poison propagation**（一条恶意 memory 在 shared store 里传播到多个 agent）/ **conflicting decisions**（两个 agent 在 shared store 里写下互相矛盾的事实）/ **stale playbook**（共享 runbook 过期，仍被新 agent 当事实拉回来）/ **attribution loss**（某条 memory 是哪个 agent 写的、为谁写的，链路丢失）。对应的最小防线是 **private-by-default、shared 显式声明 + 每次写入都校验 (tenant_id, user_id, scope) 三元组**，跨 tenant 默认 deny；再叠加 supersession / TTL / audit log 把"什么时候这条还有效、被谁修改过"显式化。

这是 memory 研究里最紧迫、也最欠缺成熟答案的方向。

---

## 10. 待解问题

- **编辑而非追加**：markdown memory 文件如何避免无限膨胀？需要 agent 学会 diff-style 改写。
- **memory 的冲突解决**：两条 memory 互相矛盾时，信哪条？按时间、按 confidence、按来源都有失败案例。
- **跨 agent memory 共享**：multi-agent 场景下，一个 agent 的经验如何安全地被另一个 agent 复用？subagent 隔离 [S0026] 是一端，AWS 的共享 store [S0032] 是另一端，中间缺乏清晰抽象。
- **memory 的成本账**：sleep-time compute [S0043] 把反思成本显性化，但目前各家 benchmark 没把"memory 维护成本 / 任务完成收益"这条曲线画清楚。
- **人类审查 vs 自动化的平衡**：DREAMS.md [S0048] 这类"全部人工可审"的路线在规模上有上限，但全自动又回到 memory poisoning 风险。中间状态（抽样审查、规则过滤、异常告警）尚无成熟方案。

---

## 相关综述

- [concepts/harness.md](harness.md)：memory 是 harness 的核心职责之一，§4 对抗 context rot 的三层策略与本文 §1–§2 高度耦合。
- [concepts/agent-dreaming.md](agent-dreaming.md)：本文 §5 sleep-time compute 的更深展开。
- [concepts/a2a-protocol.md](a2a-protocol.md)：跨 agent 场景下 memory 共享的协议层视角。

---

## 参考来源

本综述引用的所有 source，标识符 + 标题 + 内容类型 + 原始链接。点击 ID 可回到 `kb/sources/<file>.md` 读原文。

| ID | 类型 | 标题 | 链接 |
|----|------|------|------|
| [S0003](../sources/2026-04-11_your-harness-your-memory.md) | blog | Your harness, your memory | https://www.langchain.com/blog/your-harness-your-memory |
| [S0009](../sources/2025-12-15_anthropic-context-engineering.md) | blog | Context engineering: memory, compaction, and tool clearing | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents |
| [S0023](../sources/2025-09-01_anthropic-context-editing-docs.md) | docs | Context editing (Claude API Docs) | https://platform.claude.com/docs/en/build-with-claude/context-editing |
| [S0024](../sources/2025-08-15_anthropic-long-running-claude-research.md) | blog | Long-running Claude for scientific computing | https://www.anthropic.com/research/long-running-Claude |
| [S0025](../sources/2025-11-01_anthropic-managed-agents-memory.md) | docs | Memory tool (Claude API Docs) | https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool |
| [S0026](../sources/2025-11-05_anthropic-subagents-docs.md) | docs | Create custom subagents - Claude Code Docs | https://code.claude.com/docs/en/sub-agents |
| [S0027](../sources/2025-03-14_nist-rfi-agentic-security.md) | paper | NIST RFI on Agentic Security | https://www-cdn.anthropic.com/43ec7e770925deabc3f0bc1dbf0133769fd03812.pdf |
| [S0028](../sources/2025-10-10_openai-context-personalization.md) | docs | Context Engineering for Personalization - Long-Term Memory Notes (Cookbook) | https://developers.openai.com/cookbook/examples/agents_sdk/context_personalization |
| [S0029](../sources/2025-11-15_openai-long-horizon-codex.md) | blog | Run long horizon tasks with Codex | https://developers.openai.com/blog/run-long-horizon-tasks-with-codex |
| [S0030](../sources/2025-09-20_openai-inhouse-data-agent.md) | blog | 深入了解 OpenAI 的内部数据智能体（Inside OpenAI's in-house data agent） | https://openai.com/index/inside-our-in-house-data-agent/ |
| [S0031](../sources/2025-10-05_google-context-aware-multi-agent.md) | blog | Architecting efficient context-aware multi-agent framework (Google) | https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/ |
| [S0032](../sources/2025-10-15_aws-agentcore-longterm-memory.md) | blog | Building smarter AI agents: AgentCore long-term memory deep dive (AWS) | https://aws.amazon.com/blogs/machine-learning/building-smarter-ai-agents-agentcore-long-term-memory-deep-dive/ |
| [S0033](../sources/2025-10-20_aws-agentcore-episodic-memory.md) | blog | Build agents to learn from experiences using Amazon Bedrock AgentCore episodic memory | https://aws.amazon.com/blogs/machine-learning/build-agents-to-learn-from-experiences-using-amazon-bedrock-agentcore-episodic-memory/ |
| [S0034](../sources/2025-06-10_microsoft-plugmem.md) | blog | PlugMem: From raw interaction to reusable knowledge | https://www.microsoft.com/en-us/research/blog/from-raw-interaction-to-reusable-knowledge-rethinking-memory-for-ai-agents/ |
| [S0035](../sources/2025-07-15_microsoft-corpgen.md) | blog | CORPGEN advances AI agents for real work | https://www.microsoft.com/en-us/research/blog/corpgen-advances-ai-agents-for-real-work/ |
| [S0036](../sources/2025-08-20_microsoft-memento.md) | blog | Memento: Teaching LLMs to Manage Their Own Context | https://www.microsoft.com/en-us/research/articles/memento-teaching-llms-to-manage-their-own-context/ |
| [S0037](../sources/2026-02-01_arxiv-memoryarena.md) | paper | MemoryArena | https://arxiv.org/html/2602.16313v1 |
| [S0038](../sources/2026-04-16_openreview-agentmemorybench.md) | paper | Benchmarking Continual Agent Memory for Online Learning, Transfer, and Forgetting (AgentMemoryBench) | https://openreview.net/forum?id=MSXbrNExax |
| [S0039](../sources/2026-04-16_openreview-memagents-iclr.md) | paper | ICLR 2026 Workshop on Memory for LLM-Based Agentic Systems (MemAgents) | https://openreview.net/forum?id=U51WxL382H |
| [S0040](../sources/2026-02-22_arxiv-cmv.md) | paper | CMV (Contextual Memory Virtualisation) | https://arxiv.org/abs/2602.22402 |
| [S0041](../sources/2025-09-15_langchain-context-engineering.md) | blog | LangChain: Context Engineering for Agents | https://blog.langchain.com/context-engineering-for-agents/ |
| [S0042](../sources/2025-10-01_morphllm-context-engineering.md) | blog | MorphLLM: Context Engineering | https://www.morphllm.com/context-engineering |
| [S0043](../sources/2025-05-01_letta-sleep-time-compute-blog.md) | blog | Sleep-time Compute (blog) | https://www.letta.com/blog/sleep-time-compute |
| [S0044](../sources/2025-04-17_arxiv-sleep-time-compute.md) | paper | Sleep-time Compute (论文) | https://arxiv.org/abs/2504.13171 |
| [S0045](../sources/2025-10-01_letta-sleeptime-docs.md) | docs | Sleep-time agents (docs) | https://docs.letta.com/guides/agents/architectures/sleeptime/ |
| [S0046](../sources/2025-12-01_letta-code-memory.md) | docs | Letta Code Memory | https://docs.letta.com/letta-code/memory/ |
| [S0047](../sources/2025-12-01_letta-code-subagents.md) | docs | Letta Code Subagents | https://docs.letta.com/letta-code/subagents/ |
| [S0048](../sources/2026-01-10_openclaw-dreaming.md) | docs | OpenClaw Dreaming Guide (community gist) | https://gist.github.com/sing1ee/fc04334b5870d6dfab53253093ab5126 |
| [S0049](../sources/2026-01-10_openclaw-memory-overview.md) | docs | OpenClaw Memory Concept (github source docs) | https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory.md |
| [S0050](../sources/2026-01-10_openclaw-cli-memory.md) | docs | OpenClaw CLI — ACP commands (openclawlab.com mirror) | https://openclawlab.com/en/docs/cli/acp/ |
| [S0051](../sources/2025-06-01_arxiv-mirror.md) | paper | MIRROR | https://arxiv.org/abs/2506.00430 |
| [S0052](../sources/2026-03-10_arxiv-trajectory-informed-memory.md) | paper | Trajectory-Informed Memory Generation (IBM) | https://arxiv.org/abs/2603.10600 |
| [S0053](../sources/2026-03-24_arxiv-erl-reflective-learning.md) | paper | ERL: Experiential Reflective Learning | https://arxiv.org/abs/2603.24639 |
| [S0159](../sources/2026-05-09_cobanov-how-ai-agent-memory-works.md) | blog | How AI Agent Memory Works (Cobanov interactive essay) | https://memory.cobanov.dev/ |
| [S0167](../sources/2026-05-15_khaos-brain-agent-memory.md) | repo | Khaos Brain: A Brain-Inspired Local Memory System for AI Agents | https://github.com/liuyingxuvka/Khaos-Brain |
