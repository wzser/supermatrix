---
last_updated: 2026-05-05
confidence: medium
refresh_cadence: event-driven
parent: null
children: []
unwritten_children:
  - reasoning-models-prompting: "o-series / extended thinking 的 prompt 范式自成一体，目前在本综述§5 占一段；积累更多源（DeepSeek-R1 / Qwen-thinking / Gemini Flash thinking）可独立"
  - prompt-as-code: "templates + 版本 + optimizer + evals 形成的工程闭环可独立成 concept；当前在§7"
  - agentic-prompting: "tool persistence / preambles / verification loops 跨 provider 模式自成一体；当前在§6，与 multi-agent-orchestration 有重叠待划界"
boundary_with:
  - harness: "harness 是把对话变成工程产出的运行时；prompt-engineering 讲『放进 harness 的 prompt 应该长什么样』。本综述只讲内容/结构，不讲运行时状态机/context 管理。"
  - multi-agent-orchestration: "多 agent 编排讲拓扑、控制流、durable execution；prompt-engineering 讲『每个 agent 自己的 prompt 怎么写』。本综述涉及 agentic 场景的 prompt 模板（§6），但拓扑级别讨论不在此处。"
  - deep-research-agent: "deep research 是一种特定 prompt 模式 + 工具栈组合（Planner/Searcher/Verifier 各自的 prompt）；本综述提供这些子 agent 的 prompt 设计原则，但具体的搜索循环 / 停止条件 / 证据图设计走 deep-research-agent §4–§5。"
---

# Prompt Engineering（提示词工程：OpenAI / Anthropic 的当前指南综述）

---

## 1. 这是什么 / 为什么不要把它和 context engineering 混为一谈

提示词工程是**写给 LLM 的指令的工程化方法**——从『写一句话发给 ChatGPT』升级成『把成功标准、约束、上下文、示例、停止条件、输出契约组织成可被工程化测试与迭代的指令对象』。Anthropic 的入口页明确指出，谈 prompt engineering 之前必须先有：清晰的成功标准、可经验测试这些标准的方法、一份初稿 prompt——三者缺一就不该谈优化 [S0093]。

近一年这个名词正在向 **context engineering** 漂移：搜索结果里频繁出现『不再是写一句完美 prompt，而是优化模型看到的一切——system prompts / tools / examples / conversation history / available context』这种判断。本综述用『prompt engineering』作为伞名涵盖两者，但单独章节会指出哪些主张已经超出『写一句指令』而进入 context 设计领域（§3 结构、§6 agentic、§7 prompt-as-code）。

边界声明（详见 frontmatter `boundary_with`）：本综述讲『放进 harness 的 prompt 应该长什么样』，不讲运行时状态机（走 [harness](harness.md)）；讲单个 agent 的 prompt 模式，不讲拓扑（走 [multi-agent-orchestration](multi-agent-orchestration.md)）；讲推理 / 检索 / 写报告 agent 的 prompt 设计原则，但具体 deep research loop 走 [deep-research-agent](deep-research-agent.md)。

---

## 2. 两家厂商的 disposition 差异（这是最容易踩坑的地方）

OpenAI 和 Anthropic 对 prompt 的世界观不同，迁移 prompt 时不是『换 model 名就行』。

**Anthropic 的世界观**：把所有技巧合并到**一份**『living reference』文档 `claude-prompting-best-practices`，其余子页都指向它 [S0093] [S0094]。文档假设 prompt 是给同一家族 Claude 模型的，提供一组**通用结构主张**——XML 标签结构化输入、明确角色与上下文、用例子取代长描述、显式留空给 thinking、agentic 场景下给 'don't stop until task is done' 这类指令——再叠加少量模型差异说明（Opus 4.7 默认更长输出 / 4.6 / Sonnet 4.6 / Haiku 4.5）[S0094]。Console 提供 prompt generator + templates + improver 三件工具帮人快速产出 + 改进 prompt [S0095]。

