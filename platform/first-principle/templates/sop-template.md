---
id: [6 位随机 alphanumeric，新建时跑 `python3 -c "import secrets,string;a=string.ascii_lowercase+string.digits;print(''.join(secrets.choice(a) for _ in range(6)))"` 生成；与文件名末段一致；**永不可改**——改 SOP/重命名时 ID 必须逐字保留（§8）]
name: [kebab topic-slug；= 文件名去掉 SOP- 前缀和 -<status>-<YYYYMMDD>-<id> 尾；可改]
description: [1 句话路由：当 <触发> 时用；不覆盖 <反触发>。sop/INDEX.md 菜单取这句，越能区分相邻 SOP 越好]
status: draft          # draft | active | deprecated（§8，与文件名一致；锁完自由度+齐异常表才可转 active）
owner: [本 SOP 唯一 owner session 名]
created: [YYYY-MM-DD]
updated: [YYYY-MM-DD]   # 与文件名日期尾一致；改 SOP 同步改这里 + 文件名 + INDEX 行
# 可选 trigger_keywords: [...] / type: long-chain（长链路叙事型，豁免 per-step 5 段）
---

# SOP: [中文名]

## 核心目标（一句话）

[X → Y，解决 Z。1–2 句说清痛点 + 做完达到的状态。机制/历史/缘起别写这儿 —— 下沉到文末 Companion Files]

## When to Use

[触发 2–4 条：关键词 / 消息特征 / 文件名模式 / 外部事件] ｜ **不适用（必填 ≥1）**：[易混但不该走本流程的场景 / 邻近 SOP `<name>` 覆盖的子场景]

## Prerequisites

- [开跑前必须就绪：工具可用性 / 权限 / 环境变量 / 库文件 / 凭证身份（`--as bot|user` 写死）]

## Steps

> 长流程(>3 步)每步按 5 段写；短流程一行即可（`type: long-chain` 豁免 per-step、保留顶层骨架）。锁自由度：数据→写死表+字段+时间窗；计算→公式+阈值(magic number 进参数表引 `param.X`)；LLM→prompt 落 `references/<step>-prompt.md` 单文件。见「合理/适当/视情况/必要时」当即改成具体值。

### Step 1: [名称]

- **要解决的问题**：[针对什么卡点；有分支写清 boolean 可判定条件]
- **输入**：[数据 / 前置状态 / 触发，指向上游 step 的产物]
- **处理**：[动作 / 工具 / 关键决策；锁死自由度]
- **产物**：[数据 / 文件 / 状态变化 / 副作用]
- **下一步消费方**：[哪个 step / agent 怎么消费]
- **失败回滚**：[失败回退到什么状态、谁回滚、回哪步；「人工介入」不算回滚]

### Step 2: [名称]

- **要解决的问题** / **输入** / **处理** / **产物** / **下一步消费方** / **失败回滚**：...

## 异常枚举（§5 — 必填，≥3 行，红线）

> 每个可预见失败位置一行；删任何一行前先确认"它真不会发生"。「出错时通知人工」= 没写完。

| Case | 触发条件（可机械判定） | 判定方式 | 应对动作 | 通知对象 | 升级时限 |
|---|---|---|---|---|---|
| 上游数据脏 / 缺 | [例：字段 X 缺失或类型不符] | [跑前 GET schema 比对 / 非空校验] | [停 + 落错标 / 降级] | [飞书群 or session inbox] | [例：30min 无 ack → 升级 `<群>`] |
| 下游不响应 | [例：spawn 30min 无 ack / API 非 200] | [探针 `select 1 from inbox where ref=<id>`] | [重发 1 次 + 切 fallback] | [...] | [重发仍无 → 标 degraded] |
| 自身计算 / 执行异常 | [例：公式除零 / LLM 输出 schema 不合规] | [JSON 解析 / 断言] | [同 prompt 重试 1 次 → 异常队列] | [...] | [...] |

## 禁用项 (Do NOT during execution)

> 执行期红线（已在跑本 SOP 时不准做什么），区别于 When to Use 的「不适用」(路由层反触发)。每条带 Why + How to apply。

- **不准 [<动作>]**。**Why**：[后果]。**How to apply**：[在 Step N 起作用]。

## Inputs & Outputs 契约（§3 — 用「样本行」，禁止只写类型签名）

> 整条 SOP 作为一个单元的进出协议；每项配一条**真实样本行**，让接手方照样复现而非猜。

- **Inputs**：`<字段>: <形态>` — 来源 + 样本行 `{...}`；触发事件 / 文件 / 状态（事件型必填）
- **Outputs**：`<产物>: <形态>` — 落点 + 样本行 `{...}`；**幂等键**写死且具体（用 record_id 不用展示编号 NO.xxx）
- **Receipt / 验证 token**：[scheduler `REPORT:` 行 / spawn `comm_<topic>_<ts>` token / 文件·DB 探针 `sqlite3 … | grep -q`；无可校验产物也要写"由 Step N 产物间接证明"]
- **批量 evidence（逐项执行才填，§3.1）**：批量 / 逐项处理 N 项时，把每项 evidence 回写日志 / 结果表（本地或飞书）——记录足以事后判定「这项按 SOP 跑了」的痕迹（用了哪个源 / 锁定 prompt / 自检结果）。形态自定，空 / `ok` 不算；目的=只看这列能判每项是否合规。

## Companion Files（渐进披露第 3 层 — 背景下沉处；没有写「无」）

- `references/<sop>-*.md`：机制 / 架构 / 历史事故复盘 / 完整 schema / >10 行 I/O 样本 / prompt 总台
- `scripts/<name>.sh|py`：确定性校验 / 重复 lookup / 命令包装（body 只写「运行 `scripts/<name> --arg`」，别堆 shell）
> 外放阈值：内联 case >30 行、shell >15 行、单规则解释 >10 行 → 外放

## Common Pitfalls

- [容易踩的反模式 + 规避；区别于禁用项(强约束红线)]

## Verification

- [怎么把 receipt token / 探针 / 产物跑一遍证明 SOP 真 closed；给一行可复制命令]

## Examples (Worked Cases)

> ≥1 个 worked Input→Output；典型路径 + 1 个非平凡分支(被拒 / deferred / 降级)。超 30 行外放 `references/<sop>-examples.md`。

- **Case A — 典型路径**：Input [...] → Output [... + verification token 长什么样]
- **Case B — 非平凡分支**：Input [...] → Output [分支合法终态 + 留给下一轮的什么]

## 提交前自检（Definition of Done — 缺一不准合入）

- [ ] **§9 渐进披露**：文件顶到 Step 1 ≤ 25 行（背景全下沉到 Companion Files）
- [ ] **§5 异常枚举**：上表 ≥3 行、每行五要素齐（触发可判定 / 判定方式 / 应对 / 通知对象 / 升级时限），不是「通知人工」
- [ ] **§1-2 自由度全锁**：无「合理 / 适当 / 视情况」；数据 / 公式 / 阈值 / prompt 都写死或引用 `param.X` / 单文件
- [ ] **§3 样本行**：每个 Input/Output 配真实样本行 + 幂等键写死
- [ ] **§8 命名 + INDEX**：文件名 `SOP-<topic>-<status>-<YYYYMMDD>-<id>.md`（新建必带 6 位稳定 ID；存量过渡期改 SOP 时顺手补），frontmatter `id`/`status`/`updated` 与文件名一致，INDEX 六列登记
- [ ] **（批量才需）逐项 evidence（§3.1）**：批量 / 逐项执行把每项 evidence 回写日志表，满足「只看它能判该项是否按 SOP 走」；格式自定，空 / `ok` 不算
