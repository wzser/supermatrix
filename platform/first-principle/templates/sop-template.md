---
name: [kebab-case-name；与文件名（不含 .md）保持一致]
description: [1 句话浓缩触发条件——agent 不读全文也能判断要不要展开。建议格式："当 <触发条件> 时使用；不覆盖 <反触发场景> 。" 这一行会被 sop/INDEX.md 当作菜单条目，写得越具体 + 越能区分相邻 SOP 越好。]
# 可选：trigger_keywords: [关键词1, 关键词2]  ——只在长链路 / 文件名触发等需要机器匹配的 SOP 写
# 可选：type: long-chain  ——长链路叙事型 SOP 标这条以豁免 per-step 5-段式检查
---

# SOP: [Task Name]

> Created: [date] | Last updated: [date]

> **Writing style（写作风格）**：
> - **Imperative + 解释 Why**：用祈使句（"做 X"），并在关键处加 `Why：<原因>` 一行；少用大写 MUST/NEVER，agent 读懂"为什么"才有能力处理边界情况。
> - **Body 精简（软上限 300 行）**：复杂规则、长案例、可重复执行的检查 → 外放到 `scripts/` 或 `references/`（见下方 Companion Files）。body 内联 case >30 行 / 内联 shell >15 行就外放。
> - **像 skill 一样路由**：frontmatter 的 `description` 是 agent 的第一道筛选；"不适用场景"是第二道。两条都不糊弄。

## 核心目标（What problem does this SOP solve）

**这是一个什么类型的 SOP：** [例如：新品广告投放 / 数据同步 / 审批流程 / ...]

**它要解决什么问题：** [用 1–3 句话清晰说明 — 痛点是什么、不做会怎样、做了之后达到什么状态]

## When to Use

[触发条件 — 什么时候应该按这个 SOP 执行？至少列 2–4 条具体场景，包含可识别的关键词、消息特征、文件名模式或外部事件。]

**不适用场景（Do NOT use when）—— 必填**：

- [反向触发 1 — 容易和本 SOP 混淆但不该走本流程的场景，至少 1 条。例如："只查询不写回"、"邻近 SOP `<name>` 覆盖的子场景"]
- [反向触发 2 — 如有可能和相邻 SOP 撞车，必须显式说明边界]

> 提示：若本 session 没有相邻 SOP 可能误触发，写 1 条最常见的"看起来像但实际不是"场景也比留空好。
> "不适用" 的存在本身就是路由信号——告诉 agent "看到这些线索就别选我"。

## See Also（可选 — 仅当本 session 有相邻 SOP 触发条件可能重叠时填）

- `<相邻-sop-名>.md`：如果情况是 [X]，去看那一份
- `<跨-session-协作-sop>`：如果上下游是 [Y]，先跑那一份再回来

## Prerequisites

- [开始前必须就绪的前置条件 — 工具可用性、权限、外部状态、环境变量、库文件等]

## Companion Files (Progressive Disclosure)

> 像 Anthropic Skill 一样三层渐进披露：frontmatter (元数据) / body (执行步骤) / companion files (按需加载)。本节列出 body 引用的外部资产；没有就写 `无`。

- `scripts/<name>.sh|py`：[本 SOP 引用的可执行脚本；确定性校验 / 重复 lookup / 命令包装放这里，body 只写 "运行 `scripts/<name>.sh --arg`"，**不要在 body 里堆 shell**]
- `references/<sop-name>-<topic>.md`：[长 case / 历史决策 / 跨实例对比 / 完整 schema 放这里，body 只留 1 行指针 "详见 `references/<file>.md`"]
- `<其它资产>`：[模板片段、prompt 片段、fixture 数据等]

**外放阈值**：body 内联 case >30 行、或内联 shell >15 行、或单条规则解释 >10 行 → 外放。

## Inputs & Outputs (SOP-level Contract)

> 顶层契约 — 让调用方（人或 agent）一眼读懂本 SOP 进出什么。这部分不是 Step 1 的输入，是**整条 SOP** 作为一个单元的输入输出协议。

**Inputs:**

- `<字段名>: <类型/形态>` — [来源 + 例子。例：`session_name: str` 来自 `$SM_SESSION_NAME` 或 spawn prompt；`target_repo: absolute path` 来自 watchdog spawn]
- `<触发事件/文件/状态>` — [事件型 SOP 必填，例：`data/session-init.ndjson` 末行 `feishu_sync_ok != true`]