**OpenAI 的世界观**：明确**按模型版本切片**写 guide。`prompt-guidance` 一页里平行罗列 GPT-5.5 / 5.4 / 5.3 codex / 5.2 / 5.1 / 5 / 4.1 各自的最佳实践 [S0097]，cookbook 里又给 GPT-5 / GPT-5.1 / GPT-4.1 / Codex / Realtime 各一份独立 deep-dive [S0101] [S0102] [S0103] [S0104] [S0106]。底层主张是『prompt 应该和模型 generation 一起演进』，用户应该 pin 到具体快照（如 `gpt-4.1-2025-04-14`）保持稳定 [S0096]。Reasoning 模型（o3 / o4-mini）和 GPT 模型还要按"两类"分别 prompt——前者像高级同事只给目标，后者像执行者要给详细步骤 [S0100]。

**核心后果**：

- 跨模型迁移时 **OpenAI 这边经常需要重写 prompt**——`prompt-guidance` 整个页面的存在就是为了告诉你迁过去要改什么 [S0097]。GPT-5 Prompt Optimizer 的产品定位是『把旧 prompt 改成新模型能用的』，识别 5 类常见 anti-pattern：内部矛盾、format conflicts、incompatible model assumptions、ambiguous instructions、verbose-low-clarity prompts [S0105]。
- Anthropic 这边宣称 Opus 4.7 在 4.6 prompt 上『works well out of the box』，只在少数行为上需要调（如 response length / verbosity 默认变长）[S0094]。这是真主张还是 marketing，本综述无法独立验证，需要后续实测数据。
- **跨厂商迁移成本更高于跨模型**：XML 标签是 Anthropic 推荐的强结构语义，OpenAI 主张 Markdown headers + XML tags 混用 [S0096]，但 OpenAI 模型对 XML 的『内化程度』与 Claude 不同，盲搬 XML 模式不一定保持效果。

**GPT-5.5 专项更新（2026-05）**：随着 GPT-5.5 发布，OpenAI 对该模型给出专项指南 [S0111]，核心主张是**更强的模型需要更少的过程约束**。具体演进：(1) *Outcome-first framing*——定义"成功是什么"和"哪些约束存在"，而非一步步指定执行方法；早期模型需要步骤级引导，GPT-5.5 从目标出发自行规划，过度规定反而干扰。(2) *Personality / collaboration blocks 分离*——把 personality（语气 / 温度 / 直接程度）和 collaboration style（何时提问 / 主动程度）写成两个独立段落，而非混合在 identity 描述里；保持两段各自简洁。(3) *Retrieval budgets*——agentic 场景里不设固定轮数，改用决策规则：「现在能用有效证据回答核心请求了吗？」能就停；不能就继续——和 [deep-research-agent §5](deep-research-agent.md) 的边际收益停止条件同源，但此处是 prompt-level policy 而非 planner-level 算法。(4) *Grounding rules*——明确区分"必须有出处的 claim"（产品名称 / 客户数据 / 关键指标 / 路线图承诺）和"可自由生成的内容"，对前者要求 citation，对后者允许通用措辞——把 hallucination 风险从"全部来源"压缩到"有价值但难溯源的部分"。(5) *Output contracts via text.verbosity*——用 `text.verbosity` 控制长度期望而非写死字数限制。这五项加在一起，是 OpenAI "按模型版本切片"策略在 5.5 这一代的体现：随模型能力上台阶，prompt 应该下沉到更抽象的层次，把具体执行决策交还给模型。

---

## 3. 共通核心：clarity / structure / examples / constraints

剥掉 vendor 层后，两家在 prompt 内容层的主张高度重合：

**清晰直接的指令**。把任务、目标、约束、输出形态都讲到位；歧义会被模型放大成行为分歧 [S0094] [S0096]。OpenAI 主张『identity → instructions → examples → context』四段式作 developer message 默认骨架 [S0096]。Anthropic 反复强调用 XML 标签把不同语义片段隔开（输入 / 上下文 / 例子 / 历史对话）[S0094]。两家共识：**长指令优先用 bullets 而非段落**——realtime agent prompt 显式要求 bullets [S0106]，OpenAI prompting 一般也建议 [S0096]。

**示例（few-shot）替代长描述**。一两个 input/output 对比通常比规则列表更高效 [S0094] [S0096] [S0103]。Anthropic improver 工具会自动把示例摆在第一条 user message 开头 [S0095]。OpenAI 的 prompting templating 推荐把 few-shot 例子集成成 YAML / 列表方便 review [S0098]。

