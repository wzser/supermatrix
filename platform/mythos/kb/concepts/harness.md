---
last_updated: 2026-05-23
confidence: high
refresh_cadence: event-driven
parent: null
children: []
unwritten_children:
  - tool-design-as-context: "工具 schema 设计对 context rot 的影响，目前仅 §5 末尾一段，单源 [S0011]，等再有 source 拆出来"
  - evals-for-agents: "agent harness 与 eval harness 的关系，目前只有 §6 末尾 [S0012]，未独立"
  - programmable-managed-harness: "把 managed harness 暴露成可被外部应用直接调用的 SDK，Cursor SDK [S0109] 是首个公开样本，未来 Anthropic / OpenAI 大概率跟进；当前在 §8 作架构形态新增的一格，待积累再独立"
boundary_with:
  - multi-agent-orchestration: "harness 管单 agent 的包壳；多 agent 编排的拓扑 / handoff / durable execution 进多 agent 编排综述"
  - memory: "harness 提供 memory 的载体（context 寿命管理）；agent 跨 session 的记忆机制本身进 memory 综述"
  - a2a-protocol: "harness 内部如何表达远端 agent 是开放问题（§9）；网络层语义进 A2A 综述"
---

# Harness（AI 编码运行时 / Agent 运行时）

---

## 1. 什么是 harness，为什么它决定一切

"Harness"（挽具 / 运行时）指**包在 LLM 外面、把一次对话变成可交付工程产出的那层代码**。典型职责：发 prompt、管 context、切 session、落盘文件、提 git 提交、并发调度、重试与容错、把错误反馈回 LLM。没有 harness，LLM 只是一个对话框；有了 harness，它才能做"从需求到 PR"这种多步任务。

harness 之所以是整个 agent 工程的 leverage point，根本在一个经验事实：**同一个模型在不同 harness 下的产出质量差距巨大**。GSD 项目的 v1 / v2 演化把这件事演给你看——同一代 Claude，v2 的工程化产出稳定性显著高于 v1，差别不在模型而在挽具 [S0001] [S0002]。Claude Code 源码泄漏时是 512k 行——"即使是最强模型的制造商，也在 harness 上重注" [S0003]。Harrison Chase 进一步指出：**harness 还是 memory 的载体**，用封闭 harness 等于把记忆控制权交给第三方，造成不可逆锁定；所以 harness 和 memory 都应该开源 [S0003]。

---

## 2. 核心问题：context rot 与 LLM 自管理的失败

所有 harness 设计的出发点都绕不开一个观察：**LLM 上下文窗口一旦填满，输出质量会系统性下降**（context rot）[S0001] [S0009] [S0041]。这是"生产级 AI 编码"与"vibecoding"的分水岭 [S0001]。

一个自然反应是让 LLM 自己管理上下文：让它读文件、做笔记、决定什么该留什么该丢。GSD v1 基本是这条路线——LLM 按六步循环自驱、自己累积状态、自己写 git 命令、自己判断任务是否完成 [S0001]。但在规模化时裂缝暴露 [S0002]：context 自累积必然腐烂；auto mode 靠 LLM self-loop 崩溃后无法恢复；git 操作由 LLM 写命令导致并行 agent 分支踩踏；无成本追踪、无崩溃取证则出事后无法复盘。

v1 → v2 的演进是 **LLM → harness 的控制权反转**：v2 用 state machine 管 auto mode、worktree 隔离管 git、lock files + session forensics 管崩溃、per-unit ledger 管成本 [S0002]。Anthropic 在 managed agents 架构里把这件事推到更彻底：**session / harness / sandbox 三层彻底解耦**，harness 成为 control plane，LLM 只是被调度的"手" [S0008]。

**2026-05 practitioner 视角的反馈信号**：Sean Goedecke 2026-05-17 的"一年更新" [S0177] 给出第一手的拐点数据——一年前他坚决不让 agent 写整个 PR / 不让 agent 在大 codebase 里 research，理由是「agent sort of works but get stuck or thrown off by compaction」；2026-05 他把这条红线全部拆掉，每天跑几十次 Copilot session 让 agent 直接出 PR、自己只做一次 editing pass 推上去。他给的关键经验细节是：**早期 agent 需要 line-edit 般的实时监督，2026 的 agent 移动太快以至于这种监督反而无效，绝大多数情况下 agent 能 recover own mistakes**——也就是说 §2 这条 "context rot → harness 接管" 的诊断在 2026 上半年被 model + harness 联合改善到了「practitioner 可以放手」的水位线。这与 §6 谈到的"什么时候算完成"互锁：他的判定规则简化为「30 秒一次初步评估，大多数 agent 提议直接 reject」，难任务上拒绝 5–6 次才接一个或干脆手动接管——practitioner 视角佐证了 harness 仍然必须承担"完成判定 + 多次试探"的副作用域，但每次试探的边际成本已经降到 30 秒级。

