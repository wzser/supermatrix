# KB Charter（知识库工作章程）

> **这是 mythos 知识库的根指引。任何操作 KB 之前必须先读这份文档。**
> 任何后续的 SOP 和操作都必须服从本章程。如有冲突，以本文档为准。

最后更新：2026-04-29（v9）

---

## 0. 目的

建立一个可以**自动化管理**的知识库。解决两个痛点：
- 用户发来的材料零散、格式混乱，检索时找不到。
- 材料越积越多，但没有形成对某个概念（如 Harness、Memory）的整体认知。

---

## 1. 五个核心组件

用户定义的 KB 有五个东西，分两层：**原文层**（source 级）+ **认知层**（concept 级）。

| 组件 | 文件 | 职责 |
|------|------|------|
| **摘要** | `kb/sources.jsonl` 的 `summary` 字段 | 一句话扫读指引，不在原文里重复 |
| **索引** | `kb/sources.jsonl` 整体 | 单一真相源：id / file / meta / tags / summary |
| **原文** | `kb/sources/*.md` | frontmatter + 抓取的完整原文 |
| **知识库总览** | `kb/MAP.md` | 讲 KB 当前覆盖什么、概念在哪里深入；是入口地图，不展开具体观点 |
| **概念综述** | `kb/concepts/<slug>.md` | 单概念的深度综述（survey 式），把多篇 source 编织成一篇叙事，inline 引用 |

**两层关系**：
- MAP 是总览 + 索引 + 未成文概念的清单；
- concepts/ 是逐个概念的深度综述文章；
- 观点不在 MAP 里展开——要深入就进 concept doc，要看原文就进 source。

---

## 2. 六条用户原则（不可违背）

这六条是用户亲自定下的需求，等同于 KB 的宪法。每次操作都要回看。

### 原则 1：抓取与保存
对用户丢过来的链接或内容，必须抓取并保存到本地。
- 必须结构化存储：日期、作者、来源 URL、抓取时间。
- 统一用 Markdown 存储原文；元数据放 JSONL 索引。

### 原则 2：统一保存格式
**不接受格式混乱。** 压缩包、图片、HTML、PDF 等都必须转化后统一归档：
- 正文 → `.md`
- 图片 → 抓到 `kb/sources/_media/<sid>/NN.ext`，source 正文里引用改为 `./_media/<sid>/NN.ext`（由 `scripts/fetch-images.py` 自动处理，单张 ≤ 5MB，允许 png/jpg/gif/webp/svg）。
- 视频（YouTube）→ 不落视频二进制；用 `scripts/fetch-transcript.py` 抓**字幕**作为原文（`content_type: transcript`），附带 oEmbed / yt-dlp 元信息。抓不到（YouTube 反爬 / IP 被封 / 无字幕）时记 `content_type: unreachable`，正文留 metadata + 失败原因，不阻塞归档。
- 索引 → `.jsonl`
- 禁止 `.zip` / `.html` / 散落图片 / 裸 URL 混入。

### 原则 3：结构化归档（初期从简）
- **不在文件名里打标签**（用户明确要求）。
- 所有标签 / 分类信息都放在 `kb/sources.jsonl`。
- 所有 source 文件都扔在 `kb/sources/` 同一目录下，不搞子目录嵌套。
- 文件名规则：`YYYY-MM-DD_slug.md`（日期 + 简短 slug，便于排序）。

### 原则 4：分层的认知产出
KB 的核心产出是**对概念的整体认知**，分两层：

- **MAP.md = 总览**：讲 KB 当前覆盖什么领域、tag 地形、哪些概念已成文、哪些还在等料。**不在 MAP 里展开观点细节**，那是 concept doc 的职责。
- **concepts/<slug>.md = 概念综述**：每个值得讲的概念一份。写法是 survey 文章——流动叙事，多源编织，inline 引用（`[S00XX]`），点明共识 / 分歧 / 开放问题。不是观点罗列。

**什么时候拆一个 concept 出来**：不看 source 数量，看内容。在 kb-capture Step 6 判断——如果新 source 的摘要显示它引入了一个独立、值得专门讨论的概念（即使只有 1 篇 source），就新建 concept doc；否则只更新 MAP 待成文清单。后续 source 进来再丰富对应 concept。