**结构化分隔符**。Markdown 的 `#` 标题 / 代码围栏 + XML 标签的 `<context>` / `<rules>` / `<examples>` 等成对标签——两家都把『让模型一眼看出每段是干什么的』作为基础动作 [S0094] [S0096] [S0101]。

**约束与禁止显式化**。OpenAI GPT-5.5 指南反对滥用『ALWAYS / NEVER / must』当成普通指令——这些应该只用于真正的硬不变量；判断类指令应该写成 decision rules 而非绝对句 [S0097]。Anthropic 的强相关主张：把模型行为写成『when X, do Y; when not X, do Z』而不是堆 'always' [S0094]。

**输出契约**。明确写出『返回什么形态、字段顺序、长度限制』。GPT-5.4 给 `<output_contract>` / `<verbosity_controls>` 模板 [S0097]；Anthropic 教用 `<output_format>` 标签 + 给一个 prefilled assistant 起点引导格式 [S0094]。

**模型角色定位 + identity**。OpenAI 的 `instructions` 参数和 system message 都是给定 identity 的位置 [S0096]；Anthropic 把 system prompt 等价用法做 dedicated 段讨论 [S0094]。两家都认为身份明确 + 简短 personality 段（不要超 100 字）比长描述效果好 [S0097] [S0094]。

---

## 4. 关键工具栈：XML tags / 模板变量 / Markdown / prefilling

**XML tags**：Anthropic 把 XML 当成『prompt 的语法树』第一公民——明确 input / instructions / examples / output 边界，并用嵌套表达层次 [S0094]。模板变量也建议包在 XML 里：`<text>{{user_text}}</text>` 比裸 `{{user_text}}` 更稳 [S0095]。OpenAI 也支持 XML 但更常见混用 Markdown headers（顶层）+ XML tags（content delineation）[S0096]。

**Prompt templates + variables**：两家都把 prompt 当成可参数化对象。Anthropic 用 `{{double_braces}}`，Console 内有 prompt generator 自动生成 + 自动选择哪些片段做变量 [S0095]。OpenAI 提出 first-class `prompt_id` + 版本号 + 变量字典 + 跨 project 共享 [S0098]——`prompt: { id: "pmpt_abc", version: "2", variables: {...} }`。

**Markdown vs XML 之争**：没有统一答案。OpenAI 文档建议 Markdown 做层级结构 + XML 做 content 划分 [S0096]；Anthropic 文档以 XML 为主 [S0094]；GPT-5 cookbook 警告 markdown 嵌套 bullets 容易让模型困惑、应当 flat [S0101]。本综述判断：**取决于模型 + 内容层级深度**——浅层用 Markdown 即可，跨多片段嵌套时上 XML。

**Prefilling assistant 起点**：Anthropic 的特殊招法——assistant 消息可以预填一段开头，Claude 会从那个点续写。极有效于 forcing format（预填 `{` 强制 JSON 输出 / 预填 `<analysis>` 强制结构化推理）[S0094]。OpenAI 没有等价机制（其 ChatCompletions 不接受预填 assistant turn 续写）。

**Meta-prompts / Meta-schemas**：OpenAI Playground 的 'Generate' 按钮内部用 meta-prompts 生成 prompt、用 meta-schemas 生成 structured-outputs/function 的 JSON schema [S0099]。整个 meta-prompt 文本（含 text 输出版本、audio 输出版本）和 meta-schema（含 strict mode 限制 + pseudo-meta-schema 解决方案 + 三个完整示例）都已公开 [S0099]——可以直接 copy 用作自己的 prompt-from-task-description 工具。

---

## 5. Reasoning 模型（o-series / extended thinking）需要不同的 prompt 风格

这是和过去最大的范式断裂。OpenAI 原文给的隐喻是 **'reasoning models are like senior coworkers'——给目标、不给步骤** [S0100]。

**OpenAI 主张**：

