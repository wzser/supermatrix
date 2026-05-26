# SOP: AI Valley Newsletter Intake

> **状态：** `active`（自 2026-05-04 用户确认 v1.1 规则后启用）
> **触发条件：** scheduler cron `dfb7e7f6-ff80-48aa-be9d-bba0be5e145c` 每天 10:30，或人工触发。
> **前置要求：** mythos 在 `email-admin/permissions.md` 取得 `mailbox-0008` `read=allow / send=deny`；archive 路径可直接读。

## 调度信息

- **scheduler 任务 id**：`dfb7e7f6-ff80-48aa-be9d-bba0be5e145c`
- **频率**：每天 10:30 Asia/Shanghai（`30 10 * * *`）
- **mailbox**：`mailbox-0008` / `Jarvis2@qrzar.com`（AI Valley 订阅地址）
- **archive 路径**：`<CODEX_SKILLS_ROOT>/email-admin/archive/mailbox-0008/`
- **delegation receipt**：回复必须以 `REPORT:` 开头一行总结（scheduler 用 `session_reply_content_check` 判定成功）。
- **手动触发**：

  ```bash
  curl -X POST http://localhost:3500/tasks/dfb7e7f6-ff80-48aa-be9d-bba0be5e145c/run
  ```

## 心法

AI Valley 是 Beehiiv 风格的每日聚合 newsletter——一封含 4–6 个独立 story + sponsor + tools 清单。**按 story 筛、不按 email 筛**。**newsletter 自身不进 KB**——它只是发现通道；source 是 newsletter 链接到的原始文章 / repo / paper。

---

## Filter 规则 v1.1（用户 2026-05-04 拍）

### A. INCLUDE（直接捕获，命中任一即收）

1. agent harness / runtime / 状态管理新设计
2. agent memory（managed memory / CLAUDE.md / 记忆架构 / poisoning）
3. multi-agent orchestration / 新协议（A2A / MCP / ACP）
4. deep research / agentic search / web browsing 自动化（含 computer use）
5. prompt engineering / context engineering 新主张
6. sleep-time compute / agent dreaming / async reflection
7. reasoning model 新范式（o-series / extended thinking / minimal reasoning）
8. agent eval benchmark（GAIA / SWE-bench / BrowseComp / TAU-bench 类新发版）
9. agentic coding 平台**工程深度**内容——非纯产品发布；要 case study / 源码 / 设计思路
10. 未成文概念候选（与 MAP "尚未成文的概念"列表呼应：tool design / agent IDE 对比 / agent costs / UCP 等）
11. **LLM 论文**（arxiv / ACL / ICLR / OpenReview / NeurIPS / ICML）
12. **开源 agent 工程项目**（GitHub repo with substantive README，stars ≥ 200 或来自顶级 lab）

### B. HARD SKIP（静默丢，连 log 都不写）

1. **名人八卦 / 公司内斗 drama**——CEO/高管个人言论 / 法律纠纷个人化 reporting / Twitter 嘴炮 / 高管去留八卦

### C. MARGINAL（走质量闸：substantive 才捕获，否则只 log 不入 KB）

**质量闸定义**——linked article 满足任一即视为 substantive：
- ≥ 500 字实质内容（不是 PR 一句 + 链接）
- 含技术 / 量化数据（benchmark / 代码 / 架构图 / 论文引用）
- 是行业拐点的 primary source（lab 官方公告 / CEO 长文 / 法院判决全文）

满足 → 走 kb-capture 入库；不满足 → 在本封 intake log 记 `marginal-no-capture: <link> <reason>`，不入 KB。

MARGINAL 涵盖：
- 模型发布资讯（model release news）
- 大公司技术博客 link
- 业界 narrative / 趋势分析
- 纯营销 / 工具清单（默认 fail 闸）
- 金融 / 融资 / 上市 / 收购
- 监管 / 政策 / 法律
- 物理机器人 / 硬件
- 应用层垂直行业（医疗 / 金融 / 教育 LLM 案例）
- 图像 / 视频 / 音乐生成