同一观点被多篇 source 佐证 → concept doc 里的引用并列；观点冲突 → 写"争议"段，双方来源都列。

### 原则 5：自动化更新流程
每次有新内容进来，严格按这个顺序：

1. 抓取正文（优先 raw URL，其次 WebFetch）。
2. 阅读 `kb/MAP.md` 和 `kb/concepts/*.md`，理解现有覆盖和已成文概念。
3. 读 `kb/sources.jsonl`，找可能相关的 source。
4. 分配新 ID，写 source 文件（frontmatter + 完整原文）。
5. 追加一行到 `sources.jsonl`（含 summary）。
6. **判断 concept 影响并更新**：
   - 新 source 命中已有 concept → 更新 `concepts/<slug>.md`（编织进叙事、加引用、必要时扩展"争议"段）。
   - 新 source 引入独立新概念（单篇也算） → 新建 `concepts/<slug>.md`。
   - 都不适用 → 挂到 MAP "尚未成文的概念"清单等料。
7. **更新 MAP.md（总览层）**：Source 数 / Concept 数、tag 地形、concept 综述索引、尚未成文清单。不在 MAP 里展开观点。
8. 借机整理一次标签体系。

**红线：** 步骤 2（先读 MAP + concepts）不能跳。否则会重复观点、漏引用、破坏综述连贯性。

### 原则 6：查询机制
当用户提问时：

1. 先读 `kb/MAP.md`，定位相关概念是否已成文。
2. 有对应 concept doc → 读 `concepts/<slug>.md`（主要的综述载体）。
3. 若 concept 综述不足以回答、或问题涉及具体实现细节 → 按引用 ID 下钻到 `sources/` 读原文。
4. 若 MAP "尚未成文的概念"里列了但没 doc → 直接看 jsonl 按 tag 过滤 source，但回答要说明"该概念尚未形成综述"。
5. 回答时必须带引用（concept doc 路径 + source ID）。

**不允许**跳过 MAP 直接 grep source 文件。

---

## 3. 目录结构

```
kb/
├── CHARTER.md          # 本文件
├── MAP.md              # 总览：tag 地形 + concept 索引 + 尚未成文清单
├── sources.jsonl       # 索引表 + 摘要（单一真相源）
├── sources/            # 原文目录（扁平，文件名不带标签）
│   ├── YYYY-MM-DD_slug.md
│   └── _media/         # source 内嵌图片；按 source id 分子目录
│       └── S00XX/
│           └── NN.ext  # 01.png / 02.jpg / ...（`scripts/fetch-images.py` 生成）
└── concepts/           # 概念综述（涌现式，按需新建）
    └── <slug>.md
```

---

## 4. 数据格式

### 4.1 `sources.jsonl`

每行一个 JSON 对象：

```json
{
  "id": "S0001",
  "file": "sources/2026-04-18_gsd-1-get-shit-done.md",
  "title": "标题",
  "author": "作者 / 组织",
  "source_url": "用户发给我的 URL（可能是 blob/网页）",
  "raw_url": "可选：可直接抓原文的 raw URL",
  "published": "YYYY-MM-DD 或 unknown",
  "captured": "YYYY-MM-DD",
  "content_type": "blog | paper | tweet | repo | docs | transcript | chat | podcast | unreachable",
  "language": "en | zh | ...",
  "license": "MIT / CC-BY / unknown 等",
  "tags": ["..."],
  "summary": "一句话到三句话的扫读摘要"
}
```

字段规范：
- `id`：形如 `S0001`，单调递增，不复用，不回填。
- `published`：作者发布日期，未知用 `"unknown"`。
- `captured`：本地抓取日期，必填。
- `tags`：自由生长；由 MAP.md 的"标签体系"段定期整理。
- `content_type` 取值：
  - `blog` / `paper` / `tweet` / `repo` / `docs` / `chat` / `podcast`：原文可读时正常归档。
  - `transcript`：视频字幕（`scripts/fetch-transcript.py` 抓到字幕时用）。
  - `unreachable`：抓取失败 / 付费墙 / 反爬拦截。body 留 metadata + 失败原因，**不阻塞归档**，未来在更好环境下重抓覆盖。