- prompts 保持简洁、直接，**不要写 'think step by step'**——模型内部自带 CoT，再加这句话会干扰 [S0100]。
- **从 zero-shot 起手**，只在效果不够时才加 examples（few-shot 给 reasoning 模型可能反而损害效果）[S0100]。
- 用清晰分隔符（Markdown / XML）但不要要求模型『展示推理』——内部 reasoning items 不在用户看到的输出里 [S0100]。
- Responses API 的 `store=true` + 把 previous reasoning items 传回去——不传等于每次推理从零开始烧钱 [S0100]。
- `reasoning_effort` 是末调旋钮，不是主升 quality 工具——优先靠 prompt + verification loop 提质，再考虑提 effort 等级 [S0097]。

**Anthropic 主张（extended thinking）**：

- 给 thinking budget 和清晰目标即可，不需要『show your reasoning』指令 [S0094]。
- Interleaved thinking（thinking 和 tool calls 交替）需要 prompt 显式说『think briefly between tool calls』[S0094]。
- thinking 的产出**不要**当成最终输出的一部分；用 `<answer>` / `<final>` 段把 thinking 之外的输出隔开 [S0094]。

**共同结论**：reasoning 模型的 prompt 风格更像写给『senior expert 写一个 brief』——`目标 + 约束 + 已知信息`；执行类模型（GPT-4.1 / Claude with thinking off）的 prompt 风格更像写 SOP——`步骤 1 / 2 / 3 + 边缘情况 + 输出格式`。

---

## 6. Agentic prompting：tool persistence / preambles / verification loops

这是两家近 12 个月汇聚最快的子领域，因为同一组工程问题在两家都成为生产难题。

**Tool persistence rules**（OpenAI 命名）：明确告诉模型『当工具能改善正确性时一直用，别提前停下；调用拿到部分结果就重试；任务完整前不要宣告完成』[S0097] [S0103]。Anthropic 等价主张：在 system prompt 加『don't end your turn until the task is fully resolved』[S0094]。

**Preambles**：Codex prompting / GPT-5 prompting 都引入了 'tool preambles' 概念——在调用工具前先用 1-2 句话说 'I'm going to do X because Y'，给用户可观察的进度感、给模型自己一个状态锚点 [S0101] [S0104]。Realtime 场景把这个推到极端——主流第一个 token 就要给个 ack，否则用户体验断点 [S0106]。

**Verification loops**：高影响 / 不可逆动作前必须做的检查——correctness / grounding / formatting / safety [S0097]。Codex prompting 给完整 `<verification_loop>` 模板 [S0104]。Anthropic 在 'agentic systems' 段教 'verify before commit / check work after substantial changes' [S0094]。

**Completeness contract**：把任务定义成『所有 deliverables 完成 OR 标 [blocked]』，避免 LLM 走到一半觉得『差不多了』就停 [S0097]。GPT-4.1 cookbook 里实测：加上 'Persistence + Tool calling + Planning' 三段 system prompt 让 SWE-bench Verified 提升约 20% [S0103]——这是少数有公开实验数字的 prompt 工程改动。

**Plan 工具 / planner subagent**：Codex prompt 显式禁止 'multi-step plans for trivial tasks'、要求 'don't end on plan, deliver code'、要求 'reconcile every TODO before finishing' [S0104]——把 plan 当工具用、不是仪式。

**Retrieval budgets（GPT-5.5 新增）**：在 agentic search 场景下，GPT-5.5 指南 [S0111] 提出用决策问题代替迭代次数上限——在 prompt 里明确写「当你能用现有证据回答核心请求时就停止，不要追求更多」。和 §6 里的 tool persistence rules（"继续，直到完成"）形成互补：persistence 防止过早停止；retrieval budget 防止过度搜索。

**Grounding rules（GPT-5.5 新增）**：区分"需要出处的声明"和"可生成的内容"写在 prompt 里，要求模型对有价值的声明（产品细节 / 客户数据 / 指标）保留 citation，对通用性内容则允许自由生成 [S0111]。这是把 hallucination 风险管理内化到 prompt 里的方式——不用全篇来源，而是定向约束高风险字段。

**前后呼应**：本节描述的几乎所有模式（持久化 / preambles / verification / completeness / retrieval-budgets / grounding-rules）也出现在 [multi-agent-orchestration §5 故障容错四件套](multi-agent-orchestration.md) 和 [deep-research-agent §4 verifier](deep-research-agent.md) 里——三者其实是『同一个 agent reliability 问题在不同抽象层的回响』。

