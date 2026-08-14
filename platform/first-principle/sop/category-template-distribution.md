# SOP: 分类模板分发（Category Template Distribution）

> Created: 2026-04-18 | Last updated: 2026-05-11

## 核心目标（What problem does this SOP solve）

**这是一个什么类型的 SOP：** 分类模板（`claude-md-{category}.md` / `agents-md-{category}.md`）的制作与柔性分发流程。

**它要解决什么问题：** FP 要把一份分类参考模板落地到同类的多个 session 身上。过程不能走「强覆盖」——每个 session 对自己的 CLAUDE.md / AGENTS.md 拥有所有权。但也不能只扔一句「给你个模板自己看」就完事——session 不知道怎么消化、保留哪些、删哪些、最后要不要对称。这个 SOP 固化整个 bottom-up 调研 → 模板定稿 → 带要求分发 → 验收归档的全流程，保证 Phase 2/3/4（工具/平台/知识）不需要重新拍脑袋。

## When to Use

- 新建某个分类（平台 / 知识 / 业务 / 工具 / 外部）的参考模板时
- 对已有分类模板做较大修订、需要重新分发让 session 对齐时

## Prerequisites

- 已确认分类列表（当前 5 类：平台 / 知识 / 业务 / 工具 / 外部）
- `sessions` 表里所有活跃 session 的 `category` 字段已标注
- 目标 session 可被 spawn（多次超时的跳过记 `deferred`）

## Steps

### Step 1: Bottom-up 调研同分类现存 session

- **要解决的问题**：模板必须从已有实践中抽取共性，不能凭空造。直接写理想态会脱离实际，分发时冲突一大片。
- **输入**：分类名（例如「工具」）、从 DB 查出的该分类下所有 session 及其 `workdir`：
  ```bash
  sqlite3 $SM_RUNTIME_ROOT/data/supermatrix.db \
    "SELECT name, workdir, backend FROM sessions WHERE category = '<category>' AND status != 'deleted';"
  ```
- **处理**：
  - 逐一 Read 每个 session 当前的 `CLAUDE.md` / `AGENTS.md`（可并发调 Read）
  - 用表格梳理每个 session 写了哪些规则/章节，哪些是共性、哪些是 session 专属
  - 识别该分类的**典型工作形态**（例：业务类的「规则单一事实源+多位一体同步」、工具类的「能力边界+被调用契约」等）
- **产物**：一份内部笔记（无需落盘），列出分类共性习惯 3–5 条 + 填空段列表
- **下一步消费方**：Step 2（起草模板时依据共性笔记）

### Step 2: 起草 English 版 category 模板

- **要解决的问题**：有了共性和填空段结构后，要做成正式的 FP `templates/` 文件。**templates/ 下的所有文件统一英文 SSoT**（见 memory `feedback_fp_templates_english.md`）。
- **输入**：Step 1 的共性笔记
- **处理**：
  - 在 `templates/` 下创建 `claude-md-<category>.md`（若分类有 codex 后端 session，同时创建 `agents-md-<category>.md`，内容与 CLAUDE 版对称，仅 header 说明「Codex backend」不同）
  - 结构统一为：Principles 阅读优先级 → 分类核心习惯 → 填空段（Your Responsibilities / Cross-Session Collaboration Protocol / 规则治理 / Workspace Layout）
  - 填空段要明确**哪些可以删、哪些必须填**，用 "(fill in per session)" / "(fill in per session, optional)" 标注
  - 顶部要有 disclaimer：「FP will not force-overwrite your file — this template is advisory」
- **产物**：`templates/claude-md-<category>.md`（+ 可选 `agents-md-<category>.md`）
- **下一步消费方**：Step 3 交给用户审阅

### Step 3: 向用户展示草稿，拿到「可以分发」的确认

- **要解决的问题**：模板一旦分发出去，下游会照着改。分发前必须由用户把关——命名、措辞、章节取舍、哪些是硬性要求。
- **输入**：Step 2 产出的模板文件
- **处理**：
  - 在对话里把模板关键段贴出来（不是只说「已写入磁盘」）
  - 明确询问：分类命名是否 OK、核心习惯要加/减什么、措辞是否直白、填空段的取舍
  - 根据反馈迭代，**直到用户说「可以，分发吧」或等价确认**
- **产物**：用户显式确认
- **下一步消费方**：Step 4 的 spawn 分发

### Step 4: 构造带明确要求的 spawn prompt，分发到各 session

