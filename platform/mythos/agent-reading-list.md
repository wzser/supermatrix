# Agent 架构深度阅读清单

> 来源：ChatGPT 对话整理，2026-04-16 归档
> 主题：多 Agent 协同 Harness、Agent 记忆、Agent 做梦、A2A 协议

---

## 一、多 Agent 协同 Harness 架构

### Anthropic / Claude 官方

1. **How we built our multi-agent research system** — lead agent + parallel subagents + CitationAgent 生产链路拆解
   https://www.anthropic.com/research/building-multi-agent-research-system

2. **Harness design for long-running application development** — planner/generator/evaluator 三角色长周期 harness
   https://www.anthropic.com/engineering/harness-design-for-long-running-application-development

3. **Building a C compiler with a team of parallel Claudes** — 16 agent、2000 session、容器化并行开发实战
   https://www.anthropic.com/engineering/building-a-c-compiler-with-parallel-claudes

4. **Effective harnesses for long-running agents** — initializer agent + coding agent、clean-state handoff
   https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents

5. **Scaling Managed Agents: Decoupling the brain from the hands** — session/harness/sandbox 解耦，crash recovery
   https://www.anthropic.com/engineering/scaling-managed-agents

6. **Effective context engineering for AI agents** — just-in-time context、compaction、sub-agent clean context
   https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

7. **How and when to use subagents in Claude Code** — subagent 适用场景与反模式
   https://www.anthropic.com/engineering/how-and-when-to-use-subagents-in-claude-code

8. **Writing effective tools for agents — with agents** — tool schema 设计 = harness 的一部分
   https://www.anthropic.com/engineering/writing-effective-tools-for-agents

9. **Demystifying evals for AI agents** — agent harness 与 eval harness 的关系
   https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents

### Hermes Agent

10. **NousResearch/hermes-agent 官方仓库** — persistent/self-improving agent 代码结构
    https://github.com/NousResearch/hermes-agent

