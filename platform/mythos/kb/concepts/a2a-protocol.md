---
last_updated: 2026-05-20
confidence: medium
refresh_cadence: event-driven
parent: null
children: []
unwritten_children:
  - cross-agent-cost-model: "跨 agent 调用的成本分摊 / 预算闸门，目前在 §9 列为开放问题"
  - protocol-ucp: "User Control Plane（Google 提及但 source 不足），目前在 MAP 待成文清单"
boundary_with:
  - multi-agent-orchestration: "A2A 是网络传输层；多 agent 编排的控制流 / 拓扑 / 生命周期进编排综述"
  - harness: "harness 内部如何表达远端 agent 是开放问题；A2A 给 agent↔agent 规范"
---

# A2A Protocol（Agent-to-Agent Protocol）

---

## 1. 为什么需要 A2A：和 MCP 不是同一层

过去两年行业先收敛了一个协议：**MCP（Model Context Protocol）**——模型如何调用工具、读取资源。但 MCP 解决的是"一个 agent 连接众多 tools"的问题，不解决"多个 agent 之间如何协作"。当系统里出现**多个独立 agent**（不同团队开发、不同模型驱动、不同云部署），你需要的是另一层协议：**A2A**。

Google 在 2025 年 4 月正式发起 A2A 协议 [S0057]，随后成为跨厂商共识：

- Google ADK 原生支持把 agent 暴露为 A2A 服务 [S0059]
- Microsoft Semantic Kernel Python 官方集成 [S0065]；社区嘉宾文章覆盖 SK + A2A 多 agent 模式 [S0066]；Agent Framework 1.0（.NET + Python）把 A2A 列为 "coming soon" [S0067]
- IBM Think 发布 A2A 实操教程（搭 chat client → A2A server → agent 的最小链路）[S0062]
- Gemini Enterprise 提供 agent card 注册 + OAuth 管控 [S0064]
- DeepLearning.AI 开设跨框架 hands-on 课程 [S0061]

**MCP 与 A2A 的关系不是替代而是分层** [S0060]：
- **MCP**：agent ↔ tools / resources（一个 agent 内部）
- **A2A**：agent ↔ agent（多个 agent 之间）
- **UCP** (User Control Plane)：user ↔ agent system（可选第三层）

Google 在 protocol stack guide 里把这三条栈成完整的 agent 通信协议栈 [S0060]。

---

## 2. 核心抽象：Agent Card + Task + Artifact

A2A 的底层设计抽象数量极少，这是它能跨厂商的原因之一 [S0055] [S0056]。

**Agent Card** 是一份 JSON 描述，声明 agent 的：
- 身份（name、version、maintainer）
- 能力（skills、支持的 input/output 模态）
- 端点（服务 URL、认证方式）
- SLA（超时、并发上限）

类比：Agent Card 之于 agent，如同 OpenAPI 之于 HTTP API。它让其他 agent 无需看源码就能判断"这个 agent 能干什么、怎么调用"。Gemini Enterprise 把 Agent Card 做成平台级注册实体，配合 OAuth 控制谁能调谁 [S0064]。

**Task** 是 A2A 的工作单元。生命周期 [S0056]：
1. 创建（client agent 向 server agent 提交）
2. 进行中（可 streaming 返回中间状态）
3. 完成 / 失败 / 取消
4. 产出物（artifact）交付

Task 自带状态机，所有框架共享，避免每家自己发明一套。

**Artifact** 是 task 的产出：文件、结构化数据、引用链接。A2A 明确把 artifact 和 message 分开——message 是 agent 之间的自然语言对话，artifact 是可被其他系统消费的数据制品 [S0056]。

**Streaming + Push Notification**：task 可能长跑（分钟到小时级），协议原生支持 SSE streaming 和 webhook push [S0056]。这是把 A2A 和"同步 HTTP call"区分开的关键。

---

## 3. MCP 作为 A2A 的发现层

一个精巧的设计出现在 Google 官方 samples repo [S0058]：用 **MCP 作为 Agent Card registry**。意思是：