---

## 步骤

### Step 1. 增量识别本次该处理的邮件

```bash
mkdir -p logs/intake
PROCESSED=logs/intake/.processed-eml
touch "$PROCESSED"
ls <CODEX_SKILLS_ROOT>/email-admin/archive/mailbox-0008/*.eml \
  | xargs -n1 basename \
  | sort > /tmp/intake-all.txt
comm -23 /tmp/intake-all.txt "$PROCESSED" > /tmp/intake-new.txt
```

只处理 `From: AI Valley <aivalley@mail.beehiiv.com>` 的邮件——其它来源（早期测试 / 注册确认 / bounce）忽略并标记已处理（避免明天重撞）。

### Step 2. 解析 newsletter 抽 story 清单

每封 newsletter 解析：
- Subject → newsletter title
- Date → newsletter date
- Body（plain-text part 优先；无则 strip HTML）→ 找 "THROUGH THE VALLEY" 段后的 `##### N/` 编号块
- 每个块 → story title（标题）+ body + 内嵌主链接（按优先级：tweet > article > paper > repo > general URL）
- 末尾 "TRENDING / TOOLS / POSTS" 段也抽出来——通常 MARGINAL fail 闸

输出每封 newsletter 的 candidate 清单到 `/tmp/intake-YYYY-MM-DD/<eml>.json`：

```json
{
  "eml": "mailbox-0008-...",
  "subject": "...",
  "date": "2026-04-30",
  "stories": [
    {"index": 1, "title": "...", "body": "...", "primary_link": "...", "links": [...]},
    ...
  ]
}
```

### Step 3. 按 v1.1 规则分类

每个 story 三档之一：

- **A. INCLUDE** → 走 Step 4 直接捕获
- **B. SKIP** → 跳过（不进 log）
- **C. MARGINAL** → 走 Step 4 但加质量闸

判定优先级：先扫 SKIP 关键词（gossip / drama / 高管姓名 + 内斗动词）→ 命中即弃。否则扫 INCLUDE 关键词 → 命中即收。剩下默认 MARGINAL。

### Step 4. 取主链接 + 走质量闸 + kb-capture

对 INCLUDE 和 MARGINAL：

1. **解析 primary_link**——通常是 Beehiiv 跟踪 URL（`fandf.co/...` 或 `link.mail.beehiiv.com/...`）；用 `curl -sLI` 跟随重定向拿 final URL。
2. **质量闸**（仅 MARGINAL 用）：fetch final URL，检查：
   - 全文 ≥ 500 字（去 nav/footer 后）
   - OR 含 `<code>` / 数字 benchmark / 技术图
   - OR 是 lab 官方域（anthropic.com / openai.com / deepmind.google / mistral.ai / qwenlm.ai 等）或顶级 GitHub repo
   过 → 入库；不过 → 在本封 intake log 记 `marginal-no-capture: <link> <reason>`。
3. **入库**走标准 `sop/kb-capture.md`：
   - 优先用 `.md` 后缀拿 raw markdown（Mintlify / OpenAI docs / cookbook 已知支持）
   - 其它站点用 curl + `html2text` 兜底；失败则 WebFetch + 在 frontmatter 标 `legacy_raw_file: webfetch`
   - 每个新 source 分新 ID（`tail -1 kb/sources.jsonl | jq -r .id` +1）
   - 文件名 `YYYY-MM-DD_<provider>-<slug>.md`，`captured` 字段填本次 intake 日期
4. **去重**：如果 final URL 命中已有 source 的 `source_url` 或 `raw_url`，**不**新建——在原 source frontmatter 加 `mirror_urls: [<newsletter URL>]`，本封 intake log 标 `dedup: existing S0XXX`。

### Step 5. 写 intake log

每封 newsletter 一份 `logs/intake/ai-valley-YYYY-MM-DD_<eml-short>.md`：

