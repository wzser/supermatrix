---
last_updated: 2026-05-20
confidence: high
refresh_cadence: event-driven
parent: null
children: []
unwritten_children:
  - debate-and-adversarial: "多 agent 辩论 / 对抗机制，目前公开实现近零，§9 列为开放问题"
  - meta-orchestrator: "AOrchestra-style 自动派生 + 拓扑选择，目前 [S0081] 单源研究"
  - agent-commerce: "agent-to-agent 商务 / 谈判：Anthropic Project Deal [S0108] 是首个真实标的物 + 真实参与者实证，但成熟度只到 pilot；§3 加了 peer-to-peer marketplace 拓扑、§10 收下 agent-quality 不对称的隐性不平等"
boundary_with:
  - harness: "harness 管单 agent 的包壳；本综述管多 agent 编排逻辑（subagent / handoff / topology / durability）"
  - a2a-protocol: "A2A 是跨 agent 网络协议；本综述管 orchestrator 内部控制流，可走 A2A 也可同进程"
---

# Multi-Agent Orchestration（多 agent 编排：控制流 / 拓扑 / 持久化）

---

## 1. 问题：拆多 agent 从来不是默认答案

2026 年"多 agent"已经从新奇概念变成会议室常见词，但**随便拆就变贵变差**是业界近一年最重要的实证。Google Research 用 180 个 agent 配置对照 4 个基准得出一个刺眼数字：**可并行任务上 centralized 多 agent 平均提升 80.9%，但可串行任务上所有多 agent 变体性能反而下降 39–70%**；独立并行 agent 把错误率放大 **17.2×**，centralized 模式约束到 4.4× 是因为有中央审查 [S0082]。这个结果把"多 agent 一定更好"的默认假设反过来。

OpenAI 给的经验法则完全一致：**先单 agent，只有当 capability / policy / prompt clarity / trace legibility 真有明显提升时才拆**[S0071]。"拆"本身有两种形态：**handoff**（把控制权完全移交专家 agent，各自 ownership）和 **agents-as-tools**（专家只作工具、主 agent 统一合成输出）。前者适合分支清晰、后者适合主线需要一致结论 [S0071]。类似观察在 Anthropic 的 Claude Code subagent 指南里也反复出现——subagent 的 5 类主用场景是研究 / 并行独立任务 / 新鲜视角 / 提交前审查 / 流水线，反面场景（强依赖上下文、短任务）明确警告不要拆 [S0069]。

这一节先把结论摆在前面：**编排是选择题，不是必选题**。本综述后面讲的所有原语、拓扑、durability、契约都是在"确实要拆"之后才有意义。Databricks 资深工程师 Sandipan Bhaumik 在同一时段的公开演讲里把这件事讲得更刺：从 1 到 5 个 agent，潜在连接和故障模式 25×，单体思维的开发者最常低估的就是分布式环境下的竞态条件与缓存失效——**多 agent 本质上就是分布式系统工程**[S0089]。这个判断和 Google Research 的实证 [S0082] 互为表里：拓扑选错代价不仅是性能下降，还是引入分布式系统级失败模式而没有相应防护。

---

## 2. 核心原语：subagent / spawn / handoff / agent-as-tool / delegation

尽管命名差异大，各主流 harness 在"多 agent 调用"上正在收敛到一套原语。

- **Subagent**（独立 context window 的子 agent 实例）是最普及的抽象。Claude Code 把 subagent 定位为"**独立 context window 的 Claude 实例**"，召唤方式包括会话式触发、`.claude/agents/*.md` 静态定义、CLAUDE.md / skills / hooks 注入 [S0069]。OpenAI Codex 的对应物是内置 **default / worker / explorer** 三类，加上 `~/.codex/agents/*.toml` 自定义，参数包括 `max_threads` / `max_depth` / sandbox，还提供 `spawn_agents_on_csv` 做批处理 fan-out [S0070]。LangChain deepagents 则把 **planning + subagent + 文件系统 + 详细 prompt** 作为"深度 agent"的四件套，`createDeepAgent` 是主入口 [S0075]。

- **Handoff vs agents-as-tools** 是 OpenAI Agents SDK 给出的两种"拆"模型 [S0071]。Handoff 后主 agent 完全退场，新 agent 独立完成任务并返回；agents-as-tools 下主 agent 像调用函数一样用专家 agent 的输出作为自己的 token。两者都是有效模式，选择看信任链结构。LangGraph 的 supervisor 包把 handoff 与"forward message"作为两种独立原语：`create_handoff_tool`（控制权移交）和 `create_forward_message_tool`（只传递上下文）[S0077]——这是对 OpenAI 那一层区分的更细粒度工程化。