- MCP server 托管一批 Agent Card（作为 resource）
- client agent 通过 MCP `list_resources` 发现可用 agent
- 拿到 Agent Card 后，通过 A2A 调用对应 agent

这把 MCP 和 A2A 优雅地串起来：MCP 解决"发现"，A2A 解决"调用"。travel agent orchestration 示例里，一个 main agent 通过这个机制动态发现 hotel/flight/car rental 等 specialist agent，按需编排 [S0058]。

---

## 4. 实战案例：Elastic 的 Agent Newsroom

Elastic 在 2025 年 11 月公开的 agent newsroom 案例是目前最完整的 A2A 生产案例 [S0063]：**6 个角色 agent，跨 MCP + A2A + Elasticsearch 完整链路**。

角色分工（原文命名）：
- **News Chief**（协调者 / client agent）：分发选题、编排整条工作流
- **Reporter Agent**：基于 research 和访谈撰写稿件
- **Researcher Agent**：搜集事实、统计、背景资料
- **Archive Agent**：用 Elasticsearch 检索历史稿件并识别趋势
- **Editor Agent**：审核质量、风格、SEO
- **Publisher Agent**：经 CI/CD 发布到博客平台

在 A2A 术语里 News Chief 是 client agent，其余 5 个是 remote agents；每个 agent 还能通过 MCP 挂自己的工具栈（Researcher → News API / Fact-Checking / 学术库；Reporter → Style Guide / Template / Image Library；Editor → Grammar / Plagiarism / SEO；Publisher → CMS / CI/CD / Analytics），把 A2A（team coordination）和 MCP（tool access）分层很清晰 [S0063]。这个架构展示了 A2A 的典型价值：**每个 agent 可以独立进化、独立部署、甚至由不同团队维护**，但通过 A2A 协议无缝协作。News Chief 不需要知道 Reporter 背后用的是哪个模型、哪家框架，只要对方遵循 A2A 就能调。

---

## 5. 企业场景：Agent 注册与治理

Gemini Enterprise 给了 A2A 在企业治理下的一个标准形态 [S0064]：

- **Agent 注册表**：每个 A2A agent 必须注册 Agent Card 到平台
- **OAuth 访问控制**：谁能调用某个 agent、能调用哪些 skill，通过 OAuth scope 管理
- **审计日志**：所有 A2A call 落盘，可溯源

这是把 A2A 从"开发者自由互连"升级到"企业可审计 agent 网络"。Microsoft Agent Framework 1.0 走的是类似思路——把 A2A 和 MCP 都列为平台原语（A2A 1.0 支持"coming soon"），并捆绑 OpenTelemetry 做统一 observability [S0067]。

---

## 6. 跨框架互通的现实

A2A 的承诺是"不绑定框架"，2025 年下半年各家的跟进证明了这不是空话：

- **Google ADK**：原生 export agent 为 A2A 服务 [S0059]
- **Microsoft Semantic Kernel Python**：以 A2A server 对外暴露 SK 多 agent（示例里 `SemanticKernelTravelManager` + 底层 CurrencyExchange / ActivityPlanner agent），client 端用 A2A 官方 `hosts/cli`；是目前 SK 官方 A2A 集成样例 [S0065]
- **Microsoft SK + A2A 多 agent 模式**（社区嘉宾博客）：用 Azure AI Foundry 做中央路由 + 多协议 agent（A2A HTTP/JSON-RPC / STDIO / MCP 混跑）的架构模式 [S0066]
- **IBM Think 教程**：HTTP + JSON-RPC 2.0 + SSE 把通信层与 agent 逻辑解耦——换模型/改 tool 不必改 client [S0062]
- **DeepLearning.AI 课程**：ADK / LangGraph / BeeAI / Microsoft Agent Framework 四个框架的 hands-on [S0061]

换言之：**如果你今天写一个新的 agent，把它暴露为 A2A 端点是比"给它写 REST API"更标准的做法**。

---

## 7. A2A 与 harness 的关系

A2A 是**跨 harness 的通信协议**，不是 harness 的替代。对照 [concepts/harness.md](harness.md) 里的讨论：

- 一个 agent 内部：harness 管 LLM、context、tools、memory
- 多个 agent 之间：A2A 协议规定 task 生命周期、artifact 格式、streaming 语义