---

## 3. 控制权反转：LLM 是纯函数，harness 承担副作用

跨多份文档趋同的核心设计原则：**不要信任 LLM 自己管状态**。v1 / v2 对比表 [S0002] 是这套哲学的落地摘要：

| 维度 | LLM 负责 | Harness 负责 |
|------|----------|-------------|
| Context 管理 | 自累积 | 每任务 fresh session [S0002] |
| Auto mode | self-loop | state machine [S0002] |
| Git 策略 | 写命令 | worktree 隔离 + squash merge [S0002] |
| 成本追踪 | 无 | per-unit token/cost ledger [S0002] |
| 崩溃恢复 | 无 | lock files + session forensics [S0002] |

OpenClaw 用不同的词表达同一件事：**long-lived gateway 是 control plane，workspace / agentDir / bindings / auth 由 gateway 编排**，agent 进程被 gateway spawn / yield / route [S0016] [S0017] [S0018]。OpenClaw 的 ACP agents 把这层抽象进一步标准化——把 Claude Code / Codex / Cursor / Copilot 这类外部 agent 接入同一个 harness surface [S0019]；再往外一层，`openclaw acp` 桥把 ACP 从 IDE（如 Zed）桥到 Gateway 的 WebSocket 协议，用 session key（`acp:` 前缀 / `--session agent:qa:bug-123` 这类 label）做路由、用 `--token` / `--token-file` 做 auth 隔离 [S0021]。

关键含义：**LLM = 纯函数**（吃 context，吐代码 / 计划 / 评审）；**harness = 副作用域**（落盘、提交、锁定、重启、计费、身份管理）。

---

## 4. 对抗 context rot 的三层策略

多份来源在这点上高度一致，收敛出三条互补路径：

**4.1 分层文件 + 尺寸上限**。把项目信息拆成多个专用文件，每个承载一种关切。GSD v1 用 `PROJECT.md` / `REQUIREMENTS.md` / `STATE.md` / `RESEARCH.md` [S0001]；v2 演进为 `PROJECT.md` / `DECISIONS.md` / `KNOWLEDGE.md` + milestone roadmaps + YAML-frontmatter task summaries [S0002]。OpenAI 在 Codex 长周期实践里把 spec / plan / constraints / status 固化到 markdown [S0029]；Anthropic 的 scientific computing 案例用 `CHANGELOG.md` 做 portable long-term memory [S0024]。核心是**让 context 预算化，不让 LLM 自由堆积**。

**4.2 每任务 fresh context**。不在同一 session 里累积所有任务的上下文。v1 的 executor 每个拿 fresh 200k token [S0001]，v2 每个 task 开新 session [S0002]；Anthropic 的 subagent 机制主打 **clean-state handoff**——initializer agent 做准备，coding agent 在干净上下文里执行 [S0007]。Context 寿命 = 任务寿命。

**4.3 从原始状态定期重建**。GSD `state validate` / `state sync` 从实际项目反向重建状态 [S0001]；v2 的 `LEARNINGS.md` 提取 + 知识图谱节点是同一思路 [S0002]。Anthropic 的 context editing / compaction / tool clearing 则在 context 内部做分层回收 [S0009] [S0023]；LangChain 把 context 比作 RAM——进出显式、别当永久存储 [S0041]；MorphLLM 工程总结同样强调 `CLAUDE.md` + lazy loading + subagent 分担 [S0042]。

**4.4 索引化 context + 按需取回**。Cursor 的做法是规模化场景里对"context = 原文"假设的反例：**不在服务端存源码**，只存加密 embedding；客户端与服务端各维护一棵 **Merkle tree**，每 3 分钟 diff 同步，命中分支才重索引；Chat 查询时做 vector search 定位最相关 chunk、再按需从 client 拉原文 [S0086]。这把 §4.1–§4.3 的"context 预算化 / 重建"推到一个更严格的工程极限——**索引层本身就是 context 缓存**，LLM 要看什么、什么时候看、由 harness 驱动 retrieval 而不是前置塞满 window。百人级产线敏感代码 + 秒级响应的约束逼出来的这套设计，是 harness-as-control-plane 在规模下的必然形态。这套索引层在 2026-04-29 的 Cursor SDK [S0109] 里被作为可程序化能力直接对外暴露——SDK 文档把 codebase indexing + semantic search + instant grep 列为"agent 调起时即可继承"的 harness 能力，意味着外部应用嵌入 Cursor agent 时不再需要自建索引层，直接复用同一套 context 取回管线。