- **自动化派生 subagent**。AOrchestra 把这个方向推到下一步：**subagent 的 role / tool / prompt 从人工预定义转为按任务自动生成**[S0081]。这和 Codex / Claude Code / deepagents 的"静态模板 + 用户自定义"路线形成对比，但也承认一件事——当 agent 池扩张到 dozen+ 时，人工维护每个 agent 的 system prompt 会把 harness 作者拖进另一个 context rot 里。

产线级参照：Cursor 的 **Anyrun orchestrator** 是一个 Rust 写的独立服务，负责在 EC2 + Firecracker 上启动 agent，带进程隔离 [S0086]——和 §4 会讲的 durable execution 组件形成"orchestrator ≠ durable engine，但两者同栖"的现实分工。Anyrun 细节在付费墙后，可引的是"产线多 agent 系统把 orchestrator 作为独立 Rust 服务 + 用 microVM 做 agent 隔离"这一事实。Cursor 2026-04-29 公开的 TypeScript SDK 把 Anyrun 那一栈程序化外露 [S0109]：subagent 是显式原语（主 agent 通过 `Agent` tool spawn 命名子 agent，各带独立 prompt + 模型），cloud 模式下每个 agent 拿自己的 dedicated VM + repo clone + 自动 PR / 流式重连，hook 通过 `.cursor/hooks.json` 在 cloud / self-hosted / local 三种 runtime 上行为一致——把 [§3 supervisor + §6 async subagent] 的工程化产品化为可被外部应用直接调用的 SDK 形态。这是 Anyrun 设计的客户面缩影，也是 [harness §8](harness.md) "managed harness 暴露为 SDK" 这条新路线的产线案例。

原语层收敛后，**真正定义多 agent 系统形状的是下一层：拓扑**。

---

## 3. 编排拓扑：七种模式 + 一个反模式

Google ADK 把多 agent 的常见 topology 系统化成**八条模式 + 原语集**[S0072] [S0073]，这是目前最完整的公开目录。**ADK 2.0.0 GA（2026-05-19）** [S0169] 把这套目录从 SDK 升级为 production-grade 引擎：model-agnostic 的 Multi-Agent Workflow Engine 支持 non-linear / conditional / cyclical 执行图（覆盖到 §6 generator-critic / loop），模块化抽象同时支持 parallel sub-agent worker / nested hierarchical team / resilient dynamic scheduling；Dynamic Agent Collaboration 主线提供 native inter-agent routing + 控制状态 handoff + context variable 跨 agent 传播。下面的分类吸收 ADK 的命名，跨对其他源补证据：

| 拓扑 | 一句话 | 代表源 |
|---|---|---|
| **Sequential pipeline** | 固定顺序的流水线，前一步产出是后一步输入 | ADK SequentialAgent [S0073]，MetaGPT assembly line [S0085] |
| **Parallel fan-out + gather** | 同一任务切片广播给多 agent，最后聚合 | ADK ParallelAgent [S0073]，Anthropic multi-agent research 的 lead + parallel subagents [S0004] |
| **Coordinator-Dispatcher** | 中枢 agent 按输入路由到一个专家 | ADK 同名模式 [S0072] [S0073] |
| **Supervisor (hub-and-spoke)** | 中枢 + 多 worker 的星型，worker 间不直接通信 | LangGraph supervisor 包 [S0077]，OpenAI handoff 常见形态 [S0071]，Databricks Supervisor Agent（managed 产品） [S0090]，Databricks Multi-Agent Apps（BYO orchestrator + OpenAI Agents SDK） [S0091] |
| **Hierarchical decomposition** | 多层 supervisor 嵌套，高层拆粗粒度、低层拆细 | ADK hierarchical [S0072] [S0073]，LangGraph 支持任意层级 [S0077] |
| **Generator-Critic** | 一个生成、一个批评，两者互相循环直到通过闸门 | ADK [S0072]，GSD Checker / Verifier 是 concepts/harness.md §6 的前身 |
| **Iterative Refinement / Loop** | 单 agent 或小圈在固定终止条件下反复迭代 | ADK LoopAgent [S0073] |
| **Human-in-the-Loop** | 编排流程里嵌入人审闸门 | ADK [S0072] [S0073]，Inngest 把这条列为 durable engine 必备 [S0079] |
| **Peer-to-peer marketplace** | 没有中央 orchestrator，多 agent 在共享通信总线（chat channel / message bus）上随机轮询发布、出价、成交 | Anthropic Project Deal [S0108]：69 agents 在同一 Slack channel 内互相挂牌、出价、成交，平台仅做随机轮询调度，无人工介入也无中央 supervisor |

