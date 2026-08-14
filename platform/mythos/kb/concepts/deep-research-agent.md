---
last_updated: 2026-05-05
confidence: medium
refresh_cadence: event-driven
parent: null
children: []
unwritten_children:
  - source-scoring: "domain-specific source priors（开源项目 / 论文 / 政策 / 公司信息 / 新闻）尚未单独成文，仅在 S0092 一段落覆盖；积累更多 source 后可独立"
  - stop-policy: "5 类停止条件（覆盖率 / 边际收益 / 置信度 / query frontier / 预算）目前只有 S0092 单源，待第二源验证再独立"
  - evidence-grounded-rag: "claim+evidence+source 三元组的存储与召回模式，离单成 concept 还差具体工程实现 source"
boundary_with:
  - multi-agent-orchestration: "deep research 用 Planner/Searcher/Reader/Verifier/Curator 多角色，但分工的轴是『信息寻取』而非通用 agent 编排；通用 topology / durable execution 走 multi-agent-orchestration"
  - harness: "deep research agent 运行在 harness 之内，本综述聚焦『搜索 loop 怎么收敛』，不讲 harness 状态机 / context 管理"
  - memory: "证据图（research graph）是 in-flight 的会话状态，不是跨 session 的 memory；持久化层走 memory 综述"
---

# Deep Research Agent（深度搜索 Agent / Agentic Search / Evidence-grounded RAG）

---

## 1. 这是什么，和普通 RAG 的边界在哪

普通 RAG 的范式是 **embed → top-k 检索 → 拼进 prompt → 生成**。深度搜索 agent 攻的是另一个问题：当一次检索拿不到完整答案、相关信息散落在多个网页、且不同来源还可能互相矛盾时，agent 需要**多轮自主搜索 + 评估 + 决定下一步搜什么 + 知道什么时候停**。Deep Research Agent / Agentic Search / Evidence-grounded RAG 三个术语指向同一类系统 [S0092]。

S0092 给出的关键定义性主张是：**核心不是"多搜几次"，而是让 agent 在每轮搜索后维护一个可更新的证据状态——当前已经知道什么、哪些 claim 有证据、哪些 claim 仍然不确定、哪些来源互相矛盾、下一轮搜索的预期收益是否还值得成本**。这条主张直接决定了下文的架构选型、停止条件和 MVP 顺序。

和母 KB 里其它 concept 的边界（见 frontmatter `boundary_with`）：deep research 复用 multi-agent-orchestration 的角色拆分原语和 harness 的运行底座，但它的独立性来自"信息寻取"这条主轴——选 topology、做容错、管 context 不是它要回答的问题，决定下一轮搜什么、停不停、信不信才是。

---

## 2. 开源项目地形：从 500 行 demo 到企业 RAG 平台

S0092 列出的 10 条参考形成一个由简到繁的光谱 [S0092]：

**最小可用 loop**：dzhng/deep-research 把整个流程压在 500 行以内，用 breadth + depth 两个旋钮——根据目标先生成多条 SERP query（breadth），处理结果得到 learnings 和 next directions，深度未到就把方向作为上下文递归（depth）。这是理解 deep research loop 心智模型的入口，但缺 source scoring、claim verification、stop policy。

**生产级骨架**：LangChain 的 open_deep_research 提供两类实现并存——一种是 plan-and-execute workflow，带人工确认、逐节写作和反思；另一种是 supervisor-researcher 多 agent 架构，多个 researcher 并行。这个项目的工程价值在于和 Deep Research Bench 评测打通，可以直接用 RACE/FACT 衡量改动是否有效。GPT Researcher 走更经典的 planner + execution agents + publisher 三段，强项是 source tracking 和 report aggregation——适合"自动帮知识库补充资料"这条产品线。

**视角覆盖路线**：Stanford OVAL 的 STORM / Co-STORM 不在"换 query"上做文章，而是先发现不同视角，再模拟"Wikipedia writer"和"topic expert"的对话，用对话轮次驱动追问。Co-STORM 进一步引入多个 LLM experts + moderator 处理 open-ended research——用户不知道自己不知道什么的场景。这条路线对"搜索质量靠视角覆盖而非 query 重写"的工程直觉给出了具体落地方法。

