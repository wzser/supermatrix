# SOP: 使用福尔摩斯（deepautosearch）做深度研究取源

> **触发条件：** 用户给出主题 / mythos 自身判定 concept 缺源、需要补充一批高质量 source；手头没有已知 URL。
> **前置要求：** `kb/CHARTER.md`（原文追求完整原则）+ `sop/kb-capture.md`（本 SOP 的下游）。

## 心法

**福尔摩斯 ≠ 柯南**：
| | 福尔摩斯 | 柯南 |
|---|---------|-----|
| spawn target | `deepautosearch` | `deepsearch` |
| backend | codex (gpt-5.5) | claude |
| 模式 | ChatGPT **Pro 研究级**（web 端登录态） | 普通互联网深搜 |
| 时延 | **≥10 分钟**（首查后每 5 分钟轮询） | 1–5 分钟 |
| 输出 | 综合答案 + inline citations（带 Extracted Links 清单） | summary + claims JSON 数组 |
| 成本 | **每次几毛到几块人民币（GPT Pro tokens）** | 较低 |
| 失败模式 | Pro 不可用 / 登录态过期 → 硬停（不静默 fallback） | claim 出但 confidence 低 |

**用之节俭**：研究级模式真金白银烧 tokens，不要当快讯工具。

---

## 何时用

| 场景 | 用谁 | 理由 |
|------|------|------|
| 用户给具体 URL → 抓取入库 | **kb-capture 标准流程** | 已经是确定 source，不需要研究 |
| 用户提主题，需要"找些好资料" | **福尔摩斯** | 研究级 + 引用规整 |
| concept 综述发现 sub-topic 缺源（如 deep-research-agent §10 待解问题） | **福尔摩斯** | 主动 fill gap |
| 跨主题对比研究（"X vs Y"）需多源 | **福尔摩斯** | Pro 模式视角覆盖更全 |
| 时事 / 实时新闻 / 网页快查 | **柯南** | 福尔摩斯太慢 |
| 简单事实查询（"Y 是什么"） | KB 既有 source 或 web search | 杀鸡用牛刀不划算 |
| 高频重复调用（>10 次/天） | 重新评估，不要福尔摩斯 | 烧钱 |

---

## 步骤

### Step 1. 决定是否值得调

回答 3 个问题：

1. **用 KB 既有 source 能回答吗？** 能 → 不用调
2. **用柯南（deepsearch）够吗？** 够 → 用柯南
3. **预期产出能转化成至少 ≥3 个 KB source（合并入 concept 或独立入库）吗？** 不能 → 推迟到积累更多需求一起跑

### Step 2. 写 prompt（避免反问轮）

福尔摩斯在以下字段缺失时**会先反问一轮**——能避免就避免：

| 字段 | 例 |
|------|-----|
| 主题（必填） | "agent memory 在 2024-2026 年的演进路线" |
| 时间范围 | "最近 12 个月" / "全历史" / "2025 Q3 之后" |
| 地理 / 市场范围 | global / 中文圈 / EU |
| 来源类型 | "academic + lab official"（推荐 mythos 默认） / "industry blogs" / mixed |
| 引用密度 | "每段 ≥2 个引用" |
| 输出格式 | "综述 markdown 结构" / "对比表 + 详解" / "时间线列表" |
| 语言 | en / zh / 不限 |

prompt 模板：

```
研究主题：<主题>
范围：时间 <YYYY-MM ~ YYYY-MM>，地理 <global/中>，来源 <academic + lab official>
引用要求：每个 claim 至少 2 个独立 primary source，inline citation 形如 ([source](url))
输出格式：markdown 综述，包含：
  1. 该领域当前共识
  2. 主要分歧 / open questions
  3. 关键工程实现 / 论文清单
  4. Extracted Links 段（去重后的全部引用 URL）
不接受 paywall-only 或 rumor 性来源。
不接受不能验证的 claim（必须有可点击 URL）。
```

### Step 3. Spawn

```bash
curl -s http://localhost:3501/api/spawn -X POST -H "Content-Type: application/json" -d '{
  "target": "deepautosearch",
  "prompt": "<Step 2 的 prompt>"
}'
```

**spawn 是 sync_inline**——调用方阻塞等 ≥10 分钟。如果在交互回话中：
- 告知用户"福尔摩斯研究中，预计 10–15 分钟，现在做点别的"
- 用 `run_in_background: true` 起后台任务，等通知

### Step 4. 处理返回

福尔摩斯的 `finalMessage` 包含 4 段：
1. 改写后的 research prompt（看一眼是否符合本意）
2. 完成状态（`done` / `error: <reason>`）
3. ChatGPT Pro 的答案正文（markdown，inline citations）
4. 末尾的 `Extracted Links` 段（去重后的全部引用 URL 清单）