---

## 7. Prompt as Code：模板 / 版本 / optimizer / evals

『prompt 是代码』这个隐喻已经从口号变成产品形态：

- **First-class prompt object**：OpenAI 的 `prompt_id` + 版本号 + variables 字典 + history rollback；prompts dashboard 像 git for prompts [S0098]。
- **Optimizer**：OpenAI Prompt Optimizer 用 GPT-5 自动改写旧 prompt 适配新模型 + 检测 anti-patterns；Anthropic Prompt Improver 用 4-step 流程（example identification → initial draft → CoT refinement → example enhancement）改造现有 prompt [S0105] [S0095]。
- **Generator（解决 blank-page）**：Anthropic Console prompt generator 从任务描述生成模板 [S0095]；OpenAI Playground 'Generate' 按钮等价能力 + meta-prompt 文本完全公开 [S0099]。
- **Linked evals**：每次 publish 跑回归测试 [S0098]——和 [deep-research-agent §3](deep-research-agent.md) 的 RACE/FACT 思路一致：没有 eval 就不知道改 prompt 有没有让效果变好。
- **DSPy / Gradient Descent of prompt**：OpenAI prompt-generation 文档明示『未来可能集成 DSPy 或 'Gradient Descent' 式方法』[S0099]——这是产品 roadmap 信号，目前都还没落地。

**未解 / 未规约的**：跨 prompt 版本的 backward compatibility、多模型同 prompt 的统一管理、prompt as code 时 git workflow 怎么和 dashboard 同步——这些工程问题文档中都没有给出答案。

---

## 8. Anti-patterns（这些 prompt 写法已经被点名了）

来自 GPT-5 Prompt Optimizer 的 5 类 [S0105]：

1. **Internal contradictions**：prompt 里两条规则互斥（"返回 1 句" vs "包含 5 个示例"），模型只能挑一个，行为不稳。
2. **Format conflicts**：要求 JSON 但又混入 'use bullet points' 这类自然语言格式指令。
3. **Incompatible model assumptions**：prompt 写法假设 GPT-3.5 不会自己 reason，到了 GPT-5 反而限制它。
4. **Ambiguous instructions**：'be helpful but professional' 这种放之四海皆准的废话。
5. **Verbose-low-clarity**：长但模糊；长不等于详细。

来自 GPT-5.5 prompting guide [S0097]：滥用 ALWAYS / NEVER / must 当软指令使。

来自 GPT-5.3 codex starter prompt [S0104]：

- 让模型写完后说 'summary: ...'（用户能读 diff，summary 是噪声）。
- 给空泛 todo 当 plan（plans should guide edits, the deliverable is working code）。
- end with in_progress / pending plan items（必须 reconcile 完）。

来自 realtime [S0106]：

- 用 paragraph 而不是 bullets（语音模型对 bullets 反应明显更好）。
- 把 IF-THEN 写成代码语法（'IF score > 3 THEN escalate'）而不是自然语言（'if more than 3 failures, escalate'）。

---

## 9. 与 mythos 内其它 concept 的连结

- **harness 综述 §4 context-engineering** 讨论 harness 怎么管理 LLM 看到的 context；本综述讨论 prompt 内容怎么写。两者形成 stack：harness 决定哪些片段进入 context，prompt-engineering 决定每片段长什么样。
- **multi-agent-orchestration §5 故障容错四件套** 把 'append-only 状态 / 边界契约 / 断路器 / Saga' 作为系统级保险；本综述 §6 的 verification loop / completeness contract 是这些保险在『单 agent prompt 内部』的对应物。
- **deep-research-agent §4** 提的 Planner / Searcher / Reader / Verifier / Curator 多角色，每个角色的 prompt 都可以从本综述 §3-§7 的原则套出来；§5 停止条件中的 EVI 公式属 'prompt as policy'，与本综述 §7 prompt-as-code 隔山相望。
- **agent-dreaming** 涉及 dreaming agent 的 prompt 模式（meta-reflection 类 prompt），目前两家都没有专文，但 [S0094] 在 'agentic systems' 段提到 long-horizon agent 反思机制——是潜在的桥点，但本综述未深入。