**研究图路线**：MindSearch 把复杂搜索建模成动态图——WebPlanner 把问题拆成 atomic sub-questions 作为节点，WebSearcher 对每个节点做分层检索（先粗后细：多个相似 query 提召回 → 聚合 → 模型挑高价值页面深读），Planner 根据反馈继续扩展图。它给"如何让每轮越搜越好"的回答是：用 DAG / research graph 表示问题分解和依赖关系，每轮只扩展当前最不确定、收益最高的节点。

**显式角色分工**：ManuSearch 把搜索推理拆成 solution planning agent / Internet search agent / structured webpage reading agent 三个 agent 并提出 ORION benchmark 关注 open-web reasoning 和 long-tail entities——"互联网上找难找的信息"这种场景。

**研究方向集**：阿里 Tongyi DeepResearch 是一整套 family（WebWalker、WebDancer、WebSailor、WebResearcher、ReSum、WebWeaver、BrowseConf、ParallelMuse 等），偏研究但对"搜到什么程度停止"的分支最丰富——ReSum 处理长过程上下文压缩，WebWeaver 把 web-scale evidence 组织成动态 outline，BrowseConf 根据 confidence 分配搜索预算。

**端到端 reasoning + tool use**：WebThinker 让 large reasoning model 在思考过程中自主搜索、浏览、写报告，不写死 RAG pipeline；代价是工程可控性差。

**企业 RAG 平台**：Onyx 走另一极——50+ connectors、hybrid search、access control、agentic RAG，把 deep research 嵌进企业知识库产品形态。

**工具层**：deep search agent 至少需要三层工具——search（SearXNG 自托管 metasearch / Brave / Serper）、crawl（Firecrawl 输出 markdown/JSON/screenshot 面向 AI agent）、extract（Crawl4AI 把网页转 LLM-ready markdown）。

---

## 3. 研究思路：六条值得看的范式

S0092 列出六条研究层面的关键思路 [S0092]：

**Karpathy AutoResearch 的 ratchet loop** 不是 web research 项目，但思想可直接迁移。原 repo 描述 agent 修改训练代码、训练 5 分钟、检查指标是否变好、保留或丢弃，重复。迁到 deep search 就是：每轮搜索必须能被评估——计算 coverage gain / evidence quality gain / confidence gain / contradiction reduction / citation accuracy / novelty gain，类似"validation loss"，分数没改进就丢弃方向。这条 ratchet 思路在 [agent-dreaming §5](agent-dreaming.md) 里也作为"execution-level dreaming"出现过——同一个核心假设（agent 有大段 idle compute、用执行痕迹自主改进）在两个综述里指向不同应用面。

**OpenAI Deep Research / BrowseComp** 的定义把"deep research"绑死在 agentic capability 上——能在互联网上做 multi-step research，搜索、解释、分析大量文本/图片/PDF，并根据信息 pivot。BrowseComp benchmark（1266 个问题）衡量的是找 hard-to-find / entangled information 的能力——做得好需要 persistence、depth of browsing、creative search，而不是简单搜索关键词。这条 benchmark 直接告诉你系统不应该只优化 top-k retrieval accuracy。

**ReAct** 是现代 agent loop 的基础范式：reasoning trace 帮模型维护和更新 action plan，action 帮模型从外部来源获取信息，observation 反过来更新 reasoning。但 S0092 给出关键警告：**裸 ReAct 很容易陷入无效循环**，所以必须配 evaluator 和 stop policy——这是后文停止条件章节的来由。

**IRCoT** 的核心是 interleave retrieval with chain-of-thought：多步 QA 里"下一步检索什么"取决于前面已经推理出什么、检索到了什么。直接对应"如何让每一轮找到的质量越来越高"——不要一次性生成所有 query，每轮 query 来自上一轮 evidence graph 的缺口。