两者正交。一个 Claude Code harness 可以通过 A2A 调用一个 Semantic Kernel harness，反之亦然。harness 关注的是**单个 agent 的工程化运行时**，A2A 关注的是**多个 agent 的协作接口**。

这也意味着：A2A 不解决 context rot、不解决 memory 管理、不解决 crash recovery——这些依然是各自 harness 的责任。A2A 的职责是确保"当 agent A 把 subtask 交给 agent B 时，双方对协议的理解一致"。

---

## 8. 与 OpenClaw ACP / Hermes 多 agent 的对比

A2A 不是唯一的多 agent 协议尝试。相关路线：

- **OpenClaw ACP Agents** [S0019]：focus 在接入 Claude Code / Codex / Cursor / Copilot 等外部 harness，把它们当成"agent"纳入一个 session 体系。更像 harness-level 互通协议。
- **Hermes Multi-Agent Umbrella** [S0014]：NousResearch 路线，侧重 DAG engine + synthesis aggregator，协议层相对内部。Hermes 2026-05-16 v0.14.0 Foundation Release 进一步把这条内部协议 + 外部 IDE 接入的边界打通——通过 OpenAI-compatible 本地 proxy 把任意 OAuth-authed Hermes provider 暴露为 OpenAI endpoint，让 Codex / Aider / Cline / Continue 直接接入 [S0173]。这是 NousResearch 自己路线下"协议 → 桥"的实现，与 A2A 中立传输层的路线正交。
- **Magentic-One** [S0022]：Microsoft Research 的单一 orchestrator + specialist agents 架构，不强调跨组织协议。

**协议收束信号（2026-05）：** IBM 原作的 **ACP（Agent Communication Protocol）于 2025-08-25 正式合并进 A2A under Linux Foundation** [S0175]——这是三路竞争（A2A / ACP / Hermes DAG）在 LF 治理层的实际收束。BeeAI Framework（IBM/LF）作为 ACP 的原始 reference 实现，现在原生集成 ACP + MCP 双协议，承担"A2A 的 LF 侧 Python/TypeScript 双语 reference"角色。这把 §6 "跨框架互通的现实"由"还在打通"实质性推进到"协议归并完成、reference 实现存在"。

A2A 的独特定位是：**不绑定单一编排 pattern、不绑定单一框架、不绑定单一 vendor**。它更接近"HTTP for agents"——中立的传输层。上面可以架 orchestrator / DAG / market place 等各种编排风格。

---

## 9. 待解问题

- **Trust 与身份**：A2A 目前靠 OAuth + Agent Card，但 agent 的"身份"在 LLM 驱动下是可伪造的（prompt injection 可以让 agent 自称任何身份）。跨组织的 zero-trust agent 互通尚无成熟方案。
- **计费与成本分摊**：当 agent A 调 agent B，B 的 token 成本归谁？目前各家平台各自为政。
- **长任务的可靠性**：A2A 支持 streaming 和 push，但长跑 task 的 checkpoint / resume 语义在 spec 里仍然模糊 [S0056]。
- **Agent Card 的语义漂移**：声明的 capability 和真实能力会因模型版本漂移；没有标准化 benchmark 验证 Agent Card 的"属实性"。
- **多 agent memory 共享**：A2A 协议层面几乎不碰 memory——两个 agent 协作时，应不应该共享记忆？（详见 [concepts/memory.md](memory.md) §3）。
- **和 UCP 的边界**：Google 提到的 UCP（User Control Plane）尚未形成独立规范 [S0060]。用户如何在多 agent 网络中"打断、监督、覆盖"是开放问题。

---

## 相关综述

- [concepts/harness.md](harness.md)：A2A 是跨 harness 的协议层，不是 harness 的替代；两者层级互补。
- [concepts/memory.md](memory.md)：跨 agent 的 memory 共享是 A2A 尚未覆盖的缺口。
- [concepts/agent-dreaming.md](agent-dreaming.md)：多 agent 网络里的 dreaming 是尚未被 A2A 规范涉及的开放方向。

---

## 参考来源