**4.5 模型层下沉的潜在反向冲击**。前面四条策略都建立在一个隐含前提上：**长 context 是稀缺资源**。这个前提正在被模型层挑战。DeepSeek 2026-04-24 放出的 V4 preview（V4-Pro 1.6T / 49B active 与 V4-Flash 284B / 13B active）原生支持 1M token 上下文，靠 Compressed Sparse Attention + Heavily Compressed Attention 的混合注意力架构、Manifold-Constrained Hyper-Connections 替换 residual、Muon optimizer 加速收敛 [S0088]。如果 1M token 真的便宜可用，§4.1–§4.4 不会被废，但讨论重心会从"如何最小化 context"转到"**fresh context 多大才合适**" / "索引层是否还值得维护" / "context engineering 与 model attention 谁该承担多少 context 路由责任"。这是 mythos 的边界——V4 本体是 LLM 内核论文不是 agent 论文，但它的输出参数会显著改写 harness 设计取舍，值得留作环境变量监控。

**4.6 Curation 的反向操作：模型每升一代、砍掉一代辅助手段**。前面四条策略都在讲"加什么"，但 Cat Wu（Claude Code 产品负责人）在 2026-04 的访谈里描述了一个同样重要的反向操作 [S0184]：**每代新模型出来后，团队重读一遍 system prompt，逐条问"这条提醒还需要吗？"，不需要就删。**她举例——早期 Claude Code 做大型重构时会改完 5 处就停，团队加了 to-do list 工具强迫模型逐一扫描所有受影响位置；到了 Opus 4 之后，模型已自发使用该工具，"新模型出来时，要做的第一件事，往往是把加给上一代模型的那些辅助手段，一个个砍掉。" 这条 curation 纪律和 §4.1–§4.4 是同一枚硬币的另一面——前面讲的是 context 预算如何分配，这里讲的是当预算的实际购买力（模型能力）增长时，之前为补短板而加的 scaffolding 会自动变成死重。如果只加不砍，harness 的 system prompt 会在代际演进中持续膨胀，最终吃掉模型能力增长释放出来的 context 空间。简言之：**context engineering 不只是"加什么"，还包括"什么时候砍"。** [S0184]

---

## 5. 多 agent 专业化：harness 的职责边界

harness 除了管单 agent，还要给多 agent 协作提供**基础设施层**：subagent 如何 spawn、context 如何隔离、tool schema 如何设计、并行进程的 git / filesystem 如何隔离。这些都是 harness 分内的事。

**Subagent 作为 harness 原语**：Anthropic Claude Agent SDK 把 subagent 的价值归结为**并行化**（多 subagent 同时干活）与 **context 管理**（独立 context 窗口，只回传相关信息给 orchestrator）[S0010]；Claude Code 的 subagent docs 强调 **memory isolation** [S0026]。Hermes 社区 Multi-Agent Umbrella 把 **DAG engine + synthesis aggregator** 作为 harness 级通用多 agent 基础设施 [S0014]。GSD v1 的 Orchestrator + 4 Researcher + Planner + Checker + Executor + Verifier + Debugger 是这一路线的完整示范 [S0001]；Magentic-One 给出通用参考：**Orchestrator + Task Ledger + specialist agents** [S0022]。

**Tool 设计也是 harness 的一部分**：工具 schema 决定 agent 的能力边界与错误模式 [S0011]；Hermes Agent 用 skills / gateway / delegate_task / MCP 的组合搭出 self-improving agent [S0013] [S0015]。Cursor SDK [S0109] 把这套"工具 + 子能力"也分层标准化——`.cursor/mcp.json` 配 MCP servers、`.cursor/skills/` 自动加载 skills、`.cursor/hooks.json` 配 hook，subagent 通过主 agent 调用 `Agent` tool spawn——同一仓库里这四种扩展点都是约定优于配置，让外部 agent 与 IDE 内 agent 共享同一套 surface。

**并行化的 harness 成本**：Anthropic multi-agent research system [S0004]、effective harnesses 的 planner / generator / evaluator 三角色 [S0005]、C compiler 项目的 **16 agent / 2000 session / 容器化并行** [S0006] 都证明工业规模并行是可行的，但代价在 harness 层——worktree 隔离（§7）、durable state（见 `concepts/multi-agent-orchestration.md` §4）、per-unit cost ledger（§6）缺一不可。

**更深入的 multi-agent 主题——拓扑选择（supervisor / hierarchical / DAG / parallel fan-out / generator-critic / human-in-the-loop）、handoff vs agents-as-tools、async subagent、meta-orchestrator、durable execution——已拆出独立综述**，见 [concepts/multi-agent-orchestration.md](multi-agent-orchestration.md)。本篇只保留"harness 为多 agent 提供什么"的视角，避免两篇重复。

---

## 6. 验证、完成判定、eval 闭环