- 可选字段：`legacy_raw_file`（追溯到原始抓取临时文件路径，例 `/tmp/kb-fetch/<sid>.md`，便于复抓比对）。

### 4.2 `sources/*.md`（二段式）

```markdown
---
id: S0001
title: ...
author: ...
source_url: ...
raw_url: ...           # 可选
published: YYYY-MM-DD
captured: YYYY-MM-DD
content_type: ...
language: ...
license: ...
legacy_raw_file: ...   # 可选；追溯到 /tmp/kb-fetch/* 等临时来源
---

<完整抓取的原文，从原始 Markdown 开头开始，原封不动>
```

**规则：**
- **原文追求完整**，不做摘要/提炼。
- 没有"核心观点"、"与 KB 关系"等章节 —— 这些由 MAP.md 承担。
- 摘要也不在 source 文件里，摘要在 jsonl。
- 文件 = frontmatter + raw markdown。

### 4.3 `MAP.md`（总览层）

```markdown
# KB Map（知识库总览）

最后更新：YYYY-MM-DD
Source 数量：N　Concept 综述数量：M

## 当前形态
<简短说明 KB 当前覆盖什么领域、主要由哪几篇 source 构成>

## 标签地形
<tag 分组表格，指向对应的 concept 综述>

## Concept 综述索引
| Concept | 文件 | Sources | 摘要 |
| ... | concepts/<slug>.md | S0001, S0003 | ... |

## 尚未成文的概念
<主题 + 为什么还不够成文>

## 争议 / 分歧
<跨 concept 的宏观分歧；concept 内部的分歧留在 concept doc 里>

## 待处理
<已抓取但未纳入 concept 综述的 source>
```

**MAP 不展开观点细节。** 观点细节都在 `concepts/<slug>.md` 里。

### 4.4 `concepts/<slug>.md`（概念综述层）

```markdown
---
last_updated: YYYY-MM-DD
confidence: high | medium | low
refresh_cadence: event-driven | weekly | monthly
parent: null              # 或 <parent-slug>
children: []              # [<child-slug>, ...] 或留空
unwritten_children: []    # 已知但尚未拆出的子节点 + 简述原因
boundary_with: []         # 与哪些 sibling concept 划界（路由提示）
---

# <Concept Name>

## 1. 什么是 <concept>
<定义 + 为什么重要>

## 2. 核心问题 / 核心观察
<该概念回答的根本问题，inline 引 [S00XX]>

## 3. <下一段叙事主题>
...

## N. 待解问题
<该概念下尚未收敛的开放问题>

## 来源一览
- [S0001] <简述>
- [S0002] <简述>
```

**Frontmatter 字段（必填）：**
- `last_updated`：上一次实质性综述更新日期（drift-correction 也算，纯排版不算）。
- `confidence`：`high` = 多源一致 + 已成熟综述；`medium` = 有源但有开放问题；`low` = 只有 placeholder 或证据薄弱。
- `refresh_cadence`：该概念的刷新节奏，和 CLAUDE.md "Curation Cadence" 表对齐。

**Frontmatter 字段（可选，concept 树）：**
- `parent`：直系父节点 slug（顶层 concept 用 `null`）。
- `children`：直系子节点 slug 列表。
- `unwritten_children`：已识别但尚未拆出的子节点，每条 `slug: 简述原因`。比 `MAP.md "尚未成文的概念"` 更细——MAP 那段管全 KB，这里管单 concept 内部的拆分计划。
- `boundary_with`：与哪些 sibling concept 划界 + 一句话说明边界，用作路由提示（"问题命中 X 应该走 sibling Y 而非本 concept"）。

  当前 5 concept 是扁平的（全部 `parent: null`，互不嵌套），但保留字段以便后续 concept 数增长时分树。

- **`sync-kb.sh` 推飞书前会剥掉 frontmatter**，飞书端只显示正文。`build-index.py` 审计时会读 frontmatter（缺必填字段会报 warning，见 §9）。

**风格要求：**
- survey 式叙事，不是 bullet 列表。
- 多源编织在同一段里讨论，inline `[S00XX]`，不给每个观点单开 header 。
- 同一主张被多源佐证 → `[S0001] [S0003]` 并列。
- 观点冲突 → 单独一段写清楚双方立场。
- slug：小写 kebab-case，和 tag 体系尽量对齐（例：`harness`, `memory`, `context-engineering`）。

