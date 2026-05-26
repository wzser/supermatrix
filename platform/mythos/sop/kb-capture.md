# SOP: KB 内容捕获

> **触发条件：** 用户发来新链接 / 文本 / 项目，要求归档、阅读或纳入知识库。
> **前置要求：** 执行前先读 `kb/CHARTER.md`（尤其是 §1 五个核心组件、§2 六条原则）。

## Step -1（前置）：请求类型识别 + 显式标签（红线）

**响应第一行必须是请求类型标签**——本 SOP 处理的是 `[维护]` 类。完整格式 + 判定规则见 `sop/kb-query.md` Step -1（共享约定）。

简表：

| 类型 | 走的 SOP | 改 KB sources/concepts | 写 query log |
|------|---------|----------------------|-------------|
| **查询** | `kb-query.md` | 否 | 是 |
| **维护** | 本 SOP / `ai-valley-newsletter-intake.md` / `using-holmes-deep-research.md` | **是** | 否 |
| **元层** | 改 SOP / cron / 协议 | 否 | 否 |

进本 SOP 之前，标签例：
- `[维护·kb-capture]` 用户给 URL / 推 / 论文 / repo
- `[维护·ai-valley·cron]` 每天 10:30 newsletter intake
- `[维护·holmes·deep-research]` 主动取源

如果识别为 `[查询]` 或 `[元层]`，**不进本 SOP**——分别走 `kb-query.md` 或元层动作。

---

## 步骤

### Step 1. 识别输入并拿到原文
**原则：原文追求完整。** 优先用 raw 链接抓取，不用 AI 摘要层。

- **GitHub repo** → 用 `curl -sL https://raw.githubusercontent.com/<owner>/<repo>/<branch>/README.md` 拿原始 markdown。
- **博客 / 文章** → 尽量找 raw 或 RSS 链接；否则 WebFetch 要求"返回完整原文，不要总结"。
- **Twitter / X** → 展开线程全文，保留推文顺序。
- **用户粘贴** → 直接作为原文。
- **PDF** → 用 Read 工具抽文字。
- **图片** → 原文里的 `![alt](url)` 先保留原始 URL，Step 4.5 用 `scripts/fetch-images.py` 下载到 `kb/sources/_media/<sid>/` 并把引用改成相对路径。
- **YouTube 视频** → 用 `scripts/fetch-transcript.py <url> > /tmp/kb-fetch/<sid>.md` 抓字幕。成功（exit 0）→ `content_type: transcript`，正文即字幕 + oEmbed metadata。失败（exit 2；常见原因：YouTube 反爬 / IP 被封 / 无字幕）→ `content_type: unreachable`，正文保留已抓到的 metadata + 失败原因，不阻塞归档；后续用户在有 browser cookie / 可用 IP 的环境下可重跑覆盖。
- **其它视频 / 音频** → 仍只存 URL + 文字描述，不下载二进制。
- **没有 URL，只有研究主题** → 走 `sop/using-holmes-deep-research.md`：spawn `deepautosearch`（福尔摩斯，GPT Pro 研究级，≥10 分钟）拿综合答案 + 引用 URL 列表，逐条折回本 SOP 入库。

抓取结果先放 `/tmp/kb-fetch/` 或类似临时位置。

### Step 2. 读 MAP + concepts + 相关 sources（红线：不能跳）

1. 打开 `kb/MAP.md`，看 KB 当前地形和已成文概念索引。
2. 读 `kb/concepts/*.md` 里和新内容相关的 concept doc（判断新 source 会不会进某个已有 concept）。
3. 在 `kb/sources.jsonl` 按 tag 过滤相关 source：
   ```bash
   grep '"<some-tag>"' kb/sources.jsonl | jq -r '.id + " " + .title'
   ```
4. 必要时读对应 source 文件了解原文。

### Step 3. 分配新 ID

```bash
tail -1 kb/sources.jsonl | jq -r .id
```
新 ID = 上一个 +1，零填充到 4 位（`S0001`, `S0002`, ...）。

### Step 4. 写 source 文件（frontmatter + 完整原文）

文件名：`YYYY-MM-DD_slug.md`
- 日期用 `published`（未知时用 `captured`）。
- slug：小写 kebab-case，从标题提炼 3-5 词。

格式（严格二段式）：
```
---
id: S00XX
title: ...
author: ...
source_url: ...
raw_url: ...       # 可选
published: YYYY-MM-DD | unknown
captured: YYYY-MM-DD
content_type: blog | paper | tweet | repo | docs | transcript | chat
language: en | zh | ...
license: MIT | CC-BY | unknown | ...
---

<完整原文，原封不动>
```

推荐操作模板：
```bash
cat > kb/sources/<file>.md << 'FM_EOF'
---
id: S00XX
title: ...
...
---

FM_EOF
cat /tmp/kb-fetch/<raw>.md >> kb/sources/<file>.md
```

**不要在 source 里写摘要 / 核心观点 / 与 KB 关系。这些是 jsonl 和 MAP 的职责。**

### Step 4.5. 抓取 source 内嵌图片

```bash
python3 scripts/fetch-images.py kb/sources/<file>.md
```