```markdown
# AI Valley Intake YYYY-MM-DD

newsletter: <subject>
eml: <filename>
date: <YYYY-MM-DD>

## 故事清单 + 判定
1. {title} — INCLUDE → S0XXX (link: ...)
2. {title} — SKIP (reason: 名人八卦)
3. {title} — MARGINAL → 过闸 → S0YYY
4. {title} — MARGINAL → 不过闸 (reason: PR 一句 + 链接)
5. {title} — dedup S0ZZZ
...

## 本次新增 source
- S0XXX <title> <url>
- S0YYY <title> <url>

## 本次跳过 / 不过闸
- {title}: B 类，名人八卦
- {title}: C 类不过闸，{reason}
- {title}: dedup → S0ZZZ
```

### Step 6. 更新已处理列表

```bash
basename "$EML" >> logs/intake/.processed-eml
```

每封处理完单独追加，避免中途崩溃丢状态。

### Step 7. 批后兜底

所有新邮件处理完：

```bash
python3 scripts/rebuild-map.py
python3 scripts/build-index.py
./scripts/sync-kb.sh    # 推飞书全量
```

如果本次 0 新 source（全跳 / 全 dedup）：仍写 daily intake summary log + 更新 `.processed-eml`，避免明天重撞。

最后一行 `REPORT: AI Valley YYYY-MM-DD intake — 处理 N 封 / 新增 K 个 source / 跳 M 个 / marginal-no-capture L 个 / dedup P 个`。

---

## 红线

- newsletter blurb 不进 `kb/sources/`——只引用 newsletter 链接到的原始文章。
- B 类（名人八卦）静默丢，不写 log，避免日志被噪声塞满。
- 质量闸由 mythos 自己判，**不每条问用户**——首跑后用户可看 intake log 决定是否调整规则。
- 每封 newsletter 处理完立刻更新 `.processed-eml`——不要批量末尾才更新，避免崩溃丢进度。
- 不写假占位 source——抓取失败就 `content_type: unreachable` + 留 metadata，不要编内容。
- 不读邮箱密码 / 不调 IMAP / 不调 SMTP——全部走 email-admin 授权后的 archive 文件读。

---

## 异常处理

- **某邮件解析失败**（编码 / 结构异常）：跳过该封，记到 `logs/intake/.parse-failures`，仍标记已处理；继续处理下一封。
- **某 story 链接死链 / 付费墙**：标 `content_type: unreachable`，frontmatter 留 metadata + newsletter 摘要片段做 fallback；不阻塞其它 story。
- **同一 URL 已抓过 < 24h 内**：直接 dedup，不重复 fetch。
- **整批超时**（超过 task `expectedDurationMs: 30min`）：`overlapPolicy: skip_if_running` 处理；当前批次保留已处理状态，剩余 newsletter 下次跑。
- **REPORT 不输出**：scheduler 的 `session_reply_content_check` 会标 evidence_missing；mythos 必须保证最后一行是 `REPORT: ...`，即使 0 新 source。
- **archive 目录不存在 / 为空** → 写 report `no-input`，正常退出。

---

## 与其它 SOP 的边界

- **`kb-capture.md`** 是被本 SOP 调用的下游——本 SOP 决定『要不要捕获』，kb-capture 决定『怎么捕获』。
- **`kb-query.md` / `kb-query-review.md`** 与本 SOP 无依赖——它们处理被咨询场景；本 SOP 处理 ingest。
- **`cross-kb-capability-review.md`** 与本 SOP 无依赖——后者关注跨 KB 工程机制；本 SOP 关注内容 ingest。
- 本 SOP 不触发 concept 综述新建——只补 source；concept 升级走 kb-capture Step 6 的判定（同 `concepts/` 已有的 prompt-engineering / multi-agent-orchestration 等是否要加引用）。

---

## Changelog

- 2026-05-04 v1.1 启用：用户确认 A/B/C + 质量闸结构；scheduler 任务 id 已注册；首批 catch-up 22 封历史 newsletter。
- 2026-05-03 v0：初稿，`blocked_on_mailbox_onboarding`，待 email-admin 完成 archive 上线。