---

## 5. ID 与链接约定

- Source ID：`S0001` 起，零填充到 4 位，永不复用。
- 引用写法：`[S0001]`；MAP 中每个观点 section 结尾或标题下方必须列来源。
- Tag 名：小写 kebab-case。

---

## 6. 不做的事（红线）

- 不在 MAP 里展开观点细节（那是 concept doc 的职责）。
- 不预先为"可能出现的概念"建空的 concept doc（coding-principles：按需演进）。
- 不在文件名里打标签。
- `sources/` 保持扁平（唯一例外是 `_media/<sid>/`，专门放 source 内嵌图片）；`concepts/` 也扁平。
- 不保存视频 / 压缩包 / HTML 等非图片二进制；图片是唯一被允许落盘的二进制类型，走 `scripts/fetch-images.py` 通道。
- 不在 concept 综述里写不带引用的论点。
- 查询时不跳过 MAP 直接 grep source。
- 不给 source 原文加章节 / 做二次加工（frontmatter 之外原封不动）。

---

## 7. 演进机制

- 标签每次更新 MAP 时整理一次，冗余/近义合并。
- 当 MAP.md 超过 ~1000 行，再讨论是否拆分（初期不拆）。
- 当 CHARTER 本身需要修改时，更新顶部"最后更新"日期并在末尾追加 changelog。

---

## 8. 飞书镜像（单向同步）

本地是**唯一真相源**，飞书是**只读副本**。每次同步用覆盖语义，不做双向合并。

### 8.1 镜像结构

根节点（Wiki）：https://YOUR_TENANT.feishu.cn/wiki/<WIKI_NODE_TOKEN>

根节点下固定子节点：

| 本地文件 | 飞书节点 | URL |
|---------|---------|-----|
| `kb/CHARTER.md` | docx | https://YOUR_TENANT.feishu.cn/wiki/<WIKI_NODE_TOKEN> |
| `kb/MAP.md` | docx | https://YOUR_TENANT.feishu.cn/wiki/<WIKI_NODE_TOKEN> |
| `kb/sources.jsonl` | bitable "Sources" 表 | https://YOUR_TENANT.feishu.cn/wiki/<WIKI_NODE_TOKEN> |
| `logs/queries/queries.jsonl` | bitable "Queries" 表（同 base 不同 table） | 同上链接 |

**concepts 子节点**：每篇 `kb/concepts/<slug>.md` 对应一个 wiki docx 子节点，映射记录在 `kb/.feishu-manifest.json`。首次同步某个 concept 时 `sync-kb.sh` 会自动 `wiki +node-create` 建节点并写入 manifest；后续 sync 走 manifest 里的 URL。

### 8.2 Bitable 字段

**Base token**：`<MYTHOS_FEISHU_BASE_TOKEN>`（Sources 与 Queries 共享同一 base，分别为不同 table）

**Sources 表**（`<MYTHOS_SOURCES_TABLE_ID>`）——一行一 source，主键 `source_id`（= jsonl 的 `id`，形如 `S0001`）：

`source_id` / `title` / `author` / `source_url` / `raw_url` / `published` / `captured`（datetime）/ `content_type`（单选）/ `language` / `license` / `tags`（逗号分隔）/ `summary` / `local_path`

**Queries 表**（`<MYTHOS_QUERIES_TABLE_ID>`）——一行一次咨询，无显式主键（按 `timestamp` 排序）：

`timestamp` / `caller` / `intent`（单选：definition / inventory / comparison / solution / alignment / unknown）/ `kb_state`（单选：has / partial / none / out-of-scope）/ `prompt` / `concepts`（逗号分隔）/ `sources`（逗号分隔）/ `routing_target` / `answer_summary` / `notes`

Queries 表的字段定义对应 `logs/queries/README.md` 的字段规范，写入由 `scripts/log-query.py` 接管 jsonl 层、`sync-kb.sh queries` 接管飞书层。

### 8.3 同步脚本