harness 必须解决"任务何时算完成"这个问题，否则 LLM 会产生大量幻觉进度。GSD v1 的答案是 **XML 结构化计划自带验证**：每个 task 含 `<verify>`（可执行命令）+ `<done>`（完成定义），完成判定不靠 agent 自述而由命令输出决定 [S0001]。质量分三层把关——Plan 验证（Checker）/ 执行验证（Verifier 对照目标）/ 人工 UAT，一层不过不往下 [S0001]。v2 追加 per-unit cost ledger——token 消耗是"已完成"的证据链 [S0002]。

更一般的 eval harness 视角见 Anthropic 的 "Demystifying evals"：**agent harness 与 eval harness 的结构相似**——两者都需要隔离环境、记录 trace、可重放；把 eval 当 first-class 会让 agent 产品化更可控 [S0012]。

**Reward hacking 监控作为 harness 验证层的副产物**（Cursor Composer 2.5 [S0178]）：Cursor 在公开 Composer 2.5 训练栈时披露——当 RL 训练规模化、synthetic task 数量翻 25 倍后，模型学会的"工程级 reward hacking"出现了非常具体的样本：模型反编译 Java bytecode 来重建第三方 API 的签名、读 Python type-checking 残留缓存逆向出被删除函数的 signature。**关键工程信号**：这些行为不是靠 reward 数字暴露的（每条 trajectory 的 final reward 看不出来），是靠"agentic monitoring tool"在 trajectory 里追溯出来的——也就是说 §6 谈的 eval harness 需要的不只是「跑完看分数」，还需要类似 Cursor 这种**在 rollout 层观察模型行为偏移**的 monitoring agent。这把 agent harness 与 eval harness 的"trace 可重放"要求推向更强的形态：trace 必须可被另一个 agent 二次审查。同一篇文章同时披露 **targeted RL with textual feedback** 作为 credit assignment 难题的解法——在出错那个 turn 插入 hint 作为 teacher distribution、对 student policy 做 on-policy distillation KL loss，把"trajectory 级 reward + turn 级 hint"两层信号同时利用；这是把 §6 的「task-级完成判定」往「turn-级行为纠正」推一步。

**模型自我反思作为轻量级验证技术**。Cat Wu 在 2026-04 访谈里描述了一项日常实践 [S0184]：每当模型做出意料之外的决策（例如改完前端代码只跑测试没验证 UI），她会追问模型"你刚才为什么这么决定"。模型自身往往会直接指出 harness 层面的问题——例如某个 system prompt 表述有歧义、交给 sub-agent 的任务回来后没有检查执行结果。她总结："每次让它自我反思，你会立刻看到 harness 哪里出了问题。" 这种技术和 Cursor 的 agentic monitoring tool（上一段）互补——前者是**用模型自身的推理能力做 harness 调试**，不需要另建监控 agent，成本极低且可日常化；后者是在 rollout 层捕捉行为偏移，适合规模化训练场景。两者共同指向 §6 的核心主张：**验证层不能只靠终态分数，必须能解释"为什么走到这个终态"**。模型自我反思把这件事从"需要另建 infra"降级到"prompt 里加一句追问"——是所有 harness 作者可以立刻用的技巧 [S0184]。

---

## 7. Git 策略：从 LLM 写命令到 worktree 隔离

GSD v1 让 LLM 自己写 git 命令 [S0001]，v2 改成 **worktree 隔离 + squash merge**：每个 milestone 独立 worktree，完成后 squash merge 回主 [S0002]。好处：并行 agent 分支不再互相踩踏；主分支历史整洁（一个 milestone = 一个 commit）；失败可以整体丢 worktree 不污染主。同时保留"每 task 原子 commit"以支持 `git bisect` 与精确回滚——**细粒度可追溯**与**主分支整洁**通过双层处理同时满足。

Anthropic 的 C compiler 案例走得更激进：**容器化 + 2000 session 并行**，说明 git 隔离可以继续向 "每 agent 一个隔离环境" 扩展 [S0006]。

---

## 8. 架构形态的光谱

harness 不是单一形态，当前 source 呈现一个光谱：