本综述引用的所有 source，标识符 + 标题 + 内容类型 + 原始链接。点击 ID 可回到 `kb/sources/<file>.md` 读原文。

| ID | 类型 | 标题 | 链接 |
|----|------|------|------|
| [S0014](../sources/2025-12-01_hermes-multi-agent-umbrella.md) | docs | Hermes Multi-Agent Umbrella (GitHub issue #344) | https://github.com/NousResearch/hermes-agent/issues/344 |
| [S0019](../sources/2026-01-10_openclaw-acp-agents.md) | docs | ACP Agents — OpenClaw | https://openclaws.io/docs/tools/acp-agents |
| [S0022](../sources/2024-11-04_microsoft-magentic-one.md) | blog | Magentic-One (Microsoft Research) | https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/ |
| [S0055](../sources/2025-12-01_a2a-official-docs.md) | docs | A2A 官方文档 | https://a2aprotocol.ai/docs |
| [S0056](../sources/2025-12-01_a2a-official-spec.md) | docs | Agent2Agent (A2A) Protocol Specification | https://a2a-protocol.org/latest/specification/ |
| [S0057](../sources/2025-04-09_google-a2a-announcement.md) | blog | Announcing the Agent2Agent Protocol (A2A) — A new era of agent interoperability | https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/ |
| [S0058](../sources/2026-04-16_google-a2a-samples.md) | repo | a2aproject/a2a-samples — Samples using the Agent2Agent (A2A) Protocol | https://github.com/a2aproject/a2a-samples |
| [S0059](../sources/2025-10-01_google-adk-a2a.md) | docs | Google ADK with A2A docs | https://google.github.io/adk-docs/a2a/ |
| [S0060](../sources/2025-11-01_google-agent-protocols-guide.md) | blog | Google Developers Blog: Developer's Guide to AI Agent Protocols | https://developers.googleblog.com/developers-guide-to-ai-agent-protocols/ |
| [S0061](../sources/2025-11-15_deeplearning-a2a-course.md) | tutorial | A2A: The Agent2Agent Protocol — DeepLearning.AI short course | https://www.deeplearning.ai/short-courses/a2a-the-agent2agent-protocol/ |
| [S0062](../sources/2025-10-20_ibm-a2a-beeai.md) | tutorial | Use the A2A Protocol for AI Agent Communication (IBM Think) | https://www.ibm.com/think/tutorials/use-a2a-protocol-for-ai-agent-communication |
| [S0063](../sources/2025-11-01_elastic-a2a-newsroom.md) | blog | A2A Protocol and MCP: Creating an LLM Agent newsroom in Elasticsearch | https://www.elastic.co/search-labs/blog/a2a-protocol-mcp-llm-agent-newsroom-elasticsearch |
| [S0064](../sources/2025-12-01_gemini-enterprise-a2a.md) | docs | Register and manage A2A agents — Gemini Enterprise docs | https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-a2a-agent |
| [S0065](../sources/2025-10-15_microsoft-semantic-kernel-a2a.md) | blog | Integrating Semantic Kernel Python with Google's A2A Protocol | https://devblogs.microsoft.com/foundry/semantic-kernel-a2a-integration/ |
| [S0066](../sources/2025-11-01_microsoft-a2a-dotnet.md) | blog | Building Multi-Agent Solutions with Semantic Kernel and A2A Protocol (MS Agent Framework guest blog) | https://devblogs.microsoft.com/agent-framework/guest-blog-building-multi-agent-solutions-with-semantic-kernel-and-a2a-protocol/ |
| [S0067](../sources/2025-12-01_microsoft-agent-framework-1.md) | blog | Microsoft Agent Framework Version 1.0 | https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/ |
| [S0173](../sources/2026-05-16_hermes-v0.14.0-foundation-release.md) | release-notes | Hermes Agent v0.14.0: The Foundation Release | https://github.com/NousResearch/hermes-agent/releases/tag/v2026.5.16 |
| [S0175](../sources/2026-05-20_beeai-framework-overview.md) | repo | BeeAI Framework (LF AI & Data, ACP→A2A merged) | https://github.com/i-am-bee/beeai-framework |