新加的 peer-to-peer marketplace 模式与前八种本质不同：前八种都假定有一个 orchestrator 决定下一步谁说话、信息如何聚合；Project Deal [S0108] 让 Slack channel 本身做"轮询发言权"，agent 行为由其个体 system prompt 驱动，集体行为是涌现的。这种结构在长程任务里效率低（无聚合 = 无收敛压力），但在交易撮合这类**没有共同目标只有匹配双赢**的场景里反而合适——也是为什么它能在一周里跑出 186 笔成交的工程基础。

**DAG** 是前七种 orchestrator-driven 拓扑的更一般形式。Flyte 2.0 的 planner agent 先生成任务 DAG、依赖感知地并行调度专家 agent 完成各节点 [S0078]；TDP（Task-Decoupled Planning）用 **Supervisor + Planner + Executor** 三层，训练自由、以 DAG 为骨架，在 TravelPlanner / ScienceWorld / HotpotQA 三个 long-horizon 基准上把 token 消耗降 **82%** [S0080]。TDP 的关键观察是：**"step-wise" 和 "one-shot" 两种规划都受困于 entangled context**——跨子任务共享单一执行历史导致错误传播，DAG + scoped context 是解药。这把 §1 里 Google Research 的经验结论有了一个机理解释。

MetaGPT（2023 年）作为多 agent 软件协作的奠基作，提出了另一条拓扑：**把人类 SOP 编码进 prompt 序列，assembly line 式给 PM / Architect / Engineer 分工，中间产物结构化校验以压制 cascading hallucination** [S0085]。这是 sequential pipeline 的软件工程特化版，也是"结构化交接物"思想的源头之一。

**反模式：什么都拆**。前面 §1 已经引过证据。Claude Code 指南里明说"强依赖上下文、短任务不要开 subagent"[S0069]；OpenAI 劝"先单 agent"[S0071]；Google Research 的 180 次实验直接给反例 [S0082]。拓扑选择的根本原则：**任务的可并行性 + 错误传播风险 + 上下文耦合度**决定要不要拆、怎么拆。

---

## 4. Durable execution 是多 agent 的底座

**多 agent + 长程任务 = 必须持久化**。这不是可选优化，是多 agent 系统的生存基建。Inngest 的长文把这个判断讲得最清楚：durable execution 在 2025–2026 年之所以从 queue / retry 的小众工具走到 AWS / Cloudflare / Vercel 各出自家版本，**首要驱动力是 AI agent**——agent 有三类传统系统少见的 failure mode：概率性（LLM 本身不确定）、组合性（多步 tool 调用叠乘）、有状态（长 context 崩了就崩了）[S0079]。Durable engine 的自动 `persist + replay + suspend/resume` 把这三类失败从"业务代码问题"下沉成"运行时能力"。

Gemini 官方给了一个最小可跑的教科书实现：用 **Temporal 的 workflow + activity + worker 三件套**包住 ReAct loop，每次 LLM 调用和 tool 调用独立落盘；进程 crash 后 Temporal 自动 retry、从最后完成步骤恢复，整个 agent 循环对网络与进程故障免疫 [S0074]。这是"harness = 副作用域"（见 [concepts/harness.md §3](harness.md)）在多 agent 规模下的必然延伸：**单 agent 可以靠 in-memory state 侥幸活一小段，多 agent 长程任务不持久化就是在定时炸弹上工作**。

Flyte 2.0 的方案和 Temporal 是同一精神，不同形态：**任务边界即 checkpoint**，reusable container 把启动延迟摊薄到可接受，然后 planner 把多 agent 工作切进这套 DAG 调度器 [S0078]。这条路线的赌注是——把 AI agent 搬到"生产级工作流调度器"的基础设施上，而不是再造一个 agent-native 的 durable engine。

**LangGraph 1.2.0（2026-05-12）** [S0170] 把这条 agent-native 路线又推进一步：核心 feature 是 **durable error-handler resume across host crashes**——错误处理器自身在宿主机崩溃后能从中断点续跑，而不仅仅是被监控的业务步骤可恢复；同步落地 delta channel checkpointing（强制 max-superstep snapshot + streaming walk）压低 checkpoint 存储 / 恢复开销。这条 release 的工程含义是：durable execution 已经从"业务步骤 replay"覆盖到"错误处理逻辑本身的 replay"，是 [S0079] Inngest"低延迟 durable endpoint"方向的一个具体进展。

