# SOP: KB 查询 / 跨 session 咨询应答

> **触发条件：** 用户提问，或其他 session 通过 `/api/spawn` 咨询 mythos KB。
> **前置要求：** 执行前先读 `kb/CHARTER.md`（原则 6「查询机制」）和 `CLAUDE.md` 的「Consultation Protocol」段。

## Step -1（前置）：请求类型识别 + 显式标签（红线）

**响应第一行必须是请求类型标签**，让用户/调用方一眼看出 mythos 判定这是哪类请求、走哪条 SOP，不依赖事后归纳。

格式：`[<类型>·<sub-intent>·<具体 SOP 或动作>]`

三类请求：

| 类型 | 走的 SOP | 改 KB sources/concepts | 写 query log |
|------|---------|----------------------|-------------|
| **查询** | 本 SOP（`kb-query.md`） | 否 | **是** |
| **维护** | `kb-capture.md` / `ai-valley-newsletter-intake.md` / `using-holmes-deep-research.md` | 是 | 否 |
| **元层** | 改 SOP / cron / 协议本身 | 否（除非 charter / index）| 否 |

判定优先级：

1. 用户给 URL / 文件 / repo / 资料 → `[维护]`
2. 用户提问 / 让我对比 / 盘点 / 解释 → `[查询]`，进本 SOP
3. 用户要改 SOP / cron / 协议 → `[元层]`
4. 混合形态 → 按主诉求归一类；副诉求作为 follow-up
5. 不确定 → `[查询·unknown·kb-query]` 并在响应里说明歧义

判错（标签和实际行为不符）= 红线违反。本 SOP（kb-query）只处理 `[查询]` 类——`[维护]` 走 `kb-capture.md`；`[元层]` 不在本 SOP 内。

---

## 心法

mythos 的失败模式不是"答得不准"，而是"答错了类型"——人家要方案我给概念、人家要确认细节我倾倒综述。所以**最重要的不是把答案打磨得多漂亮，而是先识别调用方实际想要什么 + 诚实告知 KB 有没有**。质量交给模型本身的语言能力。

---

## 步骤

### Step 0. 识别意图（5 类）

从调用方 prompt 形态判断属于哪一类。**不向调用方反问**——按最可能的一类直接答；如果错了，调用方下次 spawn 时会补一句话。

| 意图 | 典型 prompt 形态 | 答案应该长什么样 |
|------|-----------------|----------------|
| **definition / 定义** | "什么是 X" / "X 是什么" | 1–2 句，可附 concept 路径作指针 |
| **inventory / 盘点** | "有哪些 X" / "列举 X 的方案" | 5–10 行结构化清单 |
| **comparison / 对比** | "X 和 Y 区别" / "X vs Y 路线" | 2–4 段，双方各表，分歧明示 |
| **solution / 方案** | "我们要做 X，怎么开始" / "怎么实现 X" | 整段方案，含步骤 + tradeoff |
| **alignment / 对齐确认** | "我打算 X，对不对" / "用 [Sxxxx] 这套合用吗" | 1 句肯定 / 否定 + 1 个潜在风险 |

判定信号：
- prompt 短 + 无 context → 大概率 **definition / inventory**
- prompt 提到调用方"在做 X / 现在的实现是 Y / 打算 Z" → **solution / alignment**
- prompt 包含 "和 / vs / 区别 / 分歧" → **comparison**
- 命中调用方提供了 `purpose` 字段（CLAUDE.md 推荐的 spawn 入参）→ 直接按 `purpose` 走，不二次推断

判不出来 → 记 `intent: unknown`，按 **definition** 答（最保守、最便宜），日志 `notes` 字段写"intent 模糊"。

### Step 1. 读 MAP（红线：不能跳）

打开 `kb/MAP.md`，看：
- 「Concept 综述索引」是否直接命中。
- 「标签地形」是否有相关 tag 组指向某 concept。
- 「尚未成文的概念」/「待处理」是否提到该主题。
- 「争议 / 分歧」是否已记录跨 concept 的张力。

### Step 2. 读相关 concept 综述

定位到 1–2 个最相关的 `kb/concepts/<slug>.md`，读对应章节（不是只看摘要）。重点字段：
- frontmatter `confidence` / `last_updated` / `boundary_with`。
- 正文论点对应的 `[Sxxxx]` 引用。
- 涉及"争议"段时记录双方立场。

### Step 3. 反向索引（按需）

如果调用方明确问"S00XX 出现在哪些 concept"，或需要交叉验证：

```bash
jq -r '.source_usage["S0092"]' _index/source-usage.json
jq -r '.concepts["harness"].cites' _index/source-usage.json
```

`_index/` 是派生品，真相在 `sources.jsonl` + `concepts/`。索引和真相不一致时跑 `python3 scripts/build-index.py` 重建。

### Step 4. 下钻 source（如需）

concept 不足 / 涉及实现 / 调用方要原文 → `kb/sources/<file>.md`：

```bash
grep '"deep-research"' kb/sources.jsonl | jq -r '.id + " " + .file'
```

source = frontmatter + 原文，不做二次加工。读原文用于校验或补具体实现，不替代 concept。

### Step 5. 判断 KB 状态（三态 + 一态）并组答案

KB 状态四档：