**Self-RAG / CRAG / FLARE** 三者合起来给出 adaptive retrieval 的工程策略：Self-RAG 学习什么时候需要检索 + 对 retrieved passages 和自己生成做反思；CRAG 用轻量 retrieval evaluator 评估检索文档质量并按 confidence 触发不同检索动作（静态语料不够还可用 web search 扩展）；FLARE 在生成中预测下一句，低置信度就把预测内容变 query 检索再重生成。S0092 把三者归并为：每个 claim 带 confidence；confidence 低 → 继续检索；evidence 质量低 → 换 query / 换 source；claim 之间冲突 → 搜 counter-evidence；confidence 高且新搜索边际收益低 → 停。

**DeepResearch Bench**（100 个 PhD-level research tasks，22 个领域）提出 RACE 和 FACT 两个评估框架——RACE 看报告质量（完整 / 深入 / 可读 / 符合任务），FACT 看引用是否有效、证据是否真的支撑 claim、来源是否可信。S0092 据此主张：知识库自动入库流程也应该分这两类评分。

---

## 4. 推荐架构：六角色 + 一个进入门、一个出口门

S0092 推荐的拆分是 7 段流水线：Intent Clarifier → Research Planner → Searcher → Reader/Extractor → Evidence Verifier → Knowledge Curator → Report/KB Writer [S0092]。核心拆分逻辑不是"多 agent 显得专业"，而是**每个角色的失败模式不同**，混在一个 agent 里时无法独立调试。

**Research Planner** 的输出不应该只是 query 列表，而是结构化 research graph——每个 subquestion 带 priority / status / search intent / preferred source types / freshness requirement / verification requirement / stop criteria。这一步决定了后续所有搜索是"逐个缺口进攻"还是"一锅炖"。

**Searcher** 必须生成多种 query 而不是单个：broad / targeted / primary source / counter-evidence / recent / site-specific / filetype / citation-chasing。S0092 给的硬规则是每个 subquestion 至少生成三类——discovery（找新方向、新实体、新术语）、verification（找权威来源确认）、adversarial（找反例、争议、否定证据）。**没有 adversarial query 的 deep research 会只收集支持性证据**——这是默认会犯的错误。

**Reader / Extractor** 不要把整篇网页塞进上下文，要抽结构化 evidence——source_url / source_type / published_at / claims（每条 claim 带 supporting_text + confidence）/ entities / next_leads。

**Evidence Verifier** 是关键，独立于 searcher 存在。它对每条证据回答 7 个问题：relevance（是否真的回答当前 subquestion）/ support（原文是否支持 claim）/ authority（primary source 还是二手转述）/ freshness / independence（多源是否独立）/ conflict / citation accuracy。建议用 NLI 或 LLM judge 做三分类：supports / contradicts / not enough information。

**Knowledge Curator** 不是所有搜索结果都入库——要过 source_score / claim_support_score / duplicate_score / citation_available 四道门槛，且**入库对象是 claim + evidence + source metadata 三元组，不是网页**。

整套设计的反命题在 [multi-agent-orchestration §1](multi-agent-orchestration.md)：Google Research 的 180 次实验提醒"拆 agent 不是默认选择"。Deep research 之所以适合拆，因为它的子任务（搜索 / 阅读 / 验证）有清晰的契约边界和不同的失败模式，不是为了拆而拆。

---

## 5. 停止条件：从"搜 N 轮就停"到多条件 stop policy

S0092 给出的核心反模式是**单一 depth 阈值**——"搜 3 轮就停"既容易过早收敛（高优先级 subquestion 还没覆盖）又容易过度烧 token（低收益方向还在打）。正确做法是 5 类条件并行 [S0092]：

**覆盖率足够**：每个高优先级 subquestion 至少 ≥ 2 个独立来源 + ≥ 1 个 primary/official/paper（如果该领域存在）+ 核心 claim 都有 citation。`coverage_score = answered_weight / total_weight`，达到 0.85 进入收敛判断。