Inngest 进一步提出"低延迟 durable endpoint"是下一代 agent runtime 的发力点 [S0079]——把 durability 的 overhead 从秒级压到亚秒级，让 durable execution 能覆盖到 chat-like 响应路径，而不仅是后台批处理。这个方向目前公开实现少，但所有 agent runtime 厂商都看见了。

---

## 5. 故障与契约：单纯 durability 之外

§4 解决"agent 执行链能不能在 crash 后接着跑"，但生产多 agent 系统还要回答另外三个相邻问题——**坏 agent 不要拖死全局、坏数据不要污染下游、有副作用的步骤要能反向撤销**。Databricks 这条主线把这三组模式与 §4 的 durable execution 拼成"四象限的失败防护"：

**Append-only 不可变状态**。共享可变状态在多 agent 并发下触发"最后写入者胜"的丢数据失败 [S0089]。模式是 agent N 接收版本 v 的快照、产出版本 v+1 的新快照，版本演进作为数据血缘，无锁并发——版本本身可被审计、可回放。这条思路和 §7 的"文件系统作隐式协作层"、GSD v2 的 worktree + squash merge（[harness §7](harness.md)）是同一脉的不同实现：**用 append-only 抽象把并发冲突挡在 agent 外**。它和 [memory §4](memory.md) 的 markdown-as-portable-memory 也呼应——agent 不直接互相覆盖状态，而是产出可审查、可回溯的版本。

**Boundary contracts**。Agent 之间不能任意传数据，必须在边界强制 schema 校验 + 置信度阈值，把垃圾数据拦在下游环节之外 [S0089]。Databricks 的产品落地把"contract"具象成 **Unity Catalog 函数 + 权限矩阵 + AI Guardrails**：任何 agent 调用 subagent 或 tool 都先经过 catalog 校验，end-user 对 subagent 的访问权（CAN QUERY / EXECUTE / USE CONNECTION）和数据权一并强制 [S0090]。Databricks Multi-Agent Apps 文档把这件事说得更直白——subagent 的 description 文本"直接决定 orchestrator 路由质量"，所以契约不只是 schema，还包括描述的清晰度和职责边界 [S0091]。这是 OpenAI Agents SDK 的"agent-as-tool" [S0071] 在企业治理层的延伸：工具签名 + 权限 + 描述三件套作为一组绑定的"agent 接口契约"。

**Circuit breaker 与 Saga**。生产系统必须假设 agent 会失败 [S0089]。**断路器**阻止单个超时 / 错误率激增的 agent 拖垮全局——这和 [harness §6](harness.md) 的 state machine + watchdog 是同一精神在多 agent 维度的体现，也呼应 [a2a-protocol §6](a2a-protocol.md) 的 task lifecycle 终止态设计。**Saga** 模式则要求每个 agent 实现 `execute + compensate` 成对方法，整链失败时按相反方向回滚——这填补了 §4 的留白：durable execution 解决"重做某一步"，但**有外部副作用的多 agent 流程需要反向撤销而非重做**（取消订单、撤销支付、删除外发邮件）。Saga 在 LLM agent 上目前更多是设计模式而非现成框架——和 §6（async subagent）一样，是同一条"可靠多 agent runtime"路线上还没收敛的拼图。

**managed vs BYO orchestrator**。Databricks 同时给出两条产品落地路线：(a) **Supervisor Agent** [S0090]——managed 路线，UI 选 Genie Space / Knowledge Assistant 端点 / UC 函数 / 外部 MCP server 作为 subagent，平台自动建路由 + 用 SME 自然语言反馈循环调优，权限走 Unity Catalog，supervisor 内置 ACL 让 end-user 只看见有权访问的子 agent；(b) **Multi-Agent Apps** [S0091]——BYO orchestrator 路线，OpenAI Agents SDK 模板把每个 subagent 暴露成 Responses API tool，OAuth 做 app-to-app 认证。前者把 §3 supervisor 拓扑产品化、后者把 §2 agents-as-tools 工程化——和 LangGraph supervisor 包 [S0077] 形成 "managed product / open-source library / BYO scaffold" 的三轨对照。

