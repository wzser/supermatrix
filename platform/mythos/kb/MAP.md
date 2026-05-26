# KB Map（知识库总览）

<!-- AUTO:meta -->
最后更新：2026-05-23
Source 数量：184　Concept 综述数量：7
<!-- /AUTO:meta -->

> 本文件是**知识库总览**：讲清楚 KB 当前覆盖了哪些概念、哪些领域、在哪里深入。
> 不在这里展开具体观点——观点要么在 concept 综述里（深度），要么直接回到 source（原文）。

---

## 当前形态

KB 目前收了 **179 篇 source**，围绕 "agent 工程化" 这一母题，已沉淀出 7 篇独立综述：

| Concept | 重心 | 主要源 |
|---------|------|--------|
| [harness](concepts/harness.md) | 包在 LLM 外面把对话变成工程产出的那层代码 | GSD v1/v2、Harrison Chase、Anthropic harness/subagent 系列、OpenClaw、Hermes、Magentic-One |
| [memory](concepts/memory.md) | agent 跨 session / 跨项目的记忆机制 | Anthropic managed agents memory、OpenAI、Google、AWS AgentCore、Microsoft PlugMem/CORPGEN、benchmark 集 |
| [agent-dreaming](concepts/agent-dreaming.md) | sleep-time compute / 异步反思 | Letta sleep-time、OpenClaw dreaming、MIRROR、Karpathy autoresearch |
| [a2a-protocol](concepts/a2a-protocol.md) | 跨 agent 通信协议 | A2A spec/docs、Google/Microsoft/IBM/Elastic 集成案例 |
| [multi-agent-orchestration](concepts/multi-agent-orchestration.md) | 多 agent 编排：控制流 / 拓扑 / durable execution / 故障容错 / agent 商务实证 | Claude Code / Codex / OpenAI / ADK / LangGraph / deepagents subagent 系、Flyte+Inngest durable、TDP / AOrchestra / MetaGPT、Google Research scaling benchmark、Databricks Supervisor & Multi-Agent Apps、Anthropic Project Deal（69-agent Slack 市场实证）、Cursor SDK |
| [deep-research-agent](concepts/deep-research-agent.md) | 深度搜索 agent / agentic search / evidence-grounded RAG：研究图、证据状态、停止条件 | S0092（综合性指南：10 个开源项目 + 6 条研究思路） |
| [prompt-engineering](concepts/prompt-engineering.md) | OpenAI / Anthropic 当前提示词工程指南综述 + 实证层（leaked 真实生产 prompt）：vendor disposition 差异、reasoning 模型 prompt、agentic 模式、prompt-as-code、§11 跨厂商真实生产 prompt 横向 | S0093–S0107（理论层）、S0111（GPT-5.5 专项）、S0143–S0156（实证层 Tier 1：Claude Opus 4.7/4.6/Sonnet 4.6/Code/Cowork、ChatGPT GPT-5.5/5.4 Thinking、Codex 5.5/5.3、Gemini 3.1 Pro/CLI、Grok 4.3 beta、Cursor） |

7 个概念不是互斥的——harness / memory / dreaming 是同一套 agent 运行时的不同切面（单 agent 视角）；a2a-protocol 是跨 agent 网络层；multi-agent-orchestration 是多 agent 控制逻辑层；deep-research-agent 是"信息寻取"这一具体能力轴；prompt-engineering 是『放进 harness 的 prompt 应该长什么样』的内容层规范。前者是底座，后者是上面跑的具体内容。

---

## 标签地形

tag 是细粒度分类，用于 jsonl 过滤和快速检索。概念综述层（concepts/）是粗粒度认知单元。