**边际收益下降**（Karpathy ratchet 的搜索版）：每轮算 `marginal_gain = new_supported_claims + new_high_quality_sources + contradiction_resolved + confidence_gain - duplicate_penalty`。**连续 2 轮 marginal_gain < epsilon 就停**——没有质量增益就不要继续烧 token 和搜索成本。

**核心 claim 置信度足够**：每个核心 claim 维护 support_score / contradiction_score / source_quality_score / citation_score。停止条件 `support_score ≥ 0.8 ∧ contradiction_score ≤ 0.2 ∧ source_quality_score ≥ 0.7`。**contradiction 高时不是继续盲搜，而是进入 conflict resolution**——为什么冲突？时间不同？定义不同？来源等级不同？一方旧信息？

**Query frontier 枯竭**：Planner 每轮维护带 expected_value 的 query frontier，所有 query 的 EVI 低于成本阈值就停。S0092 给出 EVI 公式：`EVI(q) = P(find_useful_evidence | q, history) × impact_on_unresolved_questions × source_quality_prior - cost(q)`。工程上一开始不需要训练模型，先 rule-based：+0.3 指向 primary source、+0.2 针对未回答高优先级问题、+0.2 是 counter-evidence search、-0.3 过去相似 query 没找到新来源、-0.4 SERP 高度重复。

**预算上限**（max_iterations / max_search_queries / max_pages_read / max_tokens / max_cost / max_wall_time）。但 S0092 强调这是 guardrail，不是主要停止逻辑——主要逻辑应该来自上面 4 条质量信号。

---

## 6. 让每一轮越搜越好的六条工程动作

S0092 列出的具体动作 [S0092]：

**从 keyword search 变 research graph search**：不维护线性 history，维护 Question → Subquestion → Query → Source → Evidence → Claim → Support/Contradiction 这样的图。下一轮搜索只围绕图的缺口生成——open subquestions / unsupported claims / contradictions / low-quality sources / missing primary sources / outdated evidence。

**每轮分三类 query**：discovery / verification / adversarial 各至少一条。

**Source scoring 显式化**：`source_score = 0.25 × authority + 0.20 × relevance + 0.15 × freshness + 0.15 × primary_source + 0.10 × independence + 0.10 × citation_density + 0.05 × accessibility - contradiction_penalty - spam_penalty`。不同领域有不同 source prior——开源项目优先 GitHub + 官方 docs + release notes；论文方法优先 arXiv / ACL Anthology / OpenReview / project page；法规政策优先政府官网；公司信息优先 SEC filing / annual report；新闻事实优先原始公告 + Reuters/AP/Bloomberg；技术实现优先官方文档 + 源码 + issue + benchmark repo。

**用 reranker，不只靠搜索引擎排序**：流水线是 SERP top 20-50 → 去重 → 抓 snippet → cross-encoder 或 LLM rerank（输出结构化理由：relevance/authority/expected_evidence/read_depth）→ 选 5-10 深读。

**两阶段阅读**：Stage 1 SERP snippet + title + metadata → Stage 2 shallow fetch / markdown extraction → Stage 3 deep crawl 选定页面 → Stage 4 citation-level evidence extraction。先 skim 后 deep read，既省成本又便于质量控制。

**结构化 reflection**：不要问模型"还需要搜什么"这种开放问题，问 7 个具体问题——哪些 subquestion 仍 open / 哪些 claim 没 citation / 哪些 citation 弱支持 / 哪些来源可能过时 / 是否有矛盾证据 / 下一轮最多 5 个 query 各解决哪个缺口 / 找不到新证据是否应停。

---

## 7. MVP 落地顺序

S0092 给的五阶段路径 [S0092]：

Phase 1 复刻最小 deep research loop（参考 dzhng/deep-research：input topic → 4-8 queries → search → crawl top → extract learnings → next directions → 递归 depth 2-3 → cited report）。

Phase 2 加 evidence store——存 claim / evidence_text / source_url / source_type / retrieved_at / supports_subquestion / quality_score 三元组而不是 chunk。