- **要解决的问题**：这是本 SOP 最容易出事的一步——如果 prompt 里只给链接不给要求，session 可能根本不改，或者乱改。必须一次性交付：参考位置 + 改写边界 + 验收标准 + 回报格式。
- **输入**：Step 2 的模板路径、Step 1 查出的 session 列表
- **处理**：

  **每个 session 独立构造一份 prompt，核心段落如下**（逐段都要有，一段都不能省）：

  **(a) 背景与分类归属**：告诉 session「你被归类为【X】类」+ 同类 sibling 有谁。

  **(b) 新流程要点**：
  - 每个 session 对自己的 `CLAUDE.md` / `AGENTS.md` 拥有所有权
  - FP 不再强制覆盖；原 `<!-- BASE:BEGIN/END -->` 机制已废除
  - 分类模板是**参考 demo，不是强制规则**

  **(c) 模板路径**：
  - 给**绝对路径**（不是相对路径，session 工作区不同）
  - 明确 claude 后端只用 `CLAUDE.md`，codex 后端 `AGENTS.md` 为主 + `CLAUDE.md` 保持对称

  **(d) 改写要求（关键）**——每条都要写清「做什么 + 边界」：
  1. **先读两份模板**（claude-md-<category>.md 和 agents-md-<category>.md，如适用）
  2. **分类通用核心习惯按模板保留**（「先查再动、共享状态先确认、规则单一事实源、SOP 纪律」等——具体几条看分类）
  3. **填空段按实际情况填**：「Your Responsibilities / Cross-Session Collaboration Protocol / 规则治理 / Workspace Layout」；**没有内容的段可以删**
  4. **要明确标出 session 自己的业务特色**（广告投放 / 补货 / SQL 工具 / 数据仓库...），不能只照抄模板套壳
  5. **CLAUDE.md 与 AGENTS.md 必须对称**（codex 后端 session 适用）——内容一致，仅 header 可说明后端不同

  **(e) 语言要求（硬性）**：
  - FP 仓库模板是英文 SSoT
  - **Session 自己的 CLAUDE.md / AGENTS.md 也必须用英文**——整篇 rewrite 成英文，连同原本中文的段落一起转换
  - 允许保留中文的场景仅限：飞书表格名、飞书群名、中文工具名、中文身份别名等专有名词，嵌在英文行内
  - 这条是 2026-04-18 用户反馈后升级的硬性要求（memory `feedback_fp_templates_english.md`）

  **(f) 回报格式（强制）**——session 完成后必须汇报三件事：
  1. 做了哪些改动（新增/删除/重写的段落清单）
  2. 保留 vs 删除了哪些填空段，为什么
  3. CLAUDE.md 和 AGENTS.md 是否对称（如适用）

  **(g) 免责声明**：这是参考 demo，不是强制覆盖。按自身需要增删段落——**方向符合分类特质即可**。后续 FP 巡检只会通知冲突或冗余，不代改。

  **分发方式**：并发发起（同分类 session 互不依赖）——
  ```bash
  curl -s -X POST http://localhost:3501/api/spawn \
    -H 'Content-Type: application/json' \
    -d '{"target": "<session>", "from": "first-principle", "prompt": "<上面构造的完整 prompt>"}'
  ```
  或用 `/tmp/spawn-<session>.json` 存好 prompt 再分别调用（便于 review）。

- **产物**：每个 session 返回 `{"ok": true, "finalMessage": "..."}` + session 文件已修改
- **下一步消费方**：Step 5 的验收

### Step 5: Trust-but-verify 验收

- **要解决的问题**：session 的 `finalMessage` 只是「它说它做了什么」，不是实际做了。过去出过 session 报告修改完成但文件其实没动的情况。
- **输入**：Step 4 的 session 返回 + 各 session workdir 路径
- **处理**：
  - 检查文件时间戳是否在分发之后（`ls -la <workdir>/CLAUDE.md`）
  - 对称性抽检（codex 后端）：两份文件行数/大小是否接近
  - 任一异常 → 再次 spawn 该 session 让它修复，不要 FP 代改（除非用户授权）
- **产物**：所有 session 的文件状态验收通过
- **下一步消费方**：Step 6 归档

### Step 6: 归档日志 + 提交 + 飞书同步

- **要解决的问题**：这轮分发要在 `data/principles-log.db` 留痕，方便 Reflection 阶段复盘；飞书变更表也要同步；git 要 commit。
- **输入**：Step 5 验收结果
- **处理**：
  - 写 changelog 记录：
    ```bash
    sqlite3 data/principles-log.db "INSERT INTO changelog (trigger_type, trigger_source, target_doc, judgment, judgment_reason, change_summary, change_detail, request_file) VALUES ('user_command', 'user', 'claude-md-<category>', 'accepted', '<reason>', '<summary>', '<detail>', NULL);"
    ```
  - 飞书变更表同步（注意：「目标文档」select 字段里要先有该 category 选项，没有先加）
  - git commit 模板文件 + changelog DB 变更，两个 commit 分开：
    - 一个：`templates: Phase N pilot — <category> category reference templates`
    - 一个：`log: Phase N pilot — <category> category distribution`
  - `./scripts/sync-feishu.sh` 推 Wiki（如修改了 `*-principles.md` 才需要）
- **产物**：changelog 入库 + 飞书同步 + git 提交
- **下一步消费方**：用户 review + 下次分类模板分发复用本 SOP

## Common Pitfalls

- **分发 prompt 缺少「改写要求」**：只给模板链接不给指令，session 要么不动要么乱改。Step 4 每一条都不能省。
- **忘了 trust-but-verify**：只看 session 返回的文字汇报，不验证文件。曾出现过 session 说改了但实际没落地。
- **Session CLAUDE.md/AGENTS.md 保留中文**：2026-04-18 起，session 自己的 CLAUDE.md/AGENTS.md 也必须英文。分发 prompt 里必须明确要求「rewrite in English」，巡检发现中文 session 文件要 spawn 通知改。
- **FP 代改越界**：巡检发现冲突/冗余，只能 spawn 通知 session，**不代改**。代改必须先 spawn 拿到确认（两层柔性分发第二层）。
- **忘了加飞书 select 选项**：`目标文档` 字段不存在 `claude-md-<category>` 时 `record-batch-create` 会 400。提前 `field-update` 加齐 8 个 category 选项。
- **Codex 升级期跳 codex session**：记 `patrol/deferred`，恢复后补做。不要试图强推。

## Verification

- [ ] `templates/claude-md-<category>.md`（+ 可选 `agents-md-<category>.md`）已提交
- [ ] 同分类所有活跃 session 的 CLAUDE.md / AGENTS.md 均已自改（文件时间戳在分发后）
- [ ] Codex session 的 CLAUDE.md 与 AGENTS.md 大小/行数近似对称
- [ ] `data/principles-log.db` 至少两条记录（模板起草 + 分发验收）
- [ ] 飞书变更表同步无报错