四类模式（durability / append-only / contract / 断路器与 Saga）之间是**互补关系**。Databricks 资料把它们组装成一套生产参考：LangGraph 类调度 + Unity Catalog 契约 + Delta Lake 不可变状态 + MLflow 追踪 [S0089]。具体技术选型不必照搬（Delta Lake 这种重型湖表显然不是中小规模 agent 系统的默认），但**"故障防护要分层组合"**这个判断框架值得吸收——单押任何一种都不够。

---

## 6. Sync vs Async：subagent 的下一代形态

主流 subagent 实现（Claude Code、Codex）当前还是 **同步调用**：主 agent 发令 → 等 subagent 完成 → 拿结果继续。这在 long-horizon 场景里会把主 agent 卡住。LangChain deepagents 的新文档提出 **async subagent** 抽象 [S0076]：

- Supervisor 调用后**立即返回 `task_id`**，subagent 在后台跑；
- 五个控制原语：`start` / `check` / `update` / `cancel` / `list`；
- 底层走 Agent Protocol，同机 co-deploy 用 ASGI、远程用 HTTP。

这个设计意义很大。同步模型下主 agent 的 context 成本 = 它 + 所有 subagent 的 latency 之和；异步模型下主 agent 可以同时 orchestrate 多个长跑任务，中途 update 或 cancel，thread 本身被 Agent Protocol 持久化。配合 §4 的 durable execution，async subagent 是"**把多 agent 做成可交互的 long-horizon service**"所需的最后一块。

deepagents 的 README 把这件事作为 async-subagents 扩展指引专门收录 [S0075]。LangGraph supervisor 包的 handoff / forward message 原语 [S0077] 在这个框架下是同步特化——async 是它的上位抽象。

---

## 7. 自动化派生：从模板到自动 generation

§2 提到过 AOrchestra [S0081]——它的核心主张是**"orchestration 也可以 meta 化"**：不是人工为每个子任务写 agent 模板，而是系统根据任务自动派生 role / tool / prompt。

为什么这事重要？因为 §3 的拓扑选择本质上是**对任务拓扑的匹配**：sequential 还是 parallel，几层 supervisor，要不要 generator-critic——这些全是人工判断。当任务规模从 dozens 涨到 hundreds，这种人工判断本身成为瓶颈。AOrchestra 代表的研究方向（即便当前效果有限）在赌一个未来：**meta-orchestrator 选择拓扑 + 自动派生 agent**。

短期这条路线还不成熟，但它和 §4（durable execution）、§5（故障容错）、§6（async subagent）一起，指向同一个长期目标：**把人工编排压缩到只剩高层目标**，底下的拓扑、派生、持久化、容错都由 runtime 自动处理。

---

## 8. 工作空间作为隐式协作层

跨 agent 协作不必都通过消息传递。**文件系统 / 共享工作区**是一种被低估的隐式协议。FS-Researcher 论文直接把这件事作为核心机制：**把文件系统当 agent 的外部记忆和协作工作空间，用来做 long-horizon 研究任务的 test-time scaling** [S0083]。多 agent 同读同写一个结构化目录，文件即是 state，目录结构即是任务分解。

这和 [concepts/memory.md](memory.md) 里反复讲的"markdown as portable memory"是同一脉络，但视角不同：memory 综述关心的是**同一 agent 跨 session 的记忆连续性**，而这里关心的是**多 agent 并行时如何共享 state 而不互相踩踏**。GSD v2 的 worktree 隔离 + squash merge（见 [concepts/harness.md §7](harness.md)）是 git 层面的同一策略——**用文件系统抽象把并发冲突挡在 agent 外**。

LangChain deepagents 把"file system tools"作为核心四件套之一 [S0075]，OpenAI Codex 的 sandbox + workspace 设计 [S0070] 也内置同样假设：subagent 有一个明确的"可写区域"。工作空间隔离 + shared filesystem 是多 agent 协作的"mutex 替代品"。

---

## 9. 与 harness / a2a-protocol 的边界

三个概念容易混淆，定位要讲清楚：

- **[Harness](harness.md)** 是**单 agent 的包壳**——context 管理、state machine、git 策略、崩溃恢复、tool 调度。它的视角是"一个 LLM 实例如何变成工程产品"。
- **[A2A Protocol](a2a-protocol.md)** 是**跨 agent 的传输层**——Agent Card、Task、Artifact 三抽象、streaming / push-notification / auth。它的视角是"两个独立 agent 如何在网络上互相通信"。
- **Multi-agent orchestration**（本篇）是**多 agent 之间的编排逻辑**——控制流、拓扑、依赖、生命周期、持久化。它的视角是"一个 orchestrator 如何把一堆 agent 协调起来完成一件事"。