Phase 3 加 stop policy（rule-based）：`coverage_score ≥ 0.85 ∧ avg_core_claim_confidence ≥ 0.80 ∧ citation_accuracy_estimate ≥ 0.85 ∧ marginal_gain_last_2 < 0.05`。预算上限作 guardrail：max_iterations 5 / max_queries 30 / max_pages 80。

Phase 4 加 verifier agent，独立于 searcher——Searcher 找 / Reader 抽 / Verifier 质疑 / Curator 入库。Verifier 输出 `{claim, verdict: supported|contradicted|insufficient, confidence, reason, required_next_search}`。

Phase 5 接 benchmark：BrowseComp（hard-to-find 信息）/ GAIA（工具使用 + 浏览 + 多模态）/ FRAMES（RAG factuality + retrieval + multi-hop）/ DeepResearch Bench（长报告 + 引用准确）。

S0092 的优先阅读顺序也对应这条路径：dzhng → LangChain open_deep_research → GPT Researcher → STORM → MindSearch → ManuSearch → Self-RAG/CRAG/FLARE → DeepResearch Bench/BrowseComp。

---

## 8. 八条核心设计原则

S0092 总结的"可直接采用"原则 [S0092]：

```
1. 不做"搜索 N 轮"，做"直到信息增益不足为止"。
2. 不存网页，存 claim + evidence + source。
3. 不只找支持证据，主动找反证。
4. 不只看 relevance，同时看 authority、freshness、independence、citation accuracy。
5. 不让一个 agent 包办所有事，至少拆 Planner / Searcher / Reader / Verifier / Curator。
6. 不依赖一次 query，使用 research graph 逐步扩展。
7. 不相信 LLM 自评，重要 claim 必须能回到原文引用。
8. 不只用向量相似度，必须加 reranker 和 source scoring。
9. Searcher 角色可以是专用子模型而非通用 LLM——边界足够清晰、工具集足够稳定时，专用 + pipeline-first 比 frontier LLM + sub-agent 方式延迟更低、成本更小 [S0110]。
```

S0092 给出的最终组合是：**STORM 多视角问题生成 + MindSearch 动态图搜索 + ManuSearch agent 分工 + CRAG/Self-RAG 检索质量评估 + Karpathy ratchet loop + DeepResearch Bench RACE/FACT 指标**——这个组合明显比"普通 RAG + web search tool"强。

---

## 9. 待解问题与单源风险

本综述目前的证据基础是单源（S0092 一篇），所以有几条需要明确标记的开放问题：

- **S0092 列出的 10 个开源项目和 6 条研究思路全部需要二次验证**——它们的具体设计声明（如 ManuSearch 的三 agent 拆分、MindSearch 的 coarse-to-fine、BrowseComp 的 1266 题、DeepResearch Bench 的 100 题/22 领域）应该回原 repo / 原 paper 复核。
- **EVI 公式和各权重（0.25 authority / 0.20 relevance / ...）属于工程直觉**，不是从论文实证拿到的硬数字；产品里要根据自己的 benchmark 调。
- **"五类停止条件并行"在生产里是否会发生互斥**（比如 coverage 已够但边际收益还高）目前没有公开数据。
- **adversarial query 应该占多大比例**才能不让 deep research 偏向只收集支持证据，S0092 给的是"每个 subquestion 至少一条"，但更细的 budget split 缺乏证据。
- **research graph vs 线性 history 的成本对比**——graph 维护本身有 overhead，多大的问题规模才划算？S0092 没量化。

下一批进来的 source（直接拆 dzhng/deep-research / open_deep_research / STORM / MindSearch / ManuSearch repo + 对应 paper）会让本综述从 single-source low confidence 升到 multi-source medium。届时本节会迁移到具体的"争议"段。

---

## 10. 产品化实证：专用子模型替代通用 LLM 做 Searcher

S0092 的架构推荐中，Searcher 被假定为 frontier LLM 在 agent loop 里调用工具的一环。Glean 的 Waldo [S0110] 提供了第一个已公开的规模级产品实例：**专用小模型胜过通用大模型担任 Searcher 角色**，前提是角色边界足够清晰、工具集足够稳定。