脚本行为：扫 markdown 里所有 `![alt](http...)`，逐张下载到 `kb/sources/_media/<sid>/NN.ext`，并把原文里的 URL 原地改写成 `./_media/<sid>/NN.ext`。硬限制：单张 ≤ 5MB，`Content-Type: image/*`，允许 png/jpg/gif/webp/svg。失败的会留原 URL 不动并在 stderr 打 `FAIL` 行。

**不回溯旧 source。** 这个步骤只对本次新写的 source 生效；老 source 的网图保持原样（用户决策 2026-04-20）。

### Step 5. 追加 sources.jsonl

用 Bash `>>` 追加一行。所有元数据 + summary 集中在这里：

```bash
echo '{"id":"S00XX","file":"sources/...","title":"...","author":"...","source_url":"...","raw_url":"...","published":"...","captured":"...","content_type":"...","language":"...","license":"...","tags":["..."],"summary":"一句到三句话的扫读摘要"}' >> kb/sources.jsonl
```

**摘要规范：** 一到三句话。要包含：核心主张 / 关键概念 / 适合谁读。这是 KB 唯一的摘要载体。

### Step 6. 判断 concept 归属并更新综述层（核心产出）

**判定（依据摘要 + 内容，不看 source 数量）：**

1. 新 source 明显归属某个已有 concept（例如主题是 harness 就进 `concepts/harness.md`）
   → 打开该 concept doc，把新观点**编织进现有叙事**（不是在末尾贴一段），inline 加 `[S00XX]` 引用；若引入分歧，扩展或新建"争议"段。
2. 新 source 引入了一个**独立、值得专门讨论**的新概念（哪怕只有这 1 篇 source）
   → 新建 `kb/concepts/<slug>.md`（slug 小写 kebab-case），按 CHARTER §4.4 模板写 survey。
3. 新 source 的主题太散 / 还看不出能独立成文
   → 不碰 concept 层，到 Step 7 挂到 MAP 的"尚未成文的概念"清单。

**不要做的：**
- 不在 MAP 里展开观点（那是 concept doc 的职责）。
- 不为了凑数先建空 concept doc。
- 不用 bullet 列表写综述——要流动叙事段落。

### Step 7. 更新 MAP.md（总览层）

只动总览层指标和索引，不展开观点：

- 顶部：`Source 数量：N`，`Concept 综述数量：M`，`最后更新：YYYY-MM-DD`。
- `当前形态`：如果新 source 扩展了 KB 覆盖面，改这段一句话。
- `标签地形`：若 tag 有增减，同步更新（见 Step 8）。
- `Concept 综述索引`：新建 concept 时在表格加一行；既有 concept 被更新时，摘要若过时就改。
- `尚未成文的概念`：把 Step 6 判定 c 的情况挂进来。
- `待处理`：若本次 source 暂时没进任何 concept，挂进去。

### Step 8. 整理标签

用户明确要求：每次更新 MAP 时同步整理一次标签。

1. 扫 `kb/sources.jsonl` 所有 tags。
2. 合并近义（如 `agent-harness` + `harness`）。
3. 更新 MAP "标签地形"段的分组及其指向的 concept。
4. 如改动 tag 名，用 `jq` 回写 `sources.jsonl`：
   ```bash
   jq -c 'if .tags then .tags |= map(if . == "旧" then "新" else . end) else . end' kb/sources.jsonl > /tmp/new.jsonl && mv /tmp/new.jsonl kb/sources.jsonl
   ```

### Step 9. 同步飞书镜像

```bash
./scripts/sync-kb.sh
```

四件事都推：CHARTER / MAP / 所有 concepts / bitable。新建的 concept 会自动建 wiki 节点并写入 `kb/.feishu-manifest.json`。失败了重跑即可（覆盖语义）。

### Step 10. 回报用户

简短汇报：
- 分配的 ID 和文件路径。
- Concept 层动作：更新了哪篇 / 新建了哪篇 / 挂到"尚未成文"清单。
- 是否整理了标签。
- 飞书同步结果（成功 / 失败原因；新建 concept 节点给出 URL）。

---

## 红线

- Step 2（读 MAP + concepts）不能跳。
- Step 4 不得往原文里塞摘要/核心观点等二次加工内容。
- Step 5 不能忘记写 summary（它是 KB 唯一的摘要）。
- Step 6 不在 MAP 里展开观点——观点要么进 concept doc，要么等料。
- Step 6 不用 bullet 列表写综述，要流动叙事。
- `sources.jsonl` 的 id 不回收不复用。
- 所有 source 扔在 `kb/sources/` 扁平目录下，concepts/ 同样扁平，不建子目录。

---

## 异常处理

- **抓取失败**：`content_type: "unreachable"`，source 文件留空 body 或写"抓取失败：<原因>"，仍创建记录。用户可事后补。
- **内容无明显 tag 归属 / 无法进任何 concept**：在 MAP.md "待处理"段挂记一条，源文件照常归档；后续积累到能成文时再拆 concept。
- **与已有 source 内容重复度>80%**：不建新 source，在 MAP 对应观点追加 "另见 <原 URL>"，并把新 URL 写到原 source 的 frontmatter（如 `mirror_urls`）。
