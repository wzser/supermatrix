---
last_updated: 2026-05-15
confidence: medium
refresh_cadence: event-driven
parent: null
children: []
unwritten_children:
  - meta-orchestration: "异步反思扩到多 agent 后的 meta-orchestrator 形态，目前各家都是单 agent 视角，等论文"
boundary_with:
  - memory: "dreaming 的产出写入 memory；memory 综述讲存储/生命周期，本综述讲反思流程"
  - harness: "dreaming 是 harness 调度的异步进程，但作为独立设计抽象单独成文"
---

# Agent Dreaming（Agent 的"做梦"：Sleep-time Compute 与异步反思）

---

## 1. 问题：agent 的反思不能发生在对话里

让 agent 边对话边反思是个糟糕设计，原因两条：
1. **延迟**：用户等你想，响应时间爆炸。
2. **注意力污染**：反思内容挤占当前任务的 context，两者都做不好。

但不反思又会积累问题——记忆条目互相冲突、过时事实未淘汰、失败模式未被总结。传统 agent 系统要么无反思（就是一个 stateless tool caller），要么把反思硬塞进 working context（性能爆炸）。**Agent dreaming** 提出的解法是：**把反思搬到 agent 空闲时段，由独立流程负责**——就像人脑在睡眠中做 memory consolidation。

---

## 2. Sleep-time Compute：Letta 的核心主张

Letta 在 2025 年 5 月正式把这条路线命名为 **sleep-time compute**，并放出论文 + 产品化实现 [S0043] [S0044]。核心架构：

- **Primary agent**：处理用户请求，正常工作时段活跃。
- **Sleep-time agent**：独立进程，在 primary agent 空闲时启动，翻阅最近 N 步的 memory blocks，做合并、去重、冲突解析、meta-insight 提取。
- **共享 memory blocks**：两个 agent 读写同一套 memory；sleep-time agent 的修改对 primary agent 下次启动可见 [S0045]。
- **触发条件**：按 N 步或按时间窗触发，不阻塞用户路径。

论文实验给出一个有力数字：**test-time compute 降至约 1/5**——意思是，如果你把一部分"当下该想清楚"的事推到 idle 时段预处理，用户请求到来时 primary agent 做的思考量大幅下降，整体更省钱 [S0044]。其中 agentic SWE case study 显示任务完成率同步提升。

Letta Code 产品化了这个想法，内置了 "dream subagent"：周期性运行，反思最近的对话和操作 [S0046]。它把 reflection 作为一种**内建 subagent 类型**，和其他 subagent 一样可被调度 [S0047]。

---

## 3. OpenClaw：三段式 dreaming

OpenClaw 的 dreaming 把一次 sweep 切成按**固定顺序**跑的三阶段：**Light → REM → Deep** [S0048]。分工的意图不在于"深度 ≈ compute"，而在于**角色隔离**——前两阶段只收集信号与主题，Deep 才真正写入长期记忆。

- **Light Sleep（Sort & Stage）**：读最近几天的 daily memory + session transcripts，切片、Jaccard 去重（阈值 0.9），进短期 recall store，并记录 "light 信号" 供后续打分加成。**不写 MEMORY.md** [S0048]。
- **REM Sleep（Reflect & Extract Patterns）**：在短期 recall 窗口（默认 7 天）内按 concept tag 频次抽取反复出现的主题，标记 "candidate truths"，并记录 "REM 信号" 作为加成。**也不写 MEMORY.md** [S0048]。
- **Deep Sleep（Promote to Long-Term Memory）**：**唯一会 append 到 MEMORY.md 的阶段**。把每个候选按六信号加权打分（Relevance 0.30 / Frequency 0.24 / Query diversity 0.15 / Recency 0.15 / Consolidation 0.10 / Conceptual richness 0.06），叠加 light + REM 信号的 recency-decayed boost，再用三道闸门过：`minScore ≥ 0.8` / `minRecallCount ≥ 3` / `minUniqueQueries ≥ 3`——分够 + 被取用次数够 + 查询场景够多样，才晋升 [S0048]。

产出分机器态和人可读两条线：机器态在 `memory/.dreams/`（`short-term-recall.json` / `phase-signals.json` / `events.jsonl` 等），长期结果写进 `MEMORY.md`，Dream Diary 写进 `DREAMS.md`（每次 sweep 追加 `## Light Sleep` / `## REM Sleep` / `## Deep Sleep` 段）[S0048] [S0049]。这是一个关键设计：把 agent 的"潜意识"变成**可外部监督的文本**，避免把反思关进不可见的向量库。运维上 dreaming 本体有 `openclaw memory promote` / `memory promote --apply` / `memory promote-explain <query>` / `memory rem-harness` 等预览回放手段 [S0048]，memory 层另有 `openclaw memory status / search / index / rem-backfill`（`--stage-short-term` 入暂存、`--rollback` 回滚）[S0049]，gateway / ACP 会话层还有 `openclaw acp` 命令组 [S0050]——dreaming 是需要被运维的系统，不是自动生效的黑箱。