```bash
./scripts/sync-kb.sh               # 全量同步（CHARTER / MAP / concepts / Sources / Queries）
./scripts/sync-kb.sh charter       # 只推 CHARTER
./scripts/sync-kb.sh map           # 只推 MAP
./scripts/sync-kb.sh concepts      # 只推 concepts/*.md（自动建新节点）
./scripts/sync-kb.sh concept <slug># 只推某个 concept
./scripts/sync-kb.sh table         # 只推 Sources bitable
./scripts/sync-kb.sh queries       # 只推 Queries bitable
```

语义：
- **docx**：`lark-cli docs +update --mode overwrite`，飞书端改动会被下次同步覆盖。**上传前 `sync-kb.sh` 会用 `strip_frontmatter` 剥掉 YAML frontmatter**（适用于 CHARTER / MAP / concepts），飞书端只看到正文。
- **bitable**（Sources 与 Queries 一样）：删完所有记录再 `record-batch-create` 重插；chunk 100，避免触发 20 req/s 限流。
- **concepts**：扫 `kb/concepts/*.md`，manifest 里没有的 slug 先 `wiki +node-create --obj-type docx`，然后 docs +update。

### 8.4 触发时机

1. 本地 `kb-capture.md` SOP 完成 Step 6（更新 MAP）后，紧接跑一次 `./scripts/sync-kb.sh`（推全量，包括 Queries 兜底）。
2. 手动修改 CHARTER / MAP 后立刻跑。
3. `kb-query-review.md` 周度 review SOP 完成后跑一次 `./scripts/sync-kb.sh queries`（每周日志兜底入飞书）。
4.（未来）cron 每日兜底一次，防止漏同步。

### 8.5 不做的事

- 不从飞书回拉到本地（单向）。
- 飞书端编辑不保证保留 —— 提醒所有查看者回到本地改。
- 不给 bitable 上传原文附件（原文留在 git，飞书只存索引 / 摘要 / 查询日志）。
- Queries 表**不做实时单条 push**——只在 review 周结时全量重灌。real-time 推送会让每次咨询多一次 lark-cli 调用，成本不值，且与"飞书是只读副本"的语义不符。

---

## 9. 本地索引与审计（agent 检索层）

KB 本体是给人看的 markdown + jsonl。但 agent 在被 `/api/spawn` 咨询时还需要两类机器可读产物：
(a) **反向索引**——知道 `S0042` 被哪些 concept 引用；
(b) **健康审计**——定期暴露孤儿 source / 缺失引用 / 薄弱综述。

两者由一条本地脚本生成：

```bash
python3 scripts/build-index.py
```

### 9.1 产出

| 路径 | 格式 | 消费者 | 入 git | 入飞书 |
|---|---|---|---|---|
| `_index/source-usage.json` | JSON | agent（反向索引 + concept 元信息） | ✅ | ❌ |
| stdout | markdown 审计报告 | 人 / 即时查看 | 不持久化 | ❌ |

`_index/` 在 workspace 根目录，**不在 `kb/` 内**，所以 `sync-kb.sh` 不会扫到它。飞书镜像和本地索引彻底解耦。

### 9.2 审计检查项

脚本扫 `sources.jsonl` + `concepts/*.md`，输出以下检查：

- **Missing `[Sxxxx]`**：concept 正文引用了但 sources.jsonl 不存在的 id——索引断链，必须修。
- **Orphan sources**：没有任何 concept 引用的 source——可能是待沉淀素材，也可能是漏引。
- **Single-source high-confidence**：`confidence: high` 但只引用 < 2 个 source——证据薄弱，应降级或补源。
- **Missing frontmatter fields**：concept 缺 `last_updated` / `confidence` / `refresh_cadence`——违反 §4.4 硬契约。
- **Concept-to-concept link graph**：concept 之间通过 `](../concepts/X.md)` 的跳转关系；全空说明 4 份综述各立山头，未互引。

### 9.3 触发时机

1. 修改 concept 或追加 source 后跑一次，确认审计仍干净。
2. 周度跑一次，发现 drift 出来的孤儿 / 证据薄弱项。
3. **不**在 `sync-kb.sh` 流程里自动跑——审计是治理层动作，和飞书镜像解耦。

### 9.4 不做的事