| 组 | tags | 对应 concept |
|----|------|-------------|
| **harness-runtime** | harness / pi-sdk / worktree-isolation / crash-recovery / state-machine / gateway / control-plane / managed-agents / sandbox / sdk / programmatic-agents / cloud-agents / composer-2 / composer / agent-framework / agentic-coding / practitioner-essay / reliability / one-year-update / github-copilot | → [harness](concepts/harness.md) |
| **context-management** | context-engineering / context-rot / context-editing / compaction / tool-clearing / lazy-loading / claude-md | → [harness](concepts/harness.md) §4、[memory](concepts/memory.md) §1 |
| **memory-core** | memory / memory-api / durable-learnings / immutable-version / multi-store / tiered-memory / memory-isolation / portable-memory / markdown-memory / memory-taxonomy / episodic / semantic / procedural / working-memory | → [memory](concepts/memory.md) |
| **memory-lifecycle** | distillation / consolidation / forgetting / injection / adaptive-summarization / promotion-gates | → [memory](concepts/memory.md) §2、§3 |
| **memory-retrieval** | vector-store / embeddings / rag / hyde / rrf / hybrid-retrieval | → [memory](concepts/memory.md) §3 |
| **memory-research** | trajectory-memory / reflective-learning / experience / self-managed-context / memory-virtualization / benchmark | → [memory](concepts/memory.md) §7 |
| **memory-security** | memory-poisoning / agentic / security / nist | → [memory](concepts/memory.md) §9 |
| **dreaming** | sleep-time-compute / dreaming / memory-reconsolidation / talker-thinker / async-deliberation / light-deep-rem / reflection | → [agent-dreaming](concepts/agent-dreaming.md) |
| **multi-agent-core** | multi-agent / subagent / spawn / orchestrator / supervisor / handoff / agent-as-tool / delegate / routing / task-ledger / synthesis / identity / credentials / agent-commerce / negotiation / marketplace / model-asymmetry / slack | → [multi-agent-orchestration](concepts/multi-agent-orchestration.md) §2、[harness](concepts/harness.md) §5 |
| **orchestration-patterns** | sequential / parallel-execution / hierarchical / dag / planner / generator-critic / iterative-refinement / loop / human-in-the-loop / assembly-line / async-subagents / durable-execution / long-horizon / workflow / temporal / peer-to-peer-marketplace | → [multi-agent-orchestration](concepts/multi-agent-orchestration.md) §3–§6 |
| **agent-reliability** | saga / circuit-breaker / contract / append-only / distributed-systems / task-delegation | → [multi-agent-orchestration §5](concepts/multi-agent-orchestration.md) |
| **agent-protocol** | a2a / mcp / ucp / agent-card / protocol-stack / task-lifecycle / artifact / streaming / push-notification / oauth / interop | → [a2a-protocol](concepts/a2a-protocol.md) |
| **deep-research** | deep-research / agentic-search / evidence-grounded-rag / research-graph / stop-policy / source-scoring / verifier / multi-agent-search / reranker / web-search / react / ircot / self-rag / crag / flare / browsecomp / deepresearch-bench / storm / mindsearch / manusearch / gpt-researcher / specialized-model / pipeline-first / moe / dpo / reinforcement-learning / routing / browse / browserbase / browser-automation / agent-tools / cli / open-skill-catalog / mcp-adjacent / token-cost-reduction | → [deep-research-agent](concepts/deep-research-agent.md) |
| **prompt-engineering** | prompt-engineering / best-practices / xml-tags / few-shot / instructions-parameter / responses-api / model-specific / reasoning-models / o-series / extended-thinking / agentic-prompting / tool-persistence / verification-loop / prompt-versioning / templates / meta-prompt / meta-schema / prompt-optimizer / prompt-migration / anti-patterns / personality / verbosity / phase-parameter / compaction / realtime / speech-to-speech / voice-agent / context-engineering / claude-4 / gpt-5 / gpt-5.1 / gpt-5.5 / gpt-4.1 / gpt-5.3-codex / codex / cursor / outcome-first / retrieval-budgets / grounding-rules | → [prompt-engineering](concepts/prompt-engineering.md) |
| **case-studies** | case-study / newsroom / data-agent / c-compiler / autoresearch / tutorial / hands-on | 分散在三篇综述作证据 |
| **agent-operational-discipline** | skill / claude-md / agents-md / knowledge-curation / context-hygiene / audience-separation / anti-bloat / cross-project-sync / end-of-session | → "尚未成文：agent operational discipline as cross-platform skill"（种子：S0068 + S0163） |
| **tooling / eval** | tool-design / eval / anti-pattern / inspector / reinforcement-learning / textual-feedback / credit-assignment / synthetic-data / reward-hacking / muon / hsdp / kimi-k2.5 | → [harness](concepts/harness.md)（工具与验证段；§6 RL credit assignment 与 reward hacking 监控） |
| **framework / platform** | claude-code / codex / opencode / adk / langgraph / deepagents / beeai / semantic-kernel / dotnet / agent-framework / letta / letta-code / memgpt / crewai / autogen / openclaw / hermes / gemini / flyte / inngest / temporal / openhands / metagpt / databricks / unity-catalog / genie / mcp / openai-agents-sdk / responses-api / managed-agents / enterprise | （元信息，用于按平台过滤） |