---

## 4. Khaos Brain：面向 Codex 的脑节律实现

Khaos Brain（MIT 开源，2026-04-19，Codex-first）把 sleep-time compute 做成一套本机可安装的自动化管线 [S0167]：

- **KB Sleep**：合并重复 experience card、拆分臃肿卡片、修正低置信度经验——对应 Letta 的 sleep consolidation 和 OpenClaw 的 Light→Deep 晋升。
- **KB Dream**：在未充分验证的相邻区域做有边界的探索——接近 OpenClaw REM 的主题候选发现，但更侧重"扩展"而非"提炼"。
- **KB Architect**：定期审阅安装器、自动化、rollback 机制、proposal 队列——相当于把 dreaming 对象从 memory content 扩展到 dreaming 基础设施本身（自省层）。

三个流程由 Codex automations（`AGENTS.md` rules + scheduled runs）触发，产出写回文件型 KB。与 Letta/OpenClaw 的关键差异：**存储单元是 Git-版本化的 experience card（文件），而不是追加型日志**——支持 diff / revert / 人工审查，且卡片格式明确记录"在什么条件下 / 什么动作 / 什么结果"，比 DREAMS.md 的 markdown 摘要更结构化。

---

## 5. MIRROR：模型内生的 Talker/Thinker 分工

从另一个方向攻同一个问题的是 MIRROR（arxiv 2506.00430）[S0051]。它不在架构上分 primary/sleep-time 两个 agent，而是在**模型内部**让一个实例同时承担两种角色：

- **Talker**：处理即时对话、低延迟响应。
- **Thinker**：在背景做异步 deliberation，不阻塞 Talker。

两者通过消息/memory 交换。这条路线的赌注是：如果**模型本身**能学会异步思考，那么 harness 层就不需要显式调度 dreaming 进程——模型自己知道什么时候该"走神"。

当前效果有限，但方向重要。它和 Microsoft 的 Memento [S0036, 见 memory 综述] 同属"模型内生 context 管理"家族，长期可能和 sleep-time 架构形成互补。

---

## 6. Karpathy autoresearch：dreaming 的极端形态

Andrej Karpathy 在 2026 年 4 月放出的 autoresearch 项目 [S0054] 提供了一个更激进的 dreaming 形态：**agent 自动跑优化回路**——改代码、训练、测指标、保留或丢弃，周而复始。

这不是严格意义上的"反思"，但在本质上和 dreaming 共享同一个假设：**agent 有大段 idle compute 可用**，与其浪费不如让 agent 用自己的执行痕迹作为原料，自主改进。autoresearch 是"execution-level dreaming"，Letta 是 "memory-level dreaming"，OpenClaw 三阶段（尤其 REM 的主题抽取 + Deep 的阈值晋升）是 "consolidation-level dreaming"——三者共同指向：**agent 的进步不必等人类的下一次对话触发**。

---

## 7. 设计原则：dreaming 要满足什么

跨多份源的共识，一个 dreaming 子系统应当：

1. **异步、不阻塞用户路径** [S0043] [S0044]。若与 working context 耦合即失去意义。
2. **可审查** [S0048]。DREAMS.md 式的人类可读文本是底线；黑箱 embedding 不可接受。
3. **可运维** [S0049] [S0050]。反思会积累失败、偏差、冲突，必须有 rollback / backfill / promote 这些人工干预手段（OpenClaw 的 `memory rem-backfill --rollback` 是可参考的具体形态）。
4. **分阶段、各有职责** [S0048]。不是所有反思都做同一件事——Light 负责 ingest/dedupe，REM 负责主题抽取，Deep 负责打分晋升。分阶段的意义在于"先多收集、后严格晋升"，以及打分与写入解耦。
5. **共享 memory but 隔离 compute** [S0045]。primary agent 和 dreaming 进程读写同一 memory，但各自 context 独立——避免互相污染。
6. **按信号触发而非固定周期**。Letta 的"N 步触发"比"每 10 分钟一次"更稳——因为价值密度随使用量变化，不按钟走。

---

## 8. 风险