- 不把 `_index/*` 同步飞书（JSON 在 Wiki 里无可读性）。
- 不让 `_index/*` 替代 `sources.jsonl` 做 source 元数据真相——索引是**派生品**，真相在 jsonl。
- 不引入 Obsidian / MOC / Dataview 等人眼浏览层——mythos 主要被 agent 消费，浏览层 ROI 低（分析见 2026-04-20 session）。

---

## 10. MAP 自动重建与 bootstrap 审计日志

### 10.1 `scripts/rebuild-map.py`

MAP 顶部 metadata 行（`最后更新` + `Source 数量` + `Concept 综述数量`）由 `python3 scripts/rebuild-map.py` 自动重建——这两条数据是从 `sources.jsonl` 行数和 `concepts/*.md` 文件数派生的，手编容易漏。脚本只覆盖 `<!-- AUTO:meta -->` / `<!-- /AUTO:meta -->` 之间的内容，其余 MAP 章节（`当前形态` / `标签地形` / `Concept 综述索引` / `尚未成文` / `争议 / 分歧` / `待处理` / `已知抓取空洞` / `使用须知`）依然手编——这些段落需要人/agent 判断，自动化没意义。

### 10.2 `bootstrap/log.md`

mythos 一次性的或大型结构变动（CHARTER 升 v / 新建 concept / 大批量回溯 / 跨 KB 对齐）追加一行到 `bootstrap/log.md`。git log 已经记了 commit 级历史，但 bootstrap log 只挑"对未来读者真正影响理解的事件"——更适合 onboarding。

格式：
```
## YYYY-MM-DD <事件标题>
- 触发原因 / context
- 实际改动 / 影响面
- commit ref
```

---

## Changelog
- 2026-04-18 初版：落实六条用户原则。
- 2026-04-18 v2：取消 topics/ 目录（综述统一进 MAP）；source 改为二段式（frontmatter + 完整原文）；摘要移至 jsonl；原文追求完整。
- 2026-04-18 v3：加飞书镜像（§8），`scripts/sync-kb.sh` 单向覆盖同步。
- 2026-04-18 v4：引入 `concepts/` 层（涌现式单概念综述），MAP 降为总览层；原则 4/5/6 重写；sync 脚本支持动态 concept 节点。
- 2026-04-20 v5：concept 层新增 YAML frontmatter 硬契约（`last_updated` / `confidence` / `refresh_cadence`，§4.4）；新增 §9 本地索引与审计层，`scripts/build-index.py` 产出 `_index/source-usage.json` 反向索引 + stdout 审计报告；`sync-kb.sh` 推飞书前剥离 frontmatter。
- 2026-04-20 v6：原则 2 反转旧"不存二进制"规定——图片允许落盘到 `kb/sources/_media/<sid>/`，由 `scripts/fetch-images.py` 在 kb-capture Step 4.5 统一处理；视频仍只存 URL。不回溯历史 source。
- 2026-04-22 v7：视频接入——YouTube 用 `scripts/fetch-transcript.py` 抓字幕作为原文（`content_type: transcript`），视频二进制仍不存。抓不到时记 `content_type: unreachable`，metadata 由 oEmbed 兜底。依赖 `pip3 install --user yt-dlp youtube-transcript-api`。
- 2026-04-25 v8：和 business-knowledge 对齐能力（双向）。本侧引入：concept 树字段 `parent / children / unwritten_children / boundary_with`（§4.4，先占位扁平用），`content_type` 列表加 `podcast` 和 `unreachable`（§4.1），source frontmatter 加可选 `legacy_raw_file` 字段（§4.2），新增 §10 `scripts/rebuild-map.py` 自动重建 MAP metadata 行 + `bootstrap/log.md` 审计日志约定。同时提议 BK 引入图片 / transcript 抓取管线 + concept frontmatter 强制 + concept↔concept link graph 审计（spawn 已发出）。
- 2026-04-29 v9：飞书镜像扩出 Queries 表（§8）。`logs/queries/queries.jsonl` 走 `sync-kb.sh queries`（同 base `<MYTHOS_FEISHU_BASE_TOKEN>`、新 table `<MYTHOS_QUERIES_TABLE_ID>`），字段对应 `intent / kb_state / caller / prompt / concepts / sources / routing_target / answer_summary / notes`。同步语义和 Sources 一致（删完重灌、chunk 100），但只在周度 review 后兜底跑一次，不做 real-time 单条 push。