三者正交：harness 可以单 agent 也可以带 orchestration；A2A 可以只是网络协议也可以被 orchestration 调用；orchestration 可以完全在一个进程内（LangGraph supervisor）也可以跨进程跨机器走 A2A（Google ADK + A2A 集成）。**生产级多 agent 系统是三者的叠加**，但讨论时要分开，不然会把"决策 = 拓扑选择"和"决策 = 传输层选择"混成一锅粥。

附带的观察：**OpenHands SDK** [S0084] 是一个把 harness / orchestration / tool-calling 三层都沉淀为可复用 SDK 的开源参考实现——在 Cursor / Claude Code / Codex 之外提供一个完整对照样本，值得做 architecture 调研时对比阅读。

---

## 10. 待解问题

- **拓扑选择的经验法则仍零散**。Google Research 的 180 次实验 [S0082] 给了 R²=0.513 的预测模型按任务属性选架构，但这是单次研究，尚未被独立复现。ADK 的 8 条模式 [S0072] 是目录，不是决策树。
- **多 agent 成本模型**：每个 subagent 独立 context 意味着成本线性扩展，但跨 agent 的信息冗余（多 agent 看同一 README）是隐性浪费。[concepts/a2a-protocol.md](a2a-protocol.md) §9 把成本分摊列为开放问题，这里同样悬空。
- **Meta-orchestrator 是否可行**。AOrchestra [S0081] 代表的自动派生方向目前效果有限；要做到"人只给目标、runtime 自己选拓扑 + 派生 agent + 挂 durable engine"还差一个量级。
- **异步 subagent 的监督 UX**。async subagent [S0076] 的 `list` / `check` / `cancel` 原语是 API 级别的，但人类怎么看 20 个后台 subagent 在跑什么——目前没公开产品形态。
- **Durable execution 和对话延迟的张力**。Inngest 说的"低延迟 durable endpoint" [S0079] 方向正确但实现稀少；目前 Temporal / Flyte / Inngest 的 overhead 都不足以支撑实时对话路径。
- **多 agent 辩论 / 对抗模式的空白**。当前所有成熟模式都是**协作式**（supervisor / hierarchical / pipeline），"两 agent 同题产出相反方案、第三方裁决"这类对抗机制公开实现几乎为零——MIRROR 的 Talker/Thinker 异步 deliberation [见 concepts/agent-dreaming.md §4] 是一个雏形但不是多 agent 对抗。这个方向还在等论文。

- **Agent-quality 不对称对终端用户不可感知**。Anthropic Project Deal [S0108] 在受控对照实验里发现：被 Haiku 4.5 代表的参与者每件商品平均比 Opus 4.5 用户少挣 $2.68 / 多花 $2.45（在 161 个跨 run 重复商品上 OLS + item/run 固定效应估计，p < 0.05），但事后满意度调查里他们对自己的 deal 与对手 Opus 用户给出的 fairness 评分几乎完全相同（4.06 vs 4.05），且 28 名跨 run 比较过两种 agent 的人里仅 17:11 偏好 Opus run（双边 sign test p=0.345）。意思是：**当 agent quality 在真实市场里出现差距时，被弱 agent 代表的人很可能根本意识不到自己在被宰**。这把 §1 的"拓扑选错代价大"再加一条新 dimension——multi-agent 系统的 fairness 评估不能依赖参与者主观反馈。Aggressive prompting 在同一实验里没产生统计显著效应，model quality 主导一切——意味着"让人通过 prompt 自救"的政策建议在这个机制下也站不住。这是 mythos 第一次有 agent-to-agent commerce 实证；后续值得跟 economist 文献（Imas/Lee/Misra 2025、Zhu et al. 2025）对照看。
- **LLM agent 的 Saga 框架缺位**。§5 提到 Saga 在多 agent 副作用回滚里的角色，但公开实现仍局限于设计模式——没有现成的 LLM-aware compensation 框架，每个团队需要为 high-stakes flow 手工定义 `execute + compensate`。一旦 agent 系统进入支付 / 工单 / 通信等不可幂等域，这块缺口会成为生产阻塞点。
- **框架收束信号（2026-05）**：跨厂商正在出现"主线迁移 / 工程收束"模式：(a) Microsoft AutoGen 自 2025-09-30 `python-v0.7.5` 后 8 个月无新 release [S0174]——58.2k stars 的研究框架进入维护态，Microsoft 的工程精力转到 microsoft/agent-framework（python-1.5.0 / dotnet-1.6.1，[S0171]）；(b) IBM ACP 协议在 2025-08-25 合并进 A2A under LF AI & Data，BeeAI Framework 作为 reference 实现纳入 LF 治理 [S0175]（详见 [a2a-protocol §8](a2a-protocol.md)）；(c) Google ADK 升 v2.0.0 GA [S0169]；(d) LangGraph 升 1.2.0 把 durable execution 覆盖到 error-handler resume [S0170]。**对 mythos 的含义**：multi-agent 框架地形在 2026-05 进入"明确赢家被识别 + 协议层归并"阶段，KB 应及时把"框架活跃度 / 维护态 / 迁移路径"信号纳入综述，不再只用首发时间评估框架重要性。
- **CrewAI 的"框架自带 Skills 包"信号**：CrewAI 1.14.5 [S0172] 已经把 official Skills 包（getting-started / design-agent / design-task / ask-docs 四件套）一键安装到 Claude Code / Cursor / Codex / Windsurf——这是 multi-agent 框架反过来给"上游 IDE agent"投喂操作纪律的首个公开样本，与 MS Agent Framework 原生支持 SKILL.md frontmatter [S0171] 一起，把 [agent operational discipline as cross-platform skill]（MAP 未成文概念）这条母题从"少数 CLAUDE.md 工件"升级为"框架级 first-class artifact"。