Waldo 的核心设计决策是 **pipeline-first**（先于 frontier LLM 运行，而非被其 call 的 subagent）。这消除了串行 inference 延迟——原先一个简单 query 需要 frontier LLM 三次调用（plan / search / synthesize），现在 Waldo 完成 search orchestration 之后只需一次 frontier LLM 综合。工程代价是工具集固定（Glean Search / employee search / web search），无法随意扩展。

模型选型反映角色定位：NVIDIA Nemotron 3 Nano 为底座，30B 总参数 / 3B active MoE，刻意回避 reasoning 架构以压低 latency（250ms vs 通用 frontier LLM ~3s）。这是"任务专精 > 通用能力"原则在工具 agent 上的落地——Waldo 不需要写代码、不需要回答问题，只需要决定调什么工具、按什么顺序、什么时候停。

训练走两阶段：Phase 1 DPO 从匿名生产 trace 学 tool-use 偏好（trace 只记工具调用顺序，不含文档内容，数据隐私友好）；Phase 2 RL 以 recall/F1 为奖励信号（搜出来的文档是否出现在最终回应的引用里），把模型拔高到生产行为以上。

实测结果：end-to-end latency 降 50%，token 用量减 25%，约一半 query 在 Waldo 阶段完成（fast path，不需要 frontier LLM 全量推理）。Waldo 同时承担动态 routing——根据自己的执行信号（tool call 数量 / document 检索量 / content sparsity）决定将 query 送往轻量推理还是深度推理路径。

与 S0092 架构的对应关系：Waldo 对应 §4 六角色里的 Research Planner + Searcher 合并（query decomposition + tool selection + evidence sufficiency determination），Reader / Verifier / Curator 仍交给 frontier LLM。S0092 里"每个角色失败模式不同所以要拆"的理由在这里以"专用模型 = 硬编码 single-role"的形式落地——Waldo 失败只可能是 search orchestration 失败，frontier LLM 失败只可能是 synthesis 失败，两者独立可调试。

**设计启示**：对于边界清晰的 search orchestration，pipeline-first 专用小模型是一条可验证的工程路径。决策框架：若工具集稳定（≤5 种工具）且角色只含 decompose/select/route 三项能力，则用专用子模型；若工具集动态或需要跨域 reasoning，则维持 frontier LLM + tool-calling。

---

## 11. 浏览器交互层的工程化：从自家造 harness 到公共 skill 目录

S0092 / S0110 处理的是 Searcher / Verifier 这类**认知角色**的工程化（哪个角色用什么模型 / 怎么训）；它们之下还有一层「**怎么操纵浏览器**」一直被视为各家私造 harness。Browserbase 在 2026-05 发布的 `browse` CLI [S0179] 把这层往「公共可复用」推了一步。

**它做了什么**。`browse` 是一个 npm CLI，封装四块能力到同一个命令栈：(1) **Web skill** —— 每个网站可被注册为命名 skill（`browse skills add 1688.com`），skill 里预先抓好该网站的 DOM selector + XHR 请求路径，agent 调用时直接复用，按 Browserbase 自己的数据这能把 token 成本压到原始浏览器自由探索的 **1/50**（"cut token costs by 50x"）；(2) **Browser primitives** —— click / scroll / type / hover / press / screenshot，元素可按 selector 或 agent 自身的 a11y ref 寻址；(3) **Debugging** —— `browse network --tail` / `browse console --tail` 让 agent 和人都能看到页面真实行为（XHR 状态、警告、未捕获异常）；(4) **Cloud** —— 任意命令前加 `cloud` 即切到 Browserbase 远端 Chromium session，含 Search/Fetch API。