---

## 10. 待解 / 开放问题

- **跨厂商 prompt 等价性**：『XML tags 在 OpenAI 上是否和 Anthropic 等效』『few-shot 在 reasoning 模型上是 helpful 还是 harmful』这些都需要 benchmark 实验，文档里没有 definitive answer。
- **prompt 老化速度**：OpenAI 的『按模型版本切片』disposition 暗示 prompt 寿命短；Anthropic 的『单 living reference』disposition 暗示 prompt 跨代相对稳定。哪种更贴实际工程经验，目前 KB 没有 case study source。
- **context engineering 该不该和 prompt engineering 分家**：行业话语 2025-2026 在重命名，但本综述选择把两者放一起；后续证据更多时可能拆 concept。
- **agentic 三件套（persistence / preambles / verification）和 multi-agent reliability 四件套（append-only / contract / circuit / saga）的关系**：前者在 prompt 层、后者在系统层，但解决的是同一类失败模式——值得一篇横跨 mythos concept 的子综述。
- **针对中文 prompt 的优化**：所有 source 都是英文文档；Claude / GPT 在中文 prompt 上的差异、中文 XML 标签是否同样有效、中文 system prompt 的最佳实践，文档无覆盖，需要本地实测。
- **GPT-4.1 cookbook 的 SWE-bench +20% 实验**[S0103] 是少数有数字的 prompt 改动，但文档没给出具体 baseline 和实验设置，需要回原 paper 校验。

---

## 11. 实证层：主流产品真实生产 system prompt（leaked）

前面 1–10 节都是**理论 / 文档层**——OpenAI 和 Anthropic 自己说『应该怎么写 prompt』。但它们自家产品里**实际**的 system prompt 长什么样，文档不会告诉你。这一节讨论实证层。

`asgeirtj/system_prompts_leaks` 是 GitHub trending #1 仓库 [S0143]，从主流 AI 产品和 coding agent 提取的真实生产 system prompt。本批捕获 13 个 Tier 1 当前 canonical 主力（约 1.2MB raw text），形成跨厂商横向对照：

- **Anthropic**：Opus 4.7 [S0144] / Opus 4.6 [S0145] / Sonnet 4.6 [S0146] / Claude Code [S0147] / Claude Cowork [S0148]
- **OpenAI**：GPT-5.5 Thinking [S0149] / GPT-5.4 Thinking [S0150] / Codex GPT-5.5 [S0151] / Codex GPT-5.3-codex [S0152]
- **Google**：Gemini 3.1 Pro [S0153] / Gemini CLI [S0154]
- **xAI**：Grok 4.3 beta [S0155]
- **Cursor**：Cursor agent [S0156]

这些 source 是**事实层**——和综述 §1–§10 的『opinion / 综合层』正交。它们能用来：

1. **回测理论**——本综述的论断（§3 共通核心 / §6 agentic 三件套 / §7 prompt-as-code）在真实生产 prompt 里到底有没有出现、出现频率多高。比如 §6 说 *tool persistence* 是 agentic 必须，可以直接 grep 13 个 prompt 里有几个写了类似 'don't stop until task is fully resolved' 的句子。
2. **跨厂商横向**——同一类任务（agentic coding）的 4 个 prompt（Claude Code [S0147] / Codex GPT-5.5 [S0151] / Gemini CLI [S0154] / Cursor [S0156]）对比，能看清各家在 tool 描述详细度、persistence 规则、verification loop、final-answer 格式上的差异。
3. **同代模型演进**——4.6 vs 4.7 [S0144] [S0145]、5.4 vs 5.5 [S0149] [S0150]、5.3-codex vs 5.5-codex [S0151] [S0152] 给同一家、相邻代际模型的 prompt diff，是检验 §2『跨模型迁移成本 OpenAI 高 / Anthropic 低』的实证基础。
4. **实证 size / 复杂度差异**——Anthropic Opus 4.6/4.7/Sonnet 4.6 都在 200-250KB 量级，OpenAI ChatGPT GPT-5.5 Thinking 105KB，Codex 的 11-20KB，Cursor 18KB——**ChatGPT-style 通用助手 prompt ≫ coding agent prompt**，量级差一个数量级。