11. **Hermes Multi-Agent Umbrella (GitHub issue #344)** — 多 agent roadmap：DAG engine、synthesis aggregator
    https://github.com/NousResearch/hermes-agent/issues/344

12. **DataCamp: Nous Research Hermes Agent Setup and Tutorial Guide** — skills/gateway/delegate_task/MCP 串讲
    https://www.datacamp.com/tutorial/hermes-agent

### OpenClaw

13. **OpenClaw Gateway Architecture** — long-lived gateway 作为 control plane
    https://docs.openclaw.ai/concepts/gateway-architecture

14. **OpenClaw Multi-Agent Routing** — 多 agent 隔离 workspace/agentDir/bindings/auth
    https://docs.openclaw.ai/concepts/multi-agent-routing

15. **OpenClaw Session Tools** — agent list/read/send/spawn/yield session
    https://docs.openclaw.ai/concepts/session-tools

16. **OpenClaw ACP Agents** — 接入 Claude Code/Codex/Cursor/Copilot 等外部 harness
    https://docs.openclaw.ai/concepts/acp-agents

17. **OpenClaw Sub-Agents / sessions_spawn** — 子 agent 隔离 session 并行慢任务
    https://docs.openclaw.ai/concepts/sessions-spawn

18. **OpenClaw Delegate Architecture** — delegate agent 独立身份/凭证/standing orders
    https://docs.openclaw.ai/concepts/delegate-architecture

### 横向参考

19. **Magentic-One (Microsoft Research)** — Orchestrator + Task Ledger + 4 specialist agents 参考架构
    https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/

---

## 二、Agent 记忆（Memory）

### Anthropic

20. **Context engineering: memory, compaction, and tool clearing** — memory/compaction/tool clearing 边界，context rot
    https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

21. **Context editing (platform docs)** — 上下文编辑机制
    https://platform.claude.com/docs/en/build-with-claude/context-editing

22. **Long-running Claude for scientific computing** — CHANGELOG.md 作为 portable long-term memory
    https://www.anthropic.com/research/long-running-Claude

23. **Using agent memory (Research Preview)** — memory store API：durable learnings、immutable version、multi-store
    https://platform.claude.com/docs/en/managed-agents/memory

24. **Sub-agents docs** — memory isolation 关键机制
    https://code.claude.com/docs/en/sub-agents

25. **NIST RFI on Agentic Security** — persistent memory poisoning 安全风险
    https://www-cdn.anthropic.com/43ec7e770925deabc3f0bc1dbf0133769fd03812.pdf

### OpenAI

26. **Context Engineering for Personalization - Long-Term Memory Notes (Cookbook)** — 记忆生命周期：distillation/consolidation/forgetting/injection
    https://developers.openai.com/cookbook/examples/agents_sdk/context_personalization

27. **Run long horizon tasks with Codex** — durable project memory：spec/plan/constraints/status 固化到 markdown
    https://developers.openai.com/blog/run-long-horizon-tasks-with-codex

28. **Inside OpenAI's in-house data agent** — 企业内部 agent memory 实战，纠错/过滤条件存储
    https://openai.com/index/inside-our-in-house-data-agent/

### Google / AWS

29. **Architecting efficient context-aware multi-agent framework (Google)** — Working Context/Session/Memory/Artifacts 分层
    https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/

30. **Building smarter AI agents: AgentCore long-term memory deep dive (AWS)** — 工业级 memory pipeline
    https://aws.amazon.com/blogs/machine-learning/building-smarter-ai-agents-agentcore-long-term-memory-deep-dive/

31. **How AgentCore episodic memory works (AWS)** — experience-level memory 结构化
    https://aws.amazon.com/blogs/machine-learning/how-agentcore-episodic-memory-works/

### Microsoft Research

32. **PlugMem: From raw interaction to reusable knowledge** — memory → facts + skills 结构化知识
    https://www.microsoft.com/en-us/research/blog/from-raw-interaction-to-reusable-knowledge-rethinking-memory-for-ai-agents/

33. **CORPGEN advances AI agents for real work** — 多任务 memory isolation/tiered memory/adaptive summarization
    https://www.microsoft.com/en-us/research/blog/corpgen-advances-ai-agents-for-real-work/

34. **Memento: Teaching LLMs to Manage Their Own Context** — 模型内生记忆管理
    https://www.microsoft.com/en-us/research/articles/memento-teaching-llms-to-manage-their-own-context/

### Benchmark / Research

35. **MemoryArena** — 多 session memory benchmark
    https://arxiv.org/html/2602.16313v1

36. **AgentMemoryBench** — system memory + personal memory continual-learning 评测
    https://openreview.net/forum?id=MSXbrNExax

37. **MemAgents Workshop (ICLR 2026)** — agent memory 独立研究层
    https://openreview.net/forum?id=U51WxL382H

38. **CMV (Contextual Memory Virtualisation)** — 上下文记忆虚拟化
    https://arxiv.org/abs/2602.22402

### 补充

39. **LangChain: Context Engineering for Agents** — Karpathy 风格 context = RAM
    https://blog.langchain.com/context-engineering-for-agents/

40. **MorphLLM: Context Engineering** — Claude.md/lazy loading/subagent 工程总结
    https://www.morphllm.com/context-engineering

---

## 三、Agent 做梦（Dreaming / Sleep-time Compute）

### Letta（最核心）

41. **Sleep-time Compute (blog)** — downtime 里重写 memory state，primary agent + sleep-time agent
    https://www.letta.com/blog/sleep-time-compute

42. **Sleep-time Compute (论文)** — test-time compute 降至 ~1/5，含 agentic SWE case study
    https://arxiv.org/abs/2504.13171

43. **Sleep-time agents (docs)** — sleep-time agent 共享 memory blocks，按 N 步触发
    https://docs.letta.com/guides/agents/architectures/sleeptime/

44. **Letta Code Memory** — 周期性 dream subagent 反思对话
    https://docs.letta.com/letta-code/memory/

45. **Letta Code Subagents** — reflection 作为内建 subagent
    https://docs.letta.com/letta-code/subagents/

### OpenClaw

46. **Dreaming (experimental)** — light/deep/REM 三段 dreaming，DREAMS.md 人可读审查
    https://docs.openclaw.ai/concepts/dreaming

47. **Memory Overview** — promotion gates：score/recall frequency/query diversity
    https://docs.openclaw.ai/concepts/memory

48. **CLI memory** — memory promote/rem-harness/rem-backfill 运维命令
    https://docs.openclaw.ai/cli/memory

### 相关研究

49. **MIRROR** — Talker/Thinker 异步 deliberation
    https://arxiv.org/abs/2506.00430

50. **Trajectory-Informed Memory Generation (IBM)** — 从执行轨迹提炼可复用经验，+14.3%
    https://arxiv.org/abs/2603.10600

51. **ERL: Experiential Reflective Learning** — task trajectory → heuristics，+7.8%
    https://arxiv.org/abs/2603.24639

52. **Karpathy autoresearch** — agent 自动跑优化回路（改代码/训练/测指标/保留或丢弃）
    https://github.com/karpathy/autoresearch

---

## 四、Agent-to-Agent (A2A) 协议

### 官方核心

53. **A2A 官方文档** — Why A2A、A2A vs MCP、教程、SDK、samples
    https://a2aprotocol.ai/docs

54. **A2A 官方规范 (spec)** — Task 生命周期、Artifact、streaming、push notification
    https://a2aprotocol.ai/spec

55. **Google Developers Blog: Announcing the Agent2Agent Protocol** — 设计动机与第一性原则
    https://developers.googleblog.com/announcing-the-agent2agent-protocol-a2a/

### 项目拆解 / 实战

56. **A2A 官方 samples repo (a2a_mcp)** — MCP 作为 Agent Card registry，travel agent orchestration
    https://github.com/google/a2a-samples

57. **Google ADK with A2A docs** — 把现有 agent 暴露为 A2A 服务 / root agent 调 remote agent
    https://google.github.io/adk-docs/a2a/

58. **Google Developers Blog: Developer's Guide to AI Agent Protocols** — MCP + A2A + UCP 完整协议栈
    https://developers.googleblog.com/developers-guide-to-ai-agent-protocols/

59. **DeepLearning.AI: A2A The Agent2Agent Protocol** — 跨框架 hands-on：ADK/LangGraph/BeeAI/Microsoft Agent Framework
    https://www.deeplearning.ai/short-courses/a2a-agent2agent-protocol/

60. **IBM: Use the A2A Protocol for AI Agent Communication** — BeeAI + Ollama A2A client/server 实战
    https://developer.ibm.com/tutorials/use-a2a-protocol-for-ai-agent-communication/

61. **Elastic: Creating an LLM Agent newsroom with A2A and MCP** — 6 角色 agent newsroom 完整架构拆解
    https://www.elastic.co/blog/creating-llm-agent-newsroom-a2a-protocol-mcp-elasticsearch

### 平台落地

62. **Gemini Enterprise: Register and manage A2A agents** — Agent Card JSON 注册 + OAuth 访问控制
    https://cloud.google.com/gemini/docs/enterprise/register-manage-a2a-agents

63. **Microsoft: Integrating Semantic Kernel Python with A2A** — 跨云互通
    https://devblogs.microsoft.com/semantic-kernel/integrating-semantic-kernel-python-with-a2a/

64. **Microsoft: Building AI Agents with A2A .NET SDK** — A2A Inspector 调试
    https://devblogs.microsoft.com/dotnet/building-ai-agents-with-a2a-dotnet-sdk/

65. **Microsoft Agent Framework 1.0** — A2A/MCP 产品集成
    https://devblogs.microsoft.com/microsoft-agent-framework-1-0/

---

## 快速索引：各主题 TOP 5

### 多 Agent Harness TOP 5
1. Anthropic — How we built our multi-agent research system
2. Anthropic — Building a C compiler with parallel Claudes
3. Anthropic — Scaling Managed Agents
4. OpenClaw — Multi-Agent Routing + ACP Agents
5. Microsoft — Magentic-One

### Agent 记忆 TOP 5
1. Anthropic — Context engineering (memory/compaction/tool clearing)
2. OpenAI — Long-term memory notes (Cookbook)
3. Google — Context-aware multi-agent framework
4. AWS — AgentCore long-term memory deep dive
5. Microsoft — PlugMem

### Agent 做梦 TOP 4
1. Letta — Sleep-time Compute (blog + 论文)
2. OpenClaw — Dreaming (light/deep/REM)
3. Karpathy — autoresearch
4. MIRROR — 异步 deliberation

### A2A 协议 TOP 5
1. A2A 官方文档 + 规范
2. Google — Developer's Guide to AI Agent Protocols
3. Elastic — LLM Agent newsroom 完整拆解
4. DeepLearning.AI — 跨框架 hands-on 课程
5. IBM — BeeAI + Ollama 实战教程

---

*共计 65 条链接，归档完成。*