---

## 相关综述

- [concepts/harness.md](harness.md)：单 agent 的运行时设计；本篇 §3 / §5 / §8 / §9 多次跨引（state machine、watchdog、worktree 隔离）。
- [concepts/a2a-protocol.md](a2a-protocol.md)：跨 agent 网络协议；本篇 §5（task lifecycle 终止态）、§9 把 A2A 定位成正交维度。
- [concepts/memory.md](memory.md)：§5（不可变状态）与 §8（文件系统作协作层）跨了 memory 综述的"markdown as portable memory"脉络。
- [concepts/agent-dreaming.md](agent-dreaming.md)：§10 的"多 agent 对抗"引用了 MIRROR，属于 dreaming 的 talker/thinker 分工。

---

## 参考来源

本综述引用的所有 source，标识符 + 标题 + 内容类型 + 原始链接。点击 ID 可回到 `kb/sources/<file>.md` 读原文。

| ID | 类型 | 标题 | 链接 |
|----|------|------|------|
| [S0004](../sources/2025-06-13_anthropic-multi-agent-research.md) | blog | How we built our multi-agent research system | https://www.anthropic.com/engineering/multi-agent-research-system |
| [S0069](../sources/2026-04-07_claude-code-subagents-guide.md) | blog | Claude Code subagents guide | https://claude.com/blog/subagents-in-claude-code |
| [S0070](../sources/2026-04-21_codex-subagents-docs.md) | docs | Codex subagents (OpenAI docs) | https://developers.openai.com/codex/subagents |
| [S0071](../sources/2026-04-21_openai-agents-orchestration-handoffs.md) | docs | OpenAI Agents SDK: orchestration & handoffs | https://developers.openai.com/api/docs/guides/agents/orchestration |
| [S0072](../sources/2025-12-16_adk-multi-agent-patterns-guide.md) | blog | Developer's guide to multi-agent patterns in ADK | https://developers.googleblog.com/developers-guide-to-multi-agent-patterns-in-adk/ |
| [S0073](../sources/2026-04-21_adk-multi-agent-systems-docs.md) | docs | ADK multi-agent systems docs | https://adk.dev/agents/multi-agents/ |
| [S0074](../sources/2026-04-21_gemini-temporal-durable-agent.md) | docs | Gemini + Temporal durable agent tutorial | https://ai.google.dev/gemini-api/docs/temporal-example |
| [S0075](../sources/2026-04-21_langchain-deepagents-readme.md) | repo | langchain-ai/deepagents README | https://github.com/langchain-ai/deepagents |
| [S0076](../sources/2026-04-21_deepagents-async-subagents.md) | docs | deepagents async subagents | https://docs.langchain.com/oss/javascript/deepagents/async-subagents |
| [S0077](../sources/2026-04-21_langgraph-supervisor-python.md) | docs | langgraph-supervisor (Python) | https://reference.langchain.com/python/langgraph-supervisor |
| [S0078](../sources/2026-02-06_flyte-planner-agent-parallel.md) | blog | Flyte 2.0 planner agent + parallel DAG | https://www.union.ai/blog-post/build-a-planner-agent-system-with-parallel-execution-flyte-2-0-multi-agent-orchestration-with-union-ai |
| [S0079](../sources/2026-02-19_inngest-durable-execution-ai-agents.md) | blog | Durable execution is key to harnessing AI agents | https://www.inngest.com/blog/durable-execution-key-to-harnessing-ai-agents |
| [S0080](../sources/2026-01-12_tdp-task-decoupled-planning.md) | paper | TDP: Task-Decoupled Planning for long-horizon agents | https://arxiv.org/html/2601.07577v1 |
| [S0081](../sources/2026-02-07_aorchestra-automating-subagent-creation.md) | paper | AOrchestra: Automating subagent creation | https://arxiv.org/html/2602.03786v2 |
| [S0082](../sources/2026-01-28_google-science-scaling-agent-systems.md) | blog | Towards a science of scaling agent systems | https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/ |
| [S0083](../sources/2026-04-17_fs-researcher-test-time-scaling.md) | paper | FS-Researcher: filesystem as external memory | https://arxiv.org/pdf/2602.01566 |
| [S0084](../sources/2025-11-05_openhands-software-agent-sdk.md) | paper | OpenHands Software Agent SDK | https://arxiv.org/abs/2511.03690 |
| [S0085](../sources/2023-08-01_metagpt-multi-agent-framework.md) | paper | MetaGPT: SOP-encoded multi-agent framework | https://arxiv.org/abs/2308.00352 |
| [S0086](../sources/2025-06-10_pragmatic-cursor-deepdive.md) | blog | Real-world engineering challenges: building Cursor (Anyrun orchestrator) | https://newsletter.pragmaticengineer.com/p/cursor |
| [S0089](../sources/2026-04-08_databricks-multi-agent-bilibili.md) | unreachable | Databricks 资深工程师 Sandipan Bhaumik: 真正有效的多 Agent 架构（Bilibili 翻译再上传，无字幕） | https://www.bilibili.com/video/BV1jhogBwEzo/ |
| [S0090](../sources/2026-04-24_databricks-supervisor-agent.md) | docs | Databricks: Use Supervisor Agent to create a coordinated multi-agent system | https://docs.databricks.com/aws/en/generative-ai/agent-bricks/multi-agent-supervisor |
| [S0091](../sources/2026-02-24_databricks-multi-agent-apps.md) | docs | Databricks: Build a multi-agent system on Databricks Apps | https://docs.databricks.com/aws/en/generative-ai/agent-framework/multi-agent-apps |
| [S0108](../sources/2026-04-24_anthropic-project-deal.md) | blog | Project Deal: Our Claude-run marketplace experiment | https://www.anthropic.com/features/project-deal |
| [S0109](../sources/2026-04-29_cursor-typescript-sdk.md) | blog | Build programmatic agents with the Cursor SDK | https://cursor.com/blog/typescript-sdk |
| [S0169](../sources/2026-05-19_google-adk-2.0-ga.md) | release-notes | ADK 2.0.0 GA: Multi-Agent Workflow Engine + Dynamic Agent Collaboration | https://github.com/google/adk-python/releases/tag/v2.0.0 |
| [S0170](../sources/2026-05-12_langgraph-1.2.0.md) | release-notes | LangGraph 1.2.0: durable error-handler resume + delta channel checkpointing | https://github.com/langchain-ai/langgraph/releases/tag/1.2.0 |
| [S0171](../sources/2026-05-19_ms-agent-framework-python-1.5.0.md) | release-notes | Microsoft Agent Framework python-1.5.0 | https://github.com/microsoft/agent-framework/releases/tag/python-1.5.0 |
| [S0172](../sources/2026-05-20_crewai-framework-overview.md) | repo | CrewAI: Fast and Flexible Multi-Agent Automation Framework | https://github.com/crewAIInc/crewAI |
| [S0173](../sources/2026-05-16_hermes-v0.14.0-foundation-release.md) | release-notes | Hermes Agent v0.14.0: The Foundation Release | https://github.com/NousResearch/hermes-agent/releases/tag/v2026.5.16 |
| [S0174](../sources/2026-05-20_microsoft-autogen-overview.md) | repo | Microsoft AutoGen (release cadence stalled since 2025-09) | https://github.com/microsoft/autogen |
| [S0175](../sources/2026-05-20_beeai-framework-overview.md) | repo | BeeAI Framework (LF AI & Data, ACP→A2A merged) | https://github.com/i-am-bee/beeai-framework |