---

## Concept 综述索引

| Concept | 文件 | Sources（主要） | 摘要 |
|---------|------|----------------|------|
| Harness（AI 编码运行时） | [concepts/harness.md](concepts/harness.md) | S0001–S0003, S0004–S0012, S0013–S0015, S0016–S0022, S0041–S0042, S0086, S0088, S0109, S0161, S0162, S0164, S0168, S0171, S0173, S0176, S0177, S0178, S0184 | 包在 LLM 外面、把对话变成工程产出的那层代码。核心是把状态管理从 LLM 收回到 harness。**§8 架构形态新增一格**：Cursor TypeScript SDK [S0109] 是首个公开的 "programmable managed harness"——把 IDE 同款 runtime + 五件套（codebase 索引 / MCP / Skills / Hooks / Subagents）通过 SDK 程序化外露，本地/自托管/Cloud 三种 runtime 共栈、断网续跑流式重连。**§8 Managed service 增补 [S0161]**：Anthropic Managed Agents 公开 beta 文档（managed-agents-2026-04-01 header）把 [S0008] 的工程哲学晶化为 Agent / Environment / Session / Events 四概念接口契约，是『为什么这么设计 → 开发者怎么用』的另一面。**§8 Managed service 再增 [S0162]**：国内 B 站 up 主小天fotos 对 [S0008] 的中文二级解读 + 一周复现声明（brain/hands → harness → agent as orchestrator → SessionStore 四层结构），mythos 收到的第一份中文社区视角回响。**§8 反论新增 [S0164]**：Thinking Machines Lab 提出"interactivity must be native to the model, not bolted on via harness scaffolding"——实时交互能力应随 scaling 同步增长，外部脚手架不可持续；其 200ms micro-turn + dual-system 架构是该命题的首个大规模实证。**§8 新增形态 [S0168]**：Gemini Spark 泄露——OS 级持久操作层，后台常驻 / 跨应用 / browser session 维持 / 主动执行（unreachable source，早期信号）。**§2 / §6 practitioner 拐点 [S0177][S0178]**：Sean Goedecke 2026-05 一年更新给出 practitioner 视角的 "agents 进入 reliable 拐点"硬证据（每天几十次 Copilot session、30 秒一次判定、5-6 次拒绝率），与 Cursor Composer 2.5 公开训练栈披露的 targeted RL textual feedback / 25x synthetic / Muon+HSDP 训练机制 + 真实 reward hacking 样本（反编译 Java bytecode / 读 type-check cache 反推 deleted signature）从 model 侧与 practitioner 侧双向佐证 harness §2 / §6 论点。**§4.6 / §6 新增 [S0184]**：Cat Wu（Claude Code 产品负责人）Lenny's Podcast 访谈——模型自我反思作为 harness 调试的日常化轻量技术（"每次让它自我反思，你会立刻看到 harness 哪里出了问题"）+ system prompt curation 的反向纪律（每代新模型出来逐条砍掉不再需要的辅助手段）。 |
| Memory（Agent 记忆） | [concepts/memory.md](concepts/memory.md) | S0003, S0009, S0023–S0042, S0052–S0053, S0159 | memory ≠ 长 context；生命周期 = distillation / consolidation / forgetting / injection；Markdown 作为 portable memory；memory poisoning 是主要攻击面。**§3 / §9 新增**：Cobanov 综述 [S0159] 引入 4-memory taxonomy（episodic / semantic / procedural / working）+ 6 架构对照矩阵（buffer / rolling-summary / vector / graph / MemGPT / Letta）+ multi-agent memory 6 类失败模式（cross-user leakage / over-sharing / poison propagation / conflicting decisions / stale playbook / attribution loss），补齐了 mythos 此前缺失的工程教学层。 |
| Agent Dreaming（Sleep-time compute） | [concepts/agent-dreaming.md](concepts/agent-dreaming.md) | S0043–S0051, S0054, S0164 | 异步反思搬到 agent idle 时段，Letta sleep-time、OpenClaw light/deep/REM、MIRROR Talker/Thinker、Karpathy autoresearch。**S0164 新增产业案例**：Thinking Machines Lab 的 dual-system 设计（interaction model 主路实时 + background model 异步推理）是 talker-thinker 分离路线在商业级 multimodal 产品中的首个公开落地。 |
| A2A Protocol（跨 agent 通信） | [concepts/a2a-protocol.md](concepts/a2a-protocol.md) | S0055–S0067 | MCP 管 agent↔tools，A2A 管 agent↔agent。Agent Card + Task + Artifact 三抽象，跨 Google/Microsoft/IBM/Elastic 框架互通。 |
| Multi-Agent Orchestration（多 agent 编排） | [concepts/multi-agent-orchestration.md](concepts/multi-agent-orchestration.md) | S0004, S0069–S0086, S0089–S0091, S0108, S0109, S0169–S0175 | 拆 agent 不是默认选择——Google Research 180 次实验反例在先。核心原语（subagent / handoff / agent-as-tool）、**8 种拓扑**（sequential / parallel / supervisor / hierarchical / DAG / generator-critic / HITL / **peer-to-peer marketplace**——后者由 Anthropic Project Deal [S0108] 在 Slack 上 69 agents 跑通的 186 笔交易实证支撑）、durable execution 底座、**§5 故障容错四件套**（append-only 状态 / 边界契约 / 断路器 / Saga，Databricks Sandipan Bhaumik 演讲 [S0089] 与 Databricks Supervisor / Multi-Agent Apps 文档 [S0090][S0091] 提供 managed/BYO 双轨产品对照）、async subagent 趋势、meta-orchestrator 研究方向。**2026-05 框架刷新批（§3 / §4 / §10）**：Google ADK 升 v2.0.0 GA [S0169] 把拓扑目录升级为 production-grade 引擎；LangGraph 1.2.0 [S0170] 把 durable execution 覆盖到 error-handler resume；MS Agent Framework python-1.5.0 [S0171] 落地 Foundry Hosted Agents + 原生 SKILL.md frontmatter；CrewAI [S0172] 入库（51.7k stars 的零覆盖补全）+ AutoGen [S0174] 停更信号（Microsoft 主线迁 Agent Framework）+ BeeAI [S0175] 入库（IBM/LF，ACP→A2A 已并入 LF）+ Hermes v0.14.0 Foundation Release [S0173]。§10 新增"框架收束信号 2026-05"+"CrewAI 框架自带 Skills 包"两条待解问题。 |
| Deep Research Agent（深度搜索 / agentic search） | [concepts/deep-research-agent.md](concepts/deep-research-agent.md) | S0092, S0110, S0179 | Deep research = 多轮自主搜索 + 维护证据状态。开源项目地形（10 个）+ 6 条研究思路 + 六角色架构 + 5 类停止条件 + research graph。**§10 新增**：Glean Waldo [S0110] 作为第一个产品化专用 agentic search 子模型实证——pipeline-first 设计（先于 frontier LLM 运行）、30B/3B-active MoE、DPO+RL 训练、50% latency 降幅，支撑"Searcher 角色可以是专用小模型"这一第 9 条设计原则。confidence 由 low 升为 medium。**§11 新增**：Browserbase `browse` CLI [S0179] 把浏览器交互层从「自家造 harness」推到「公共 skill 目录 + 命令式调用」——Web skill / browser primitives / debug / cloud 四块能力，open web catalog 已含 12306 / 1688 / Airbnb / Ramp / weather.gov 等多 vertical skill；与 Waldo 的「编排层模型化」一起把 Searcher 角色拆成「编排 + 执行」两段。 |
| Prompt Engineering（提示词工程：OpenAI / Anthropic 当前指南综述） | [concepts/prompt-engineering.md](concepts/prompt-engineering.md) | S0093–S0107, S0111（16 篇） | 跨厂商 prompt 工程综述。两家 disposition 差异（Anthropic 单 living reference vs OpenAI 按模型版本切片）；§3 共通核心；§4 工具栈；§5 reasoning 模型 prompt 范式；§6 agentic prompting（tool persistence / preambles / verification / **retrieval-budgets / grounding-rules**）；§7 prompt-as-code；§8 anti-patterns；§10 开放问题。**§2 新增**：GPT-5.5 专项指南 [S0111]——outcome-first framing / personality+collaboration 分离 / retrieval budgets / grounding rules，核心主张"模型越强 prompt 越抽象"。 |