**当前状态**：本节只列出 sources + 横向对比维度。**深度交叉分析（具体哪些主张被实证 / 反证、哪些规律是各家共有 / 独有）需要做一轮逐文件 deep-dive**——这是 mythos 后续动作（独立 concept 候选 'production-prompt-patterns' 已在 frontmatter `unwritten_children` 之外，按下一轮 review 决定是否拆出）。在那之前，§1–§10 的论断保持原样，本节作 fact-layer 引用入口。

---

## 来源一览

- [S0093] Anthropic *Prompt engineering overview*——入口页 + 把所有技巧指向 best-practices。
- [S0094] Anthropic *Prompting best practices*（60KB 单文档）——当前 canonical 综合指南，覆盖 Opus 4.7/4.6 / Sonnet 4.6 / Haiku 4.5。
- [S0095] Anthropic *Console prompting tools*——generator / templates / improver 工具链 + before/after 示例。
- [S0096] OpenAI *Prompt engineering*——主指南（developer/user/assistant 角色 + identity-instructions-examples-context 四段式）。
- [S0097] OpenAI *Prompt guidance*——按模型切片：GPT-5.5 / 5.4 / 5.3 codex / 5.2 / 5.1 / 5 / 4.1 各版本最佳实践。
- [S0098] OpenAI *Prompting*——`prompt_id` 版本化 + 模板变量 + linked evals。
- [S0099] OpenAI *Prompt generation*——meta-prompts / meta-schemas（含完整公开文本）。
- [S0100] OpenAI *Reasoning best practices*——o3 / o4-mini 选型 + reasoning model prompt 风格。
- [S0101] OpenAI Cookbook *GPT-5 prompting guide*——eagerness 调控 / coding agent / preambles / metaprompting / Cursor case study。
- [S0102] OpenAI Cookbook *GPT-5.1 prompting guide*——`none` reasoning + steerability + GPT-5 → 5.1 迁移要点。
- [S0103] OpenAI Cookbook *GPT-4.1 prompting guide*（2025-04）——agentic 三段 system prompt + SWE-bench 提升数据 + 1M context 用法。
- [S0104] OpenAI Cookbook *Codex prompting guide*——gpt-5.3-codex starter prompt 完整模板 + AGENTS.md 注入 + Compaction。
- [S0105] OpenAI Cookbook *Prompt optimization*——Optimizer 识别的 5 类 anti-patterns + before/after 改写示例。
- [S0106] OpenAI Cookbook *Realtime prompting guide*——gpt-realtime 语音 agent 的 prompt 范式（注：原文嵌入了 10 段 base64 音频示例，捕获时已剥离）。
- [S0107] OpenAI *Optimizing LLM Accuracy*——把 prompt engineering 放在 RAG vs fine-tuning 双轴框架里。
- [S0111] OpenAI *GPT-5.5 Prompt Guidance*——GPT-5.5 专项指南（2026-05）：outcome-first framing / personality+collaboration 分离 / retrieval budgets / grounding rules / output contracts via text.verbosity。核心主张：模型越强，prompt 应越抽象——把执行决策交还模型，而非过度规定流程。
- [S0143] *asgeirtj/system_prompts_leaks* repo README——167 个 .md 真实生产 system prompt 的索引，本批 mythos 入库 13 个 Tier 1。
- [S0144]–[S0148] Anthropic 系：Claude Opus 4.7 / 4.6 / Sonnet 4.6 / Claude Code / Cowork 的真实生产 system prompt（leaked）。
- [S0149]–[S0152] OpenAI 系：ChatGPT GPT-5.5/5.4 Thinking + Codex GPT-5.5/5.3-codex 的真实生产 system prompt（leaked）。
- [S0153]–[S0154] Google 系：Gemini 3.1 Pro + Gemini CLI 的真实生产 system prompt（leaked）。
- [S0155] xAI Grok 4.3 beta 的真实生产 system prompt（leaked，sandbox env）。
- [S0156] Cursor agent 的真实生产 system prompt（leaked）。