| 状态 | 判定条件 | 答案策略 |
|------|---------|---------|
| `has` | concept 已成文 + 引用充足 | 直接按 Step 0 的 intent 深度答 |
| `partial` | 有 source 但未编织进 concept / 仅 placeholder / single-source | 按可获得材料答 + **明说"该主题 KB 覆盖不全，仅基于 [Sxxxx] 原文"** |
| `none` | KB 里完全没有 | 直接说"mythos KB 尚未覆盖该主题"+ 推荐 spawn 哪个 session 或哪个公开来源 |
| `out-of-scope` | 不属于 mythos 知识域（业务 / 框架 / 定时 / Principles） | 见 Step 6 越界路由 |

组答案时：
- 答案的**深度和形态**由 Step 0 的 intent 决定。
- 答案的**可信度强度**由 KB 状态决定。
- 论点必须带引用（`[Sxxxx]` 或 `concepts/<slug>.md` 路径），引用和论点一一对应。
- 多源分歧 → 单独说明并列双方。

### Step 6. 越界路由（mythos 不替别人答 / 不行动）

| 问题域 | 转给 |
|--------|------|
| 业务判断（选品 / 广告 / 补货 / 供应链 / 售后 / 财务 / 预测） | `business-knowledge` 或对应业务 session（`amzdata` / `ads-master` / `gongying` / `after-sales` 等） |
| 框架核心代码（SuperMatrix runtime / hooks / skills） | `supermatrix-root` / `watchdog` / `skill-master` |
| 定时任务 / 运维 | `scheduler` / `watchdog` |
| Principles / CONSTITUTION 改动 | `first-principle` |

返回结构里写：`该问题需要 {session} 来执行——建议 spawn 时 prompt 大致为 "{shape}"`。**mythos 自己不行动**——不写代码、不推飞书、不创建任务。

### Step 7. 写日志（红线：不能跳）

应答完成后，append 一条到 `logs/queries/queries.jsonl`：

```bash
echo '{
  "intent": "...",
  "kb_state": "...",
  "prompt": "...",
  "caller": "...",
  "concepts": ["..."],
  "sources": ["S0xxx"],
  "routing_target": null,
  "answer_summary": "...",
  "notes": ""
}' | python3 scripts/log-query.py
```

字段定义见 `logs/queries/README.md`。日志会被每周一次的 review 流程消费（见 `sop/kb-query-review.md`）。

`notes` 字段在以下情况要写明：
- 我对 intent 分类不确定，按某一档强制归类。
- 调用方在同一会话内修正了我的理解。
- 我观察到 KB 应该有但找不到（drift 信号）。

---

## 红线（违反一条 = bad，无论其他维度多好）

1. **不编造**：每个非 trivial 论点必须能在 KB 找到原文支撑；KB 没有就明说"未覆盖"。
2. **不引用错位**：`Sxxxx` 真实存在 + 论点确实是这条 source 说的；不真懂的论点不安引用。
3. **不行动 / 不越界硬答**：不改文件、不推飞书、不跑脚本；越界问题返回路由建议。

---

## 异常处理

- **MAP 命中但 concept 不足以回答**：读 source 原文补，但 `kb_state: partial` 并明示"基于原文 [Sxxxx]，未经 concept 综述编织"。
- **MAP 完全没命中**：用 `jq` 按 tag 扫 `sources.jsonl`，再决定 `kb_state: partial`（有 source）还是 `none`（完全没有）。
- **调用方要 mythos 行动**：按 Step 6 返回 spawn 建议，记 `kb_state: out-of-scope` + `routing_target`。
- **多 concept 半相关、找不到主轴**：罗列所有相关 concept 路径让调用方选，不随便挑一个深答；intent 大概率是 `inventory`。
- **`_index/source-usage.json` 与 jsonl/concepts 不一致**：`python3 scripts/build-index.py` 重建后再用。

---

## 完整示例

**调用方 spawn 输入：**
```
target: mythos
prompt: "deep research agent 应该什么时候停止搜索？我们在优化 deepsearch session。"
```

**执行：**
1. Step 0：prompt 含"我们在优化 X"→ **alignment** 或 **solution**；倾向 `solution`（他们要的是策略推荐，不仅仅是确认某个具体方案）。
2. Step 1：MAP 命中 `deep-research-agent`。
3. Step 2：读 `concepts/deep-research-agent.md` §5。frontmatter `confidence: low`、单源 [S0092]。
4. Step 5：`kb_state: partial`（仅单源支撑）。
5. Step 7：写日志。

**返回：**
```
不要用单一 depth 阈值。五类停止条件并行：覆盖率 ≥ 0.85；连续 2 轮
marginal_gain < ε；核心 claim 置信度（support ≥ 0.8 ∧ contradiction
≤ 0.2 ∧ source_quality ≥ 0.7）；EVI(query) < cost；预算 guardrail。

> KB 覆盖不全：仅 [S0092] 单源支撑，工程公式未经实证。建议 deepsearch
> 跑 BrowseComp / DeepResearch Bench 后回写校准。

引用：concepts/deep-research-agent.md §5 / [S0092]
```

**日志：**
```json
{
  "intent": "solution",
  "kb_state": "partial",
  "prompt": "deep research agent 应该什么时候停止搜索？我们在优化 deepsearch session。",
  "caller": "deepsearch",
  "concepts": ["deep-research-agent"],
  "sources": ["S0092"],
  "routing_target": null,
  "answer_summary": "5 类停止条件并行；KB 单源 low confidence",
  "notes": ""
}
```