---

## 尚未成文的概念

这些主题当前 source 覆盖不够或分散在多篇综述里，未来增加 source 后可能单独立文：

- **Agent-IDE integration 的差异**：Claude Code、Cursor、Codex、Copilot 各自 harness 的对比。当前零散出现在 harness §8（架构形态光谱）。Cursor TypeScript SDK [S0109] 加入后这条对比有了新的轴——"managed harness 是否暴露为可编程 SDK"，Anthropic / OpenAI 当前没有等价物（Claude Agent SDK [S0010] 是 IDE 外的 client SDK，不挂同一 cloud 运行时）。
- **Tool design as context**：tool schema 设计对 context rot 的影响。当前仅 S0011 单一来源，在 harness 里一笔带过。
- **Evals for agents**：agent harness 与 eval harness 的关系。当前仅 S0012。
- **Multi-agent 辩论 / 对抗模式**：协作式拓扑已在 [multi-agent-orchestration](concepts/multi-agent-orchestration.md) 成文；但"两 agent 同题反方案 + 第三方裁决"类对抗机制仍几无公开实现，见 multi-agent-orchestration §9。
- **UCP（User Control Plane）/ OS 级持久操作层**：Google 提到的用户层控制平面 + 持久后台 agent 层。现有首个信号源 [S0168]（Gemini Spark 泄露，2026-05-15，unreachable）——设计要点：持续后台运行 / 接入浏览会话+应用+任务+聊天记录+位置 / 跨网站维持 browser session 免重复认证。§8 in harness.md 已加为新架构形态条目，§9 加入待解问题。需更多 primary source（如 Google I/O 正式公告 / 技术博客）才能独立成文。
- **Agent 的计费与成本模型**：跨 agent 调用的成本分摊、预算闸门，当前只在 A2A §9 作为开放问题提出。