- **Memory poisoning 放大器**：dreaming 会**强化**某些 memory 条目（promote 到长期库），如果被恶意种子污染，dreaming 会把污染传播、放大。[S0027] 把这列为 agentic security 重点风险。缓解：DREAMS.md 人工审查 [S0048] + 客户端掌控的 memory storage（Anthropic Memory tool 式，`/memories` 放在用户自己的基础设施上，用户层可做 snapshot / rollback）[S0025, 见 memory 综述]。
- **过拟合到近期失败**：若 dreaming 频繁复盘最近错误，agent 会变得对"曾经犯过的错"过度敏感，行为僵化。需要配合 forgetting 机制 [S0028]。
- **Compute 成本失控**：REM 级 dreaming 单次可能非常贵，必须有预算闸门。OpenClaw 的 memory CLI（staging、rollback、索引重建）[S0049] 与 gateway/ACP CLI [S0050] 都是针对这类运维问题的形态。
- **反思内容"幻觉"**：sleep-time agent 同样是 LLM，它对 memory 的"总结"可能凭空捏造。需要 source attribution + 抽样对照原始 memory。

---

## 9. 待解问题

- **Dreaming 触发的黄金时机**：按步数 / 按时间 / 按事件三种策略尚无公开对比数据。
- **跨 agent dreaming**：多 agent 系统里，单个 agent 的 dreaming 是否应该影响其他 agent 的 memory？目前都是单 agent 视角。
- **Dreaming 产出的评估**：如何判断一次 dreaming "有价值"？当前除了 test-time compute 降低 [S0044]，还没有直接指标。
- **人机协同的审查界面**：DREAMS.md 在规模上有上限，需要 diff / 高亮 / 分类筛选的 UI 层，目前各家都是 raw markdown。
- **Dreaming 与 harness 控制权**：dreaming 会自主修改 memory，这和"harness 是控制面"的原则 [见 concepts/harness.md §3] 有张力——dreaming 能不能 override harness policy？尚无明确答案。

---

## 相关综述

- [concepts/memory.md](memory.md)：memory 是 dreaming 的原料与产出场所，两者深度耦合。
- [concepts/harness.md](harness.md)：dreaming 作为 harness 调度的异步进程，是 harness 的组成部分而非外挂。

---

## 参考来源

本综述引用的所有 source，标识符 + 标题 + 内容类型 + 原始链接。点击 ID 可回到 `kb/sources/<file>.md` 读原文。

| ID | 类型 | 标题 | 链接 |
|----|------|------|------|
| [S0027](../sources/2025-03-14_nist-rfi-agentic-security.md) | paper | NIST RFI on Agentic Security | https://www-cdn.anthropic.com/43ec7e770925deabc3f0bc1dbf0133769fd03812.pdf |
| [S0028](../sources/2025-10-10_openai-context-personalization.md) | docs | Context Engineering for Personalization - Long-Term Memory Notes (Cookbook) | https://developers.openai.com/cookbook/examples/agents_sdk/context_personalization |
| [S0043](../sources/2025-05-01_letta-sleep-time-compute-blog.md) | blog | Sleep-time Compute (blog) | https://www.letta.com/blog/sleep-time-compute |
| [S0044](../sources/2025-04-17_arxiv-sleep-time-compute.md) | paper | Sleep-time Compute (论文) | https://arxiv.org/abs/2504.13171 |
| [S0045](../sources/2025-10-01_letta-sleeptime-docs.md) | docs | Sleep-time agents (docs) | https://docs.letta.com/guides/agents/architectures/sleeptime/ |
| [S0046](../sources/2025-12-01_letta-code-memory.md) | docs | Letta Code Memory | https://docs.letta.com/letta-code/memory/ |
| [S0047](../sources/2025-12-01_letta-code-subagents.md) | docs | Letta Code Subagents | https://docs.letta.com/letta-code/subagents/ |
| [S0048](../sources/2026-01-10_openclaw-dreaming.md) | docs | OpenClaw Dreaming Guide (community gist) | https://gist.github.com/sing1ee/fc04334b5870d6dfab53253093ab5126 |
| [S0049](../sources/2026-01-10_openclaw-memory-overview.md) | docs | OpenClaw Memory Concept (github source docs) | https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory.md |
| [S0050](../sources/2026-01-10_openclaw-cli-memory.md) | docs | OpenClaw CLI — ACP commands (openclawlab.com mirror) | https://openclawlab.com/en/docs/cli/acp/ |
| [S0051](../sources/2025-06-01_arxiv-mirror.md) | paper | MIRROR | https://arxiv.org/abs/2506.00430 |
| [S0054](../sources/2026-04-16_karpathy-autoresearch.md) | repo | Karpathy autoresearch | https://github.com/karpathy/autoresearch |
| [S0167](../sources/2026-05-15_khaos-brain-agent-memory.md) | repo | Khaos Brain: A Brain-Inspired Local Memory System for AI Agents | https://github.com/liuyingxuvka/Khaos-Brain |