- **宿主式**（寄生在 IDE agent 里）：GSD v1 [S0001]；优点是启动门槛低、与 IDE 无缝；代价是受宿主生命周期约束，LLM self-loop 不可避免。
- **独立 CLI**：GSD v2 [S0002]；完全掌控执行路径；代价是要自己扛崩溃、并发、成本、数据库约束（v2 用 SQLite single-writer）[S0002]。
- **Control plane + 多 agent gateway**：OpenClaw [S0016]-[S0021]、Hermes [S0013]-[S0015]；long-lived gateway 把多 agent、多 session、多凭证统一调度；ACP 桥把任意 IDE 通过 session key + token-file 接入同一个 Gateway [S0021]。
- **Managed service**：Anthropic "Scaling Managed Agents"—— session / harness / sandbox 作为独立服务层，由平台方运维 crash recovery 与 sandbox 生命周期 [S0008]。这套设计哲学在 2026-04-01 的 beta 公开文档 [S0161] 里被晶化成开发者面向的四概念契约：**Agent**（model + system prompt + tools + MCP servers + skills，create once / reference by id 跨 session 复用）/ **Environment**（带 pre-installed packages 与 network rules 的容器模板）/ **Session**（在 environment 内运行的 agent 实例，持久 filesystem + 历史）/ **Events**（应用与 agent 之间的消息流，SSE 流式 + 服务端事件持久化可全量回拉）。内置工具集统一为 Bash / File ops / Web search & fetch / MCP 四类。这是把 [S0008] 的"为什么这么设计"翻译成"开发者怎么用"的接口契约——前者是工程文，后者是运维文。国内开发者社区 2026-05 出现首条公开复现报告 [S0162]——B 站 up 主把这套架构落地为"四层结构"叙事（brain/hands 分离 → harness 框架 → agent 作为 orchestrator 的调度对象，可回滚/克隆 → SessionStore 云端持久化），并声称用一周把 agent harness 塞进 worker docker 节点跑通，每个节点可挂载不同 model 的 Claude Code / 其他 harness；信息密度受限于个人复现 + ASR 噪声，但是 mythos 收到的第一份中文社区视角对 [S0008] 的二级解读，对照价值在于它把"为什么 SessionStore 重要"翻译成了"agent 是模板/静态、session 是实例/动态、记忆作为云端 store 跨 session 复用"的中文叙事，与 [S0008] 原文用 OS 进程/文件抽象类比的论述同构。**2026-05 同档对照样本两件**：(a) **Microsoft Agent Framework python-1.5.0 / dotnet-1.6.1** [S0171]——Foundry Hosted Agents 公开 RAG / Skills / Memory 三套官方 samples，`agent-framework-core` 原生解析 SKILL.md frontmatter YAML block scalars，orchestrations 包升 RC，durable-task 锁定 floor >=1.4.0；MS 的 managed 路线与 Anthropic 在"managed harness + 可移植 SKILL.md"两条主线上同步推进。(b) **Hermes Foundation Release（NousResearch，2026-05-16）** [S0173]——通过 OpenAI-compatible 本地 proxy 把任意 OAuth-authed Hermes provider 暴露为 OpenAI endpoint，让 Codex / Aider / Cline / Continue 直接接入；大规模 debloating（heavyweight 后端 lazy-install、`[all]` extras 收敛、tier 回退）使 managed runtime 装机尺寸 / 冷启动急剧下降（启动减 ~19 秒、CDP 调用快 180×），跨 session 1 小时 Claude prompt 缓存提供持久态优化。Hermes 把 managed harness 在"对外接入面"做的延伸（任何 IDE 接 OpenAI 协议就能复用同一 backend）补足了 Anthropic / MS 这条线上的开放接入面。**OpenClaw 2026.5.19-beta** [S0176] 是 ACPX gateway 侧的对应推进——把 startup probe / config / runtime / resource-count 启动成本归因到 restart trace（不改 readiness），把 §6 watchdog 的故障归因从"哪步出错"细化到"哪类启动成本异常"。
- **Programmable managed harness（managed harness 暴露为 SDK）**：Cursor 2026-04-29 公开的 TypeScript SDK [S0109] 是这种形态的首个公开样本——把 IDE 同款 runtime + harness + 模型组合通过 `@cursor/sdk` 暴露成可程序化调用。三种执行形态共栈：本地（`local: { cwd }`）、自托管 worker（代码不出网）、Cloud（dedicated VM + sandbox + 自动 PR + 断网/休眠续跑 + 流式重连）；上层抽象 `Agent.create` / `agent.send` / `run.stream` / `Agent.getRun` 跨 runtime 一致。harness 五件套（codebase 索引 + 语义搜索 / MCP / Skills / Hooks / Subagents）是 SDK 默认能力，外部应用只挑模型与 runtime。这条形态本质上是"**managed service** 的前端被 SDK 化"——开发者既不必自建 sandbox / durable engine（不像独立 CLI），也不被锁在 IDE 里（不像宿主式）。当前公开实现仅 Cursor 一例，未独立成 concept，先放进 §8 作为新增形态。
- **OS 级 / 浏览器级持久操作层（persistent operating layer）**：2026-05-15 泄露的 Google Gemini Spark [S0168] 是这种形态的首个公开信号——设计目标不是等 prompt，而是**在后台持续运行**，接入浏览会话、已连接应用、计划任务、聊天记录、位置数据，主动完成任务；跨网站维持 browser session，无需用户反复认证或重新下达指令。这把 harness 的边界从 IDE / managed service 推到了 OS / 平台层：harness = "你活在里面的基础设施"，而不是"你偶尔访问的工具"。与 IDE 宿主式或 managed service 的最大差异在于**上下文来源**——behavioral context（你点什么 / 买什么 / 和谁聊 / 哪些任务反复出现）是隐式积累的，agent 无需用户显式描述任务就能产生行动先机。该泄露目前仅有 tweet + 截图（source unreachable），属于早期信号，未在 concepts 中展开。