**对 deep research agent 架构的两条结构影响**。第一，把 §6 第 1 条「让每一轮越搜越好」中的「query 改写 / 重新规划」这一层之下的「**实际去抓**」从「LLM 自带 web tool 临场探索」拆成「目录里已有的 skill → 命令式调用」。这把 Searcher 角色的实现层分成两段：**编排层**（LLM 决定调哪个 skill / 按什么顺序，对应 §10 Waldo 那一层）+ **执行层**（公共 skill 目录，对应 browse.sh 这一层）。后者一旦被规模化，§4 推荐架构里"Searcher 调浏览器"的延迟和成本曲线会被整体压低。第二，open web catalog 让"哪些网站值得抓"成为一项**社区可贡献的工件**——browse.sh 当前已收录的 skill（12306.cn 列车 / 1688.com 批发 / Airbnb 房源 / agentpowers.ai skill 检索 / Ramp 报销 / alltrails 户外路线 / weather.gov 等）覆盖了 government / healthcare / retail / browser 四个 vertical，是 deep research agent 在企业落地时「白名单可信源」的天然原料库。

**与已有形态的对照**。Glean Waldo 是「专用 search orchestration 模型」的产品化实证（§10）；browse.sh 是「**浏览器层的开放 SKILL 目录**」的工程化实证。Waldo 解决的是"哪几次调用、按什么顺序、什么时候停"；browse.sh 解决的是"一次调用如何在 token 预算内拿到结构化结果"。两者在堆栈上不冲突——Waldo 类专用模型只要 tool surface 稳定就能受益，而 browse.sh 这种 skill 目录恰好把 tool surface 标准化。同源信号见 §6 第 1 条与 [[harness §5]] 关于 tool design 对 context rot 的反馈。

**与 MCP / a2a 的关系**。browse.sh 当前是 CLI 而非 MCP server，但它对 agent 的接口形态是同构的——把"浏览器内的复杂操作"抽象为命名 skill + 命令式调用。结合 [[harness §5]] §5 谈到的"agent 操作纪律作为 cross-platform SKILL"母题，以及 MAP "尚未成文的概念" 列的 *Tool design as context*，browse.sh 是 browser 这一具体 vertical 上「skill 作为 first-class artifact」的早期实例；未来若该模式扩散到其它 vertical（API client / file system / DB / cloud console），将与 MCP 形成纵向（按工具能力分层）vs 横向（按 vertical 分层）的两套生态。

**目前的限制 / 待解**。(a) skill 维护成本——每个网站 DOM/XHR 变化都要更新 skill，open web catalog 的实际更新节奏决定其工程价值；(b) 与 cloud_ip_bl（如 1688 的 headed-browser IP 级硬封）类反爬机制的对抗策略，CLI 自己也说 1688 走 h5api.m 的 mtop JSON API 而非真实浏览，意味着 skill 实际上是 "selector 包 + 反爬绕过 + 数据规范化"三件套；(c) 缺乏 §10 那种公开 benchmark 数据（50x token reduction 是 Browserbase 自宣，无第三方对比）；(d) cloud 模式下数据落在 Browserbase 平台，跨企业部署的安全边界未公开讨论。

---

## 来源一览

- [S0092] *Deep Research Agent / Agentic Search 系统设计：开源项目、研究思路与架构落地*——综合性指南，覆盖 10 个开源项目地形、6 条研究思路、6 角色架构、5 类停止条件、6 条工程动作、5 阶段 MVP 路径、8 条核心设计原则。本综述 §1–§9 的主体论点均出自此篇，属设计规范类，待开源 repo 二次验证。
- [S0110] *Glean Waldo: A Purpose-Built Agentic Search Model*——第一个已公开的 pipeline-first 专用 agentic search 子模型产品案例。30B/3B-active MoE（NVIDIA Nemotron 3 Nano），DPO + RL 两阶段训练，50% latency 降幅 / 25% token 减少。支持 §8 第 9 条设计原则、§10 产品化实证。
- [S0179] *Browse: a browser CLI for AI agents (Browserbase, 2026-05)*——浏览器层的开放 SKILL 目录 + CLI primitives + debugging + cloud。支撑 §11 「执行层与编排层解耦」论点；首个公开的 open web catalog 实例。