**Outputs:**

- `<产物名>: <类型/形态>` — [落到哪里 + 例子。例：`changelog row` 写入 `data/principles-log.db`；`Bitable record` 写入 base/table；`Feishu 消息` 发到 chat]
- [副作用 / 状态翻转：例如 `ndjson 行翻为 feishu_sync_ok=true`]

**Receipt / Verification token:**

- [机器可校验的完成证据。常见三种：
  - **Scheduler 回执**：必须发出 `REPORT: <task-name> ... — <summary>` 单行；
  - **Spawn 回执**：必须原样保留调用方传入的 `comm_<topic>_<ts>` verification token；
  - **文件/DB 探针**：例 `sqlite3 ... | grep -q <pattern>` 返回 0。
- 没有可校验产物的 SOP 也要写"无机器回执，由 Step N 的产物间接证明"。]

## Steps

> **长流程（>3 步）每个 step 必须按以下 5 段结构写；短流程可直接写一行。**
> 固定结构让后续接手方（人或 agent）能快速定位上下游、判断是否可跳过/重跑，排错时精确锁定是哪一步的输入或产物出了问题。
> 长链路叙事型 SOP 在 frontmatter 标 `type: long-chain` 可豁免 per-step 5-段式，但必须保留顶层 skeleton。

### Step 1: [step 名称]

- **要解决的问题（Problem）**：这一步针对的是什么具体问题或卡点？为什么流程里必须有这一步？（如有分支条件，写清判断规则）
- **输入（Input）**：进入这一步所需的数据 / 前置状态 / 触发条件
- **处理（Processing）**：需要做什么操作 — 动作、工具、关键决策
- **产物（Output）**：产出的数据 / 文件 / 状态变化 / 副作用
- **下一步消费方（Next）**：谁（哪个 step / 哪个 agent）会消费这些产物，以及消费方式

### Step 2: [step 名称]

- **要解决的问题**：...
- **输入**：...
- **处理**：...
- **产物**：...
- **下一步消费方**：...

## 禁用项 (Do NOT during execution)

> "不适用场景" 是**路由层反触发**（什么时候不选这条 SOP）；"禁用项" 是**执行期红线**（已经在跑这条 SOP 时不准做什么）。两者职责不同，都不可少。
> 每条禁用项必须带 `Why：<违反时会发生什么>` 和 `How to apply：<什么时候这条规则起作用>`，否则就退化成无解释的 MUST。

- **不准 [<动作>]**。**Why**：[违反时的具体后果——数据丢失 / 状态污染 / 调用方收不到回执 / …]。**How to apply**：[在 Step N 或 X 分支起作用]。
- **不准 [<动作>]**。**Why**：...。**How to apply**：...。

> 典型候选：跳过验证 token / 用 `--as user` 发 Feishu / 在 dirty workspace 下 stash 或 reset / 把 SOP 决策外包给业务 session / 内联秘密到 prompt / 跨 step 复用未持久化的内存变量 / 强覆盖 session-owned 文件 / 漏写 changelog。视 SOP 性质删减。

## Common Pitfalls

- [历史踩过的坑以及规避方法 — 与"禁用项"区别：pitfalls 是**容易踩**的反模式（值得提醒但未必有强约束），禁用项是**坚决不准**的红线]

## Verification

- [如何确认任务已正确完成 — 跟 Inputs/Outputs Contract 的 receipt token 配套：怎么把 token / 探针 / 产物 跑一遍证明 SOP 真的 closed]
- [如可能，给一行可复制的检验命令]

## Examples (Worked Cases)

> 至少 1 个 worked Input→Output 例子；典型路径 + 1 个非平凡分支（被拒、deferred、降级）覆盖一下。短的内联；超过 30 行 → 外放到 `references/<sop-name>-examples.md`，body 只留一行指针。

**Case A — 典型路径**

- **Input**: [具体入参 / 触发事件原文 / 文件状态]
- **Output**: [实际产物 + 写到哪里 + verification token 长什么样]

**Case B — 非平凡分支（被拒 / deferred / 降级 / 错误处理）**

- **Input**: [触发该分支的入参]
- **Output**: [分支的合法终态 + 留给下一轮的什么]