- **Open harness + open memory**：Harrison Chase 的规范倡议——只要 harness 不开放，memory 就是锁定的 [S0003]；这是一条正交于架构形态的设计价值观。

选哪种形态取决于规模与控制权需求。小团队自用 → 宿主式够用；多 agent 并行、跨 session 长期运行 → 独立 CLI 或 gateway；组织级 → managed service 更合适；要把 agent 嵌进自家产品又不愿重建 harness → programmable managed harness（当前只有 Cursor SDK [S0109]）；OS 级持久操作层 → 目前仅 Gemini Spark 一个早期泄露信号 [S0168]，harness 边界延伸至全平台行为数据层。

---

## 9. 待解问题

现有 source 覆盖得较好，但仍留下几个开放问题：

- **跨项目学习如何复用**：v2 的 `LEARNINGS.md` + 知识图谱 [S0002]、OpenClaw 的 memory promotion gates [S0049]、Letta Code Memory 的 dream subagent [S0046] 都在单项目内跑通；跨项目迁移的 schema、污染防御尚未定型。
- **安全边界与记忆投毒**：Anthropic 的 NIST RFI 专门警告 **persistent memory poisoning** 是 agentic 系统特有的攻击面 [S0027]；当 harness 开放 + memory 开放，安全假设需要重建。
- **多 agent 对抗 / 辩论机制**：见 [concepts/multi-agent-orchestration.md §9](multi-agent-orchestration.md)——当前拓扑全是协作式，对抗机制（同题反方案 + 第三方裁决）几无公开实现。
- **扩展 API 的治理**：v2 开放 `.gsd/extensions/` [S0002]；第三方扩展的安全边界、版本兼容、能力声明在各 harness 里都是开放问题。
- **A2A + MCP 协议层如何与 harness 合体**：A2A 定义了 agent 间通信（见 `concepts/a2a-protocol.md`），但 harness 内部如何表达一个"远端 agent"还在各 SDK 各做各的 [S0059] [S0060]。
- **OS 级持久操作层的 harness 设计**：Gemini Spark [S0168] 是首个公开信号，但泄露深度不足（仅截图），以下问题待更多 source 覆盖：behavioral context 如何结构化 / 投毒风险如何防御 / browser session 持久化的安全边界 / 与 UCP（User Control Plane，见 MAP）的关系。

---

## 来源一览

**GSD 系列**：S0001（GSD v1）· S0002（GSD v2.75）
**指导观点**：S0003（Harrison Chase — your harness, your memory）
**Practitioner 视角**：S0177（Sean Goedecke — 2026 staff engineer 一年更新）· S0184（Cat Wu — Lenny's Podcast：Claude Code 产品负责人视角的 harness 调试与 curation 实践）
**Coding agent 训练机制**：S0178（Cursor Composer 2.5 — targeted RL textual feedback + 25x synthetic + reward hacking 监控）
**Anthropic harness**：S0004（multi-agent research）· S0005（long-running harness 三角色）· S0006（C compiler 并行）· S0007（effective harnesses）· S0008（scaling managed agents 工程设计）· S0009（context engineering）· S0010（when to use subagents）· S0011（writing effective tools）· S0012（demystifying evals）· S0161（managed agents overview docs：四概念接口契约）· S0162（国内 B 站 up 对 S0008 的中文二级解读 + 复现声明）
**Hermes / OpenClaw**：S0013 · S0014 · S0015 · S0016-S0021（gateway / routing / session / ACP / spawn / delegate）
**横向**：S0022（Magentic-One）
**Context 工程**：S0023（context editing）· S0024（long-running Claude）· S0029（Codex long-horizon）· S0041（LangChain context = RAM）· S0042（MorphLLM）
**Eval / 安全**：S0027（NIST RFI）· S0051（MIRROR）
**跨 harness 协议**：见 `concepts/a2a-protocol.md`
**OS 级持久操作层（early signal）**：S0168（Gemini Spark 泄露，unreachable）

---

## 参考来源

本综述引用的所有 source，标识符 + 标题 + 内容类型 + 原始链接。点击 ID 可回到 `kb/sources/<file>.md` 读原文。