- **Agent commerce / 谈判**：Anthropic Project Deal [S0108] 是首个真实标的物 + 真实参与者的 agent-to-agent 商务实证（多 agent 编排 §3 / §10 已收）。当前 source 只此一篇，但 Project Vend-1/2 (https://www.anthropic.com/research/project-vend-1, https://www.anthropic.com/research/project-vend-2) 与 Imas/Lee/Misra 2025、Zhu et al. 2025 等 economist 工作有可对照的二级文献，未来可独立成 "agent commerce" 综述。
- **Agent operational discipline as cross-platform skill**（agent 操作纪律的跨平台 SKILL.md 形态）：开放 Agent Skill 规范正在催生一类新工件——把"agent 在某个阶段应该怎么做"的纪律性步骤封装成跨平台（Claude Code / Codex / OpenCode / OpenClaw 通用）的 SKILL.md。当前 KB 内两份种子：S0068（Karpathy coding 行为契约：Think Before Coding / Simplicity First / Surgical Changes / Goal-Driven Execution）+ S0163（neat-freak 知识体系同步纪律：三层受众分离 + CLAUDE.md 反膨胀 + 五步会话收尾流）。两者的共性是"非领域知识、是 agent 自身操作纪律"，且都以 SKILL.md frontmatter + 触发词 + 步骤化执行流为载体。第三或第四份同类 source 进来时（候选：测试纪律 / 调试纪律 / PR review 纪律），可拆出独立 concept 综述讨论『agent skill 作为行为规范载体』的设计语法（触发词 / 红线 / 自检清单 / 跨平台路径）。

新 source 进来时按 SOP 判断是否触发这些概念成文。

---

## 争议 / 分歧

- **LLM 自管理 vs harness 管理**：Memento [S0036] / MIRROR [S0051] 路线主张模型内生 context 管理；GSD v2 [S0002] / OpenClaw / Anthropic managed agents [S0008] 坚持 harness 控制权反转。当前占优的是后者，但前者作为"长期补充"而非替代。见 [harness §2–§3](concepts/harness.md)、[memory §6](concepts/memory.md)。
- **Memory 存储介质**：markdown (CHANGELOG.md [S0024] / DREAMS.md [S0048] / CLAUDE.md [S0042]) vs vector DB vs 专用 memory store API (Anthropic [S0025] / AgentCore [S0032])。前者胜在可审查/可携带，后者胜在规模/精确检索。无统一结论。见 [memory §4](concepts/memory.md)。
- **Dreaming 是否应该自主改写 memory**：OpenClaw [S0048] 强制 DREAMS.md 人审；Letta [S0043] 偏向自动化。安全性 vs 规模性的张力。见 [agent-dreaming §7](concepts/agent-dreaming.md)。
- **多 agent 协议层归属**：A2A（中立传输层）vs OpenClaw ACP（harness 互通）vs Hermes DAG（内部编排）三条路线竞争，A2A 领先但未定。见 [a2a-protocol §8](concepts/a2a-protocol.md)。

---

## 待处理

（已抓取但未纳入任何 concept 综述的 source。）

- **S0068**（forrestchang/andrej-karpathy-skills，单文件 CLAUDE.md，57.4k stars）：把 Karpathy 对 LLM coding 常见坑的观察固化成 4 条 behavioral principle（Think Before Coding / Simplicity First / Surgical Changes / Goal-Driven Execution）。2026-04-19 应用户请求捕获并同步 FP 参考，当前尚未纳入 concept 综述——属于 "agent coding behavioral contract" 方向，可能催生"coding-principles for agents"这一未成文概念。**2026-05-20 强信号扩充**：S0171（MS Agent Framework `agent-framework-core` 原生解析 SKILL.md frontmatter YAML block scalars）+ S0172（CrewAI 发布官方 Skills 包，一键安装到 Claude Code / Cursor / Codex / Windsurf）——这条母题从"少数 CLAUDE.md 工件"升级为"框架级 first-class artifact"，已具备成 concept 的条件。
- **S0163**（KKKKhazix/khazix-skills `neat-freak`，bundle SKILL.md + agent-paths.md + sync-matrix.md 三份）：跨平台 agent skill（Claude Code / Codex / OpenCode / OpenClaw 通用），主张『三层受众分离』（Agent 记忆系统 / CLAUDE.md-AGENTS.md / docs+README 受众不同职责不重叠，三份都要写）+ CLAUDE.md 是规则手册而非变更日志（反膨胀软上限 ~300 行 / ~15KB，加项 > 30 行红灯）+ 五步执行流（尺寸体检 → 机械式 ls 枚举 → 变更影响矩阵 → 真改文件 → 自检清单 → 摘要）。2026-05-13 应用户请求捕获。当前尚未纳入 concept 综述——和 S0068 同属"agent operational discipline as cross-platform skill"母题，但具体方向不同（S0068 是 coding 行为契约，S0163 是知识体系同步纪律），见下方"尚未成文的概念"。
- **S0087**（Y Combinator × Cursor CEO Michael Truell，YouTube 访谈 "Going Beyond Code / Superintelligent AI Agents / Why Taste Still Matters"）：2026-04-22 抓取时 YouTube 反爬拦截（yt-dlp 无 cookie + IP 限制 + Chrome keychain 阻塞三连），只拿到 oEmbed 元信息，`content_type: unreachable`。后续在有 browser cookie 的环境下可用 `scripts/fetch-transcript.py` 覆盖。话题上与 S0086 互补（S0086 工程内核，S0087 创始人视角），一旦字幕到手应一并进入 `multi-agent-orchestration` / `harness` 的"产线参照"段。
- **S0112–S0142**（AI Valley v1.1 catch-up 批，22 封 newsletter ingest），全部 tag 含 `ai-valley-intake`，未纳入任何 concept 综述。其中 9 篇为 X/Twitter / YouTube SPA fallback 已标 `content_type: unreachable`（见下文"已知抓取空洞"段）；其余 22 篇是有内容的 source，待按 kb-capture Step 6 周内逐个判定是否编织进 harness / memory / multi-agent-orchestration / prompt-engineering / deep-research-agent 综述，或挂"尚未成文"清单。重点候选——S0123 Meta Muse Spark Contemplating（reasoning）/ S0121 Kimi K2.6 / S0134 Claude computer use / S0142 Physical Intelligence π0.7 / S0123 Anthropic Cowork（dashboards）等。
- **S0164**（Thinking Machines Lab interaction models blog，2026-05-11）：已在 harness 和 agent-dreaming 综述索引中加指针，但 concept 正文尚未编织。重点是"model-native interactivity vs harness scaffolding"这一争议轴，可在 harness.md §8 展开，并在 agent-dreaming §5（talker-thinker）补 dual-system 产业落地案例。
- **S0165**（OpenAI Codex Chrome extension docs，2026-05-13）：agentic browser automation / computer use，当前无对应 concept。候选归属：deep-research-agent（浏览器工具链）或单独列为 computer-use 未成文概念。
- **S0166**（Narayanan & Kapoor "AI as Normal Technology"，2025-04-15）：行业 narrative / AI 技术扩散分析，非 agent 工程核心。作为背景文献挂待处理，不归属任何 concept。

---

## 已知的抓取空洞

**2026-05-05 AI Valley intake 三跑**

- **AI Valley newsletter**：邮箱 `mailbox-0008` (Jarvis2@qrzar.com)，archive `<CODEX_SKILLS_ROOT>/email-admin/archive/mailbox-0008/`。三次 intake 合计：S0108（Anthropic Project Deal）+ S0109（Cursor TypeScript SDK）+ S0110（Glean Waldo agentic search）+ S0111（OpenAI GPT-5.5 prompting guide），前两次报告见 [`logs/intake/ai-valley/2026-05-04.md`](../logs/intake/ai-valley/2026-05-04.md)，三跑报告见 [`logs/intake/ai-valley/2026-05-05.md`](../logs/intake/ai-valley/2026-05-05.md)。SOP status 仍标 `blocked_on_mailbox_onboarding`，待用户确认筛选灵敏度后切 `active` 接 scheduler。

**2026-04-18 / 04-19 两轮修复纪要（现已全部恢复）**

- **2026-04-18**：用 web-access 技能（Chrome CDP 9222 完整 JS 渲染）对前一轮 34 条 `unreachable` source 做二次复核。结论——大多数失败不是 SPA 渲染问题，而是 reading-list 里的 URL 本身在各站点已失效或路径不对。首轮直接恢复 7 条（S0013 / S0015 / S0023 / S0026 / S0030 / S0038 / S0039），其余 27 条标 `url-dead` 等待替代来源。
- **2026-04-19**：针对剩余 27 条做一轮 WebSearch + CDP 复抓替代 URL，全部恢复为真实来源。关键修复如下：

| ID | 原 URL（已失效） | 替代 URL |
|----|------------------|----------|
| S0004 | anthropic.com/research/building-multi-agent-research-system | anthropic.com/engineering/multi-agent-research-system |
| S0005 | engineering/harness-design-for-long-running-application-development | engineering/harness-design-long-running-apps |
| S0006 | engineering/building-a-c-compiler-with-parallel-claudes | engineering/building-c-compiler |
| S0008 | engineering/scaling-managed-agents | engineering/managed-agents |
| S0010 | engineering/how-and-when-to-use-subagents-in-claude-code | engineering/building-agents-with-the-claude-agent-sdk |
| S0011 | engineering/writing-effective-tools-for-agents | engineering/writing-tools-for-agents |
| S0016 | docs.openclaw.ai/concepts/gateway-architecture | deepwiki.com/openclaw/openclaw/1.2-core-concepts |
| S0017 | docs.openclaw.ai/concepts/multi-agent-routing | clawdocs.org/guides/multi-agent/ |
| S0018 | docs.openclaw.ai/concepts/session-tools | openclawlab.com/en/docs/concepts/session-tool/ |
| S0019 | docs.openclaw.ai/concepts/acp-agents | openclaws.io/docs/tools/acp-agents |
| S0020 | docs.openclaw.ai/concepts/sessions-spawn | github.com/openclaw/openclaw/issues/53370 |
| S0021 | docs.openclaw.ai/concepts/delegate-architecture | dev.to/czmilo/2026-complete-guide-openclaw-acp-... |
| S0025 | platform.claude.com/docs/en/managed-agents/memory | platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool |
| S0033 | aws.amazon.com/blogs/.../how-agentcore-episodic-memory-works | aws.amazon.com/blogs/.../build-agents-to-learn-from-experiences-using-amazon-bedrock-agentcore-episodic-memory |
| S0048 | docs.openclaw.ai/concepts/dreaming | gist.github.com/sing1ee/fc04334b5870d6dfab53253093ab5126（**2026-05-09 已重抓 canonical**：原站点 SPA 渲染问题修复 + `.md` 后缀返回 raw markdown；S0048 已更新回 canonical URL，gist 留 `mirror_urls` 历史溯源） |
| S0049 | docs.openclaw.ai/concepts/memory | github.com/openclaw/openclaw/blob/main/docs/concepts/memory.md |
| S0050 | docs.openclaw.ai/cli/memory | openclawlab.com/en/docs/cli/acp/ |
| S0056 | a2aprotocol.ai/spec | a2a-protocol.org/latest/specification/ |
| S0057 | developers.googleblog.com/announcing-the-agent2agent-protocol-a2a/ | developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/ |
| S0058 | github.com/google/a2a-samples | github.com/a2aproject/a2a-samples |
| S0061 | deeplearning.ai/short-courses/a2a-agent2agent-protocol/ | deeplearning.ai/short-courses/a2a-the-agent2agent-protocol/ |
| S0062 | developer.ibm.com/tutorials/use-a2a-protocol-for-ai-agent-communication | ibm.com/think/tutorials/use-a2a-protocol-for-ai-agent-communication |
| S0063 | elastic.co/blog/creating-llm-agent-newsroom-a2a-protocol-mcp-elasticsearch | elastic.co/search-labs/blog/a2a-protocol-mcp-llm-agent-newsroom-elasticsearch |
| S0064 | cloud.google.com/gemini/docs/enterprise/register-manage-a2a-agents | docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-a2a-agent |
| S0065 | devblogs.microsoft.com/semantic-kernel/integrating-semantic-kernel-python-with-a2a/ | devblogs.microsoft.com/foundry/semantic-kernel-a2a-integration/ |
| S0066 | devblogs.microsoft.com/dotnet/building-ai-agents-with-a2a-dotnet-sdk/ | devblogs.microsoft.com/agent-framework/guest-blog-building-multi-agent-solutions-with-semantic-kernel-and-a2a-protocol/ |
| S0067 | devblogs.microsoft.com/microsoft-agent-framework-1-0/ | devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/ |

**重要事实修正（关于 OpenClaw）**：
前一轮 MAP 判断"OpenClaw 根域名实际是一款 Personal AI Assistant... 概念框架在公开网络上不存在"——**这个判断是错的**。真相是：`docs.openclaw.ai` 作为 docs 站点当前渲染有问题（所有 `/concepts/*` 返回空壳），但 `openclaw/openclaw` GitHub 仓库活跃（issues 编号已经到 67k+，多个社区插件 LeoYeAI/openclaw-auto-dream、RogueCtrl/OpenClawDreams、win4r/openclaw-a2a-gateway、yoloshii/ClawMem），DeepWiki / clawdocs.org / openclawlab.com 都有可读镜像。OpenClaw 概念框架（gateway / harness / dreaming / memory / sessions_spawn / ACP）**客观存在**，只是 docs.openclaw.ai 这个特定站点 broken。

**对综述的影响**：四篇 concept 综述里对这 27 条的引用现在都指向有效 URL。综述正文在下一轮校对之前仍应视为"基于原始 reading-list 摘要"——本轮只换了出处、没有重新核对综述内容与原文的对齐。后续应当逐条把 concepts/ 里的论点对照恢复后的原文做一次复核。

**验证脚本 & 数据**：
- 抓取脚本：`/tmp/kb-webaccess/fetch.mjs`（CDP WebSocket 直连 9222）
- 本轮 manifest：`/tmp/kb-webaccess/manifest2.tsv` + `manifest3.tsv` + `manifest4.tsv`
- 回写脚本：`/tmp/kb-webaccess/apply2.py`
- fetch-log：`/tmp/kb-webaccess/fetch.log`

---

## 使用须知

- 查询时先读本文件，判断相关概念是否已有综述。有 → 下钻 `concepts/<slug>.md`；无 → 按 tag 或 id 回到 `sources/` 读原文。
- 本文件由 `sop/kb-capture.md` 在每次新增 source 后同步更新。
- 手动编辑前先读 `kb/CHARTER.md`。
- 同步到飞书：`./scripts/sync-kb.sh`（all / charter / map / concepts / concept &lt;slug&gt; / table）。