副产物（在 deepautosearch workspace 里）：
- `runs/YYYY-MM-DD-<slug>.md` —— ChatGPT URL + 提交时间 + 轮询状态。**mythos 不读 / 不改这个文件**——它是 deepautosearch 的内部状态。

### Step 5. 转化为 mythos sources（按 kb-capture）

两种产出都可以入库：

**A. 综合答案本身入库**（适合"用户问 X 主题，福尔摩斯给了 high-quality 综述"场景）：
- `content_type: chat`（与 S0092 同类——AI 综合产出，含 inline 引用）
- `source_url: chat://deepautosearch-runs/<slug>`
- `author: 福尔摩斯（deepautosearch via ChatGPT Pro）`
- 完整答案正文做 source body
- summary 抽取首段 + 关键 claim
- tags 含 `holmes-research`

**B. Extracted Links 逐条独立入库**（适合"想要每个原始引用都进 KB"场景，更贴 KB 哲学）：
- 解析 `Extracted Links` 段，提取每个 URL
- 对每个 URL 走 kb-capture 标准流程（先 dedup，再 curl + .md trick，再写 source）
- 每个 source 加 tag `via-holmes-<研究问题简称>` 标注溯源
- 综合答案**不**入库（避免重复——links 里的内容才是真正 source；综合答案只是导航）

**C. A + B 兼做**（适合大型主题研究，综合答案做 "概览 source"，每个 link 做 "证据 source"）。

**默认推荐**：B（更贴 mythos KB "事实/观点/草稿分层"原则——综合答案是 opinion 层，归 concept 综述；links 是 fact 层，归 source）。

### Step 6. dedup + concept 编织

每个新 source 走 kb-capture Step 6 判定：是否归入已有 concept、是否触发新 concept、是否挂"待处理"。

如果是 fill gap 场景（Step 1 触发原因），新 source 通常应**直接编织进触发它的 concept**而非挂"待处理"。

### Step 7. 写 intake log

`logs/intake/holmes-YYYY-MM-DD_<slug>.md`：
- 触发原因（哪个 concept gap / 用户 prompt）
- 发给福尔摩斯的 prompt
- 返回综合答案的摘要（首段 + 主要论点）
- Extracted Links 列表 + 每条入库决策（dedup / 入库 SXXX / 抓取失败）
- 是否更新了 concept、更新了哪些段

### Step 8. 同步飞书 + commit

- 新增 source 走 `sync-kb.sh` 标准流程
- 修订 concept → 推 `sync-kb.sh concepts`
- bootstrap log 加一条（如果是大批量 ≥5 source）

---

## 红线

- 不替福尔摩斯重试 Pro 模式失败——硬阻塞需要人工介入（登录态 / Pro 配额）。
- 不并发跑多个研究问题——一次一个，福尔摩斯内部不防并发。
- 不擅自读 / 改 deepautosearch 的 `runs/` 目录——它是对方内部状态。
- 不把福尔摩斯当柯南用——快讯类一律走柯南。
- 不在没确认 KB 既有 source 不够时就调福尔摩斯——浪费钱。
- **每月调用量评估**：如果 mythos 一个月调福尔摩斯 > 20 次，重新评估流程；可能需要批量化或换工具。

---

## 异常处理

- **Pro 不可用 / 登录过期**：返回 `{status: error, reason: ...}`，写 intake log 标 "blocked-on-deepautosearch-availability"，提醒用户处理登录态后重跑。
- **答案质量差**（fewer-than-expected citations / 跑题）：mythos 自己评估是否舍弃；不舍弃就当成 chat 类 source 入库（content_type: chat），但要在 frontmatter 标 `quality: low`。
- **Extracted Links 段缺失** / **格式漂移**：fall back 到从答案正文用 regex 提取 URL；intake log 标格式漂移 + 通知用户。
- **某 link 抓取失败**：标 `content_type: unreachable` 留 metadata，与 AI Valley intake 的处理一致。

---

## 与其它 SOP 的边界

- **`kb-capture.md`**：本 SOP 的下游——拿到 link 之后走 kb-capture。
- **`ai-valley-newsletter-intake.md`**：被动 ingest（newsletter 推过来）；本 SOP 是主动取源（mythos 自发起）。
- **`kb-query-review.md`** / **`cross-kb-capability-review.md`**：与本 SOP 无依赖。
- 当 query review 发现某主题反复被问但 KB 缺源 → 触发本 SOP 主动取源 fill gap（这是两个 SOP 的协作点）。

---

## Changelog

- 2026-05-05 v1：初稿，用户告知 deepautosearch alias=福尔摩斯 + GPT Pro 研究级模式后建立。