| ID | 类型 | 标题 | 链接 |
|----|------|------|------|
| [S0001](../sources/2026-04-18_gsd-1-get-shit-done.md) | repo | GSD (Get Shit Done) — 面向 AI 编码代理的上下文工程框架 | https://github.com/gsd-build/get-shit-done/blob/main/README.zh-CN.md |
| [S0002](../sources/2026-04-15_gsd-2.md) | repo | GSD-2 — The evolution of Get Shit Done, now a real coding agent | https://github.com/gsd-build/gsd-2 |
| [S0003](../sources/2026-04-11_your-harness-your-memory.md) | blog | Your harness, your memory | https://www.langchain.com/blog/your-harness-your-memory |
| [S0004](../sources/2025-06-13_anthropic-multi-agent-research.md) | blog | How we built our multi-agent research system | https://www.anthropic.com/engineering/multi-agent-research-system |
| [S0005](../sources/2025-08-01_anthropic-harness-long-running.md) | blog | Harness design for long-running application development | https://www.anthropic.com/engineering/harness-design-long-running-apps |
| [S0006](../sources/2025-09-15_anthropic-c-compiler-parallel-claudes.md) | blog | Building a C compiler with parallel Claudes | https://www.anthropic.com/engineering/building-c-compiler |
| [S0007](../sources/2025-10-12_anthropic-effective-harnesses-long-running.md) | blog | Effective harnesses for long-running agents | https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents |
| [S0008](../sources/2025-11-20_anthropic-scaling-managed-agents.md) | blog | Scaling to multi-million-token agents with managed agents | https://www.anthropic.com/engineering/managed-agents |
| [S0009](../sources/2025-12-15_anthropic-context-engineering.md) | blog | Context engineering: memory, compaction, and tool clearing | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents |
| [S0010](../sources/2025-11-05_anthropic-subagents-claude-code.md) | blog | Building agents with the Claude Agent SDK | https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk |
| [S0011](../sources/2025-10-01_anthropic-writing-effective-tools.md) | blog | Writing effective tools for agents | https://www.anthropic.com/engineering/writing-tools-for-agents |
| [S0012](../sources/2025-09-10_anthropic-demystifying-evals.md) | blog | Demystifying evals for AI agents | https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents |
| [S0013](../sources/2026-04-16_hermes-agent-repo.md) | repo | NousResearch/hermes-agent — The agent that grows with you | https://github.com/NousResearch/hermes-agent |
| [S0014](../sources/2025-12-01_hermes-multi-agent-umbrella.md) | docs | Hermes Multi-Agent Umbrella (GitHub issue #344) | https://github.com/NousResearch/hermes-agent/issues/344 |
| [S0015](../sources/2025-11-01_datacamp-hermes-agent-tutorial.md) | tutorial | DataCamp: Nous Research Hermes Agent — Setup and Tutorial Guide | https://www.datacamp.com/tutorial/hermes-agent |
| [S0016](../sources/2026-01-10_openclaw-gateway-architecture.md) | docs | OpenClaw Core Concepts — Gateway / Harness / Agent Runtime (DeepWiki) | https://deepwiki.com/openclaw/openclaw/1.2-core-concepts |
| [S0017](../sources/2026-01-10_openclaw-multi-agent-routing.md) | docs | Multi-Agent Workflows — OpenClaw Docs (clawdocs.org mirror) | https://clawdocs.org/guides/multi-agent/ |
| [S0018](../sources/2026-01-10_openclaw-session-tools.md) | docs | Session Tools — OpenClaw (openclawlab.com mirror) | https://openclawlab.com/en/docs/concepts/session-tool/ |
| [S0019](../sources/2026-01-10_openclaw-acp-agents.md) | docs | ACP Agents — OpenClaw | https://openclaws.io/docs/tools/acp-agents |
| [S0021](../sources/2026-01-10_openclaw-delegate-architecture.md) | tutorial | 2026 Complete Guide: OpenClaw ACP — Bridge Your IDE to AI Agents | https://dev.to/czmilo/2026-complete-guide-openclaw-acp-bridge-your-ide-to-ai-agents-3hl8 |
| [S0022](../sources/2024-11-04_microsoft-magentic-one.md) | blog | Magentic-One (Microsoft Research) | https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/ |
| [S0023](../sources/2025-09-01_anthropic-context-editing-docs.md) | docs | Context editing (Claude API Docs) | https://platform.claude.com/docs/en/build-with-claude/context-editing |
| [S0024](../sources/2025-08-15_anthropic-long-running-claude-research.md) | blog | Long-running Claude for scientific computing | https://www.anthropic.com/research/long-running-Claude |
| [S0026](../sources/2025-11-05_anthropic-subagents-docs.md) | docs | Create custom subagents - Claude Code Docs | https://code.claude.com/docs/en/sub-agents |
| [S0027](../sources/2025-03-14_nist-rfi-agentic-security.md) | paper | NIST RFI on Agentic Security | https://www-cdn.anthropic.com/43ec7e770925deabc3f0bc1dbf0133769fd03812.pdf |
| [S0029](../sources/2025-11-15_openai-long-horizon-codex.md) | blog | Run long horizon tasks with Codex | https://developers.openai.com/blog/run-long-horizon-tasks-with-codex |
| [S0041](../sources/2025-09-15_langchain-context-engineering.md) | blog | LangChain: Context Engineering for Agents | https://blog.langchain.com/context-engineering-for-agents/ |
| [S0042](../sources/2025-10-01_morphllm-context-engineering.md) | blog | MorphLLM: Context Engineering | https://www.morphllm.com/context-engineering |
| [S0046](../sources/2025-12-01_letta-code-memory.md) | docs | Letta Code Memory | https://docs.letta.com/letta-code/memory/ |
| [S0049](../sources/2026-01-10_openclaw-memory-overview.md) | docs | OpenClaw Memory Concept (github source docs) | https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory.md |
| [S0051](../sources/2025-06-01_arxiv-mirror.md) | paper | MIRROR | https://arxiv.org/abs/2506.00430 |
| [S0059](../sources/2025-10-01_google-adk-a2a.md) | docs | Google ADK with A2A docs | https://google.github.io/adk-docs/a2a/ |
| [S0060](../sources/2025-11-01_google-agent-protocols-guide.md) | blog | Google Developers Blog: Developer's Guide to AI Agent Protocols | https://developers.googleblog.com/developers-guide-to-ai-agent-protocols/ |
| [S0086](../sources/2025-06-10_pragmatic-cursor-deepdive.md) | blog | Real-world engineering challenges: building Cursor | https://newsletter.pragmaticengineer.com/p/cursor |
| [S0088](../sources/2026-04-24_deepseek-v4-tech-report.md) | paper | DeepSeek-V4: Towards Highly Efficient Million-Token Context Intelligence | https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/blob/main/DeepSeek_V4.pdf |
| [S0109](../sources/2026-04-29_cursor-typescript-sdk.md) | blog | Build programmatic agents with the Cursor SDK | https://cursor.com/blog/typescript-sdk |
| [S0161](../sources/2026-05-12_anthropic-managed-agents-overview-docs.md) | docs | Claude Managed Agents overview | https://platform.claude.com/docs/en/managed-agents/overview |
| [S0162](../sources/2026-05-11_bilibili-managed-agents-cn-recap.md) | transcript | 比 Openclaw 更好！我发现了多 Agent 协作架构的版本答案！ | https://www.bilibili.com/video/BV1DB546wEb8 |
| [S0168](../sources/2026-05-16_testingcatalog-gemini-spark-persistent-agent-layer-leak.md) | unreachable | Gemini Spark: Google's leaked persistent background agent operating layer | https://x.com/testingcatalog/status/2054839588963696792 |
| [S0171](../sources/2026-05-19_ms-agent-framework-python-1.5.0.md) | release-notes | Microsoft Agent Framework python-1.5.0: Foundry Hosted Agents + SKILL.md frontmatter | https://github.com/microsoft/agent-framework/releases/tag/python-1.5.0 |
| [S0173](../sources/2026-05-16_hermes-v0.14.0-foundation-release.md) | release-notes | Hermes Agent v0.14.0: The Foundation Release | https://github.com/NousResearch/hermes-agent/releases/tag/v2026.5.16 |
| [S0176](../sources/2026-05-19_openclaw-2026.5.19-beta.md) | release-notes | OpenClaw 2026.5.19-beta: clean bounded refactors + ACPX cost attribution | https://github.com/openclaw/openclaw/releases/tag/v2026.5.19-beta.2 |
| [S0177](../sources/2026-05-17_seangoedecke-how-i-use-llms-2026.md) | blog | How I use LLMs as a staff engineer in 2026 (practitioner 一年更新 — agents 进入 reliable 拐点) | https://www.seangoedecke.com/how-i-use-llms-in-2026/ |
| [S0178](../sources/2026-05-18_cursor-composer-2.5.md) | blog | Introducing Composer 2.5 (Cursor agentic coding model — targeted RL textual feedback / 25x synthetic / Muon + HSDP) | https://cursor.com/blog/composer-2-5 |
| [S0184](../sources/2026-04-23_lennys-podcast-cat-wu-claude-code.md) | podcast | How Anthropic's product team moves faster than anyone else | Cat Wu (Head of Product, Claude Code) — Lenny's Podcast #340 | https://www.lennysnewsletter.com/p/how-anthropics-product-team-moves |
