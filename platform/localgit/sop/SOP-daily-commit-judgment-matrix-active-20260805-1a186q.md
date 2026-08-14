---
id: 1a186q
name: daily-commit-judgment-matrix
description: 当要判定「某仓某文件该不该被 daily-commit 自动提交」时用（机制主循环与人工补提交同一套矩阵）；不覆盖 ignore 类目清单定义（daily-commit-ignore-policy）与 skip 后通知路由（daily-commit-skip-handling）。
status: active
owner: localgit
created: 2026-07-03
updated: 2026-08-05
---

# SOP: daily-commit 提交判定矩阵

## 核心目标（一句话）
把「该不该 commit」从整仓一票的开放式 LLM 判断，改成逐文件三层判定（L0 机械分类 → L1 仓库 manifest → L2 LLM 灰区复审），判定问题固定为**可持久化性**（不是代码正确性）；安全子集用选择性 staging 落库，风险文件留工作区且必有裁决出口，不允许「永远沉默」终态。

## When to Use
daily-commit 主循环处理任一脏仓时；人工按 daily-commit-skip-handling 补提交任一 skipped 仓前。**不适用**：ignore 类目清单本身的增删修（走 `references/daily-commit-ignore-policy.md`，它是类目目录，本 SOP 是判定流程）；分支分叉 / 合并 / 冲突态处置（走 `SOP-repo-branch-merge-patrol-*`）；远程 push / 发布（gitmaster）。

## Prerequisites
- git CLI、codex bin（`/Users/LOCAL_USER/.npm-global/bin/codex`）可用；`data/git-ledger.jsonl` 可追加；`registry/repo-policies/` 目录存在；文末「参数表」全部有值。

## Steps

### Step 1: 证据采集（逐仓）

- **要解决的问题**：现行 reviewer 只见 `--stat` 和 untracked 文件名，证据不足以判文件级安全性。
- **输入**：repo `{name, path}`（来源 = `$SM_RUNTIME_ROOT/data/supermatrix.db` 的 `sessions.workdir`；仅 `status!='deleted' AND scope!='child' AND affiliated_to='first-principle' AND category NOT IN ('外部','员工')`，再保留既有 git repo 检查与 workdir 去重；不读取飞书 `Daily Commit` 列）。
- **处理**：`git status --porcelain=v1 -z` 得文件清单；对每个文件收集五元证据：①路径；②porcelain 状态码；③字节数（`stat`）；④是否二进制（前 8192 字节含 `NUL` 即二进制）；⑤内容样本 —— tracked 文件取 `git diff -- <f>` 前 `param.diff_head_bytes` 字节，untracked 文本文件取头 `param.untracked_head_lines` 行，二进制不取样。单仓内容取样上限 `param.content_scan_max_files` 个文件（优先 R9/根文件，其次 artifact 类）；超限文件仅做路径级分类，并在 run 日志记 `content_scan_truncated`（不静默截断）。
- **产物**：per-file evidence 数组 + 整仓 dirty fingerprint（沿用现行 `getDirtyFingerprint`）。
- **下一步消费方**：Step 2 逐文件分类；Step 4 缓存查找用 fingerprint。
- **失败回滚**：单文件读失败标 `unreadable`（进 L2 时判 OWNER）；`git status` 本身失败 → 该仓记 `processing error`，按异常表 Case-4 处理，不影响其余仓。

### Step 2: L0 机械分类（逐文件，规则表自上而下首条命中即定级，不经 LLM）

| 序 | 类别 | 判定条件（可机械执行） | 处置 |
|---|---|---|---|
| R1 | DENY-SECRET | basename 命中 secret 文件名模式集，或文本内容样本命中 secret 正则集（两个清单见 `references/SOP-daily-commit-judgment-matrix-secret-patterns.md`，为唯一权威） | 永不自动提交、永不自动 ignore；当日发 repo owner 告警（不静默，fingerprint 去重同现行 notify gate） |
| R2 | DENY-DB | 扩展名 ∈ {.db, .sqlite, .sqlite3, .db-wal, .db-shm, .db-journal} | 不提交、不自动 ignore；disposition=`pending_owner`，进 Step 3 manifest 裁决流 |
| R3 | DENY-BIG | 字节数 > `param.big_file_mb`，或（二进制 且 > `param.big_binary_mb`） | 同 R2 |
| R4 | DENY-NESTED-GIT | untracked 目录满足 `test -e <path>/.git` | 不提交；当日 owner 告警（事故类：aftersale-web 误提交嵌套仓，见 decisions log 326a43e 条目） |
| R5 | CONFLICT | porcelain XY 含 `U`，或文本样本含行首 `<<<<<<< ` 标记 | 该仓当日整仓冻结（一个文件命中即全仓不自动提交），转 `SOP-repo-branch-merge-patrol-*` |
| R6 | NOISE | 命中 `references/daily-commit-ignore-policy.md` §2 allowlist 类目 | 按该类目目录既有 auto-remediate 边界追加窄 `.gitignore` 并重筛；不计入待提交集 |
| R7 | IDENTITY | CLAUDE.md / AGENTS.md 新建或 ≥30 行增删（沿用 `isNovelClaudeMdIdentityChange`；stub→formal 例外直提，沿用现行） | 文件级 OWNER，走现行 FP 路由 |
| R8 | ARTIFACT | 首段目录 ∈ `references/daily-commit-ignore-policy.md` §1.5 artifact-first 清单（data/ raw/ logs/ …，以类目目录为准） | 进 Step 3 manifest 查询 |
| R9a | SOURCE-FASTPATH | 首段目录 ∈ §1.5 must-commit 清单（src/ scripts/ sop/ …），且已内容取样、非二进制、非 symlink、可读（R1 secret 筛在前已通过；manifest 命中优先于本行） | 直接 SAFE 并入待提交集，零 reviewer 开销——行为文件即持久化目标本身 |
| R9 | SOURCE | 其余一切（根文件、未列目录文本、行为目录内二进制/未取样件兜底） | 进 Step 4 L2 灰区候选 |

- **产物**：每文件一个 L0 类别。**下一步消费方**：R2/R3/R8 → Step 3；R9 → Step 4；其余当步终态。
- **失败回滚**：分类函数为纯函数（输入 evidence 输出类别），无副作用可重跑。

### Step 3: L1 仓库 manifest 查询（R2/R3/R8 类文件；判断的「记忆层」）

- **要解决的问题**：`data/` 类路径在不同仓语义不同（交付物 vs 垃圾），现行机制永远不问 → budiansha 11507 文件永久沉默。owner 的一次性裁决必须沉淀为机械规则。
- **输入**：`registry/repo-policies/<repo>.json`；不存在视为空 manifest。
- **处理**：按 `rules[]` 顺序做 glob 首条命中。`action` 三值语义：`commit`=并入待提交集；`ignore`=按 R6 边界追加 `.gitignore`；`keep_dirty`=仅表示 owner 明确要求暂留，必须带 `keep_until` 期限，期限前不重复通知但仍是待收敛状态。未命中 → disposition=`pending_owner`；同一 `(repo, 首段目录)` 连续 pending ≥ `param.artifact_digest_days` 天 → 列入每周裁决 digest（digest 机制与升级线见 `SOP-daily-commit-skip-handling-*`，本 SOP 只产出待裁决项）。**待裁决项发出时必须按 `references/owner-decision-rubric.md` §D 模板组装**：附 §A 段摘要（四问 + 默认表）、枚举动作 `commit|ignore|keep_dirty` 及后果、localgit 按准则预判的默认项与一句理由——owner 在准则内选枚举项，不做自由决策；答案不在枚举内不回写，追问一次仍无效按 rubric §C 升级。owner/用户裁决后回写 manifest 一条 rule（幂等键 = `(repo, pattern)`，重复写覆盖旧值并保留 `decided_at` 历史于 `superseded[]`）。
- **manifest 样本行**：`{"repo":"budiansha","trunk_branch":"main","rules":[{"pattern":"data/**","action":"ignore","decided_by":"user","decided_at":"2026-07-07","source":"digest-2026-07-07","rubric":"v1","note":"ABA 周数据为可重建导出，不入库"}]}`
- **下一步消费方**：Step 5 提交装配读 `commit` 类；每周 digest 读 `pending_owner` 累积。
- **失败回滚**：manifest JSON 解析失败按异常表 Case-2（当空 manifest 处理 + 当日修复），不阻塞该仓其余文件。

### Step 4: L2 LLM 灰区复审（仅 R9 文件；整仓无 R9 时跳过本步，零 reviewer 开销）

- **要解决的问题**：现行 prompt 问开放式「是否安全可提交」，reviewer 漂移成代码审查（amzdata 因「疑似回归」被拒、ad-adjust 因「draft SOP 引用未建文件」被拒），且整仓一票制让 1 个可疑文件拖死全仓。
- **输入**：判决缓存先行 —— 查 `data/git-ledger.jsonl` 该仓最近一条记录：dirty fingerprint 相同 → 整套 per-file disposition 直接复用（`decision_source="cached"`），**不调 LLM**；历史 E2（隐私理由）disposition 读取时一律归一化为 SAFE。缓存未命中 → R9 文件的 per-file evidence（Step 1 五元组，含内容样本）。
- **处理**：候选数超 `param.l2_max_files` 时只审前 `param.l2_max_files` 个，溢出件 disposition=`pending_owner`（理由注明 cap；巨量灰区堆走 Step 3 digest/manifest 收编，不产生 ETIMEDOUT 级巨型 prompt）。跑 `references/SOP-daily-commit-judgment-matrix-l2-review-prompt.md`（唯一 prompt 权威，禁止内联改写），喂 `{{repo_name}}` + `{{files_evidence_json}}`；输出 schema：`[{"file":"<path>","verdict":"SAFE|RISKY|OWNER","reason":"<引用 prompt 内枚举理由编号>"}]`。输出不合 schema → 同 prompt 重试 1 次；仍失败 → 该仓本轮记 localgit-owned issue（异常表 Case-1），不占 owner。单次调用超时 `param.reviewer_timeout_s` 秒，单仓两次调用上限。
- **判定信条（prompt 内写死，此处为规则声明）**：只判可持久化性。RISKY/OWNER 理由是封闭枚举：E1 疑似真实访问凭证内容；E3 跨 session 公共契约行为变更且无验证证据；E4 文件不可读/超取样预算；E5 需要 repo-local deliverable 语义裁决。飞书群 ID/名称、人员名称、本地路径与可读的私有客户/业务数据不是阻断理由，必须 SAFE（除非同时命中 E1）。**明确非法的拒绝理由**：代码疑似有 bug、实现未完成、文档/SOP 内容质量、风格问题 —— 一律 SAFE（本地 commit 是持久化检查点，不是发布认可；bug 代码更该先留档，可 revert）。
- **产物**：R9 文件的 verdict + reason；写入 ledger 供缓存与审计。
- **下一步消费方**：Step 5。
- **失败回滚**：LLM 不可用时 R9 文件全部 disposition=`reviewer_unavailable` 留工作区，次日重排队首（Step 6 排序自然保证），不误提交。

### Step 5: 提交装配（选择性 staging，替换整仓 `add -A`）

- **要解决的问题**：`git add -A` 违反 Repo Management Principle §5.2 红线且出过事故；混合脏集全仓卡死。
- **输入**：待提交集 = L1 `commit` 类 + L2 `SAFE` 类（R6 remediate 后仍脏的文件不在集内）。
- **处理**：当前分支待提交集非空 → `git add -- <file...>`（逐文件精确列名，文件名含空格加引号）→ `git -c user.name=localgit -c user.email=localgit@supermatrix.local commit -m "<msg>"`。message 按 Principle §5.5：conventional 前缀 + Why body。剩余文件若全部是 L2 `RISKY|OWNER` 且 reason ∈ `E3|E5`，并同时满足「命名分支、非 in-flight、无 staged 文件、无 merge/rebase/cherry-pick/bisect、无 unmerged path、dirty set 与审查 fingerprint 完全一致」，则在 `LOCALGIT_HOLD_ENABLED=1` 时创建 `localgit/hold/<repo>/<fingerprint12>`，只精确 stage 该集合并提交，随后切回原分支并验证原 branch/HEAD 未变。E1/E4、真实凭据、不可读文件、数据库、大二进制、预 staged 或冲突态永不进入 hold。`pending_owner` 是中间态，不是成功终态。
- **产物**：终态仅为 `committed_current`、`committed_hold`、`ignored`、`blocked_sensitive`、`blocked_conflict`；commit 的 head/parents 与 hold 的 original_branch/hold_branch/hold_commit_sha 入 ledger，每仓一行完整 per-file dispositions（批量 evidence，见 I/O 契约）。
- **下一步消费方**：Bitable 同步、Console 通知（沿用现行）；`committed_hold` 发 `hold_review`，owner 只可裁决 `merge|archive|keep_until`；`pending_owner` 累积进每周 digest。
- **失败回滚**：commit 非 0（hook / index.lock）→ 不删 lock、不改 hook，unstage 用 `git restore --staged -- <file...>` 精确回退，按异常表 Case-4。

### Step 6: 排序与预算（主循环层规则，替换字母序 + 活跃闸门语义反转）

- **要解决的问题**：字母序 + 18 分钟预算把尾部仓永久饿死（wendangwang 244 文件连续 8 天未被审）；现行活跃闸门把「不活跃+stale」仓塞进无人消费的 backlog，方向反了。
- **处理**：①处理顺序 = `last_reviewed_at` 升序（从 ledger 派生；从未审过的排最前，其间按最早脏龄升序，再同分按 repo 名）——被预算跳过的仓次日自动排到队首，无需独立 backlog 队列。②活跃闸门反转：session 在 `param.inflight_window_h` 小时内有非 daily-commit message run → 本轮 defer（reason=`in-flight`，避免与在途工作竞态）；**除此之外一律处理**——「不活跃 + stale」不再是跳过理由，恰是最安全的提交窗口。③循环预算 `param.loop_budget_min` 分钟，预算尽 → 剩余仓记 `time-budget` 终态（次日由①自动优先）。
- **产物**：本轮处理队列与预算截断点，记入 run 日志。
- **失败回滚**：ledger 不可读时退化为字母序 + 全量处理（保守），并按异常表 Case-2 通知。

## 异常枚举

| Case | 触发条件（可机械判定） | 判定方式 | 应对动作 | 通知对象 | 升级时限 |
|---|---|---|---|---|---|
| 1 reviewer 超时/输出不合 schema | 单仓两次调用均超 `param.reviewer_timeout_s` 或二次输出仍非法 JSON | execFileSync timeout / JSON.parse+schema 断言 | 该仓 R9 全部 `reviewer_unavailable` 留工作区，次日队首重试 | Console（source=localgit, level=warn） | 同仓连续 3 天触发 → 降级为纯 L0/L1 处置并入周 digest 报告 |
| 2 manifest / ledger 解析失败 | `JSON.parse` throw 或 schema 字段缺失 | 读取时 try/catch + 必填字段断言 | manifest 当空处理、ledger 退化字母序；当日修复文件 | Console（level=warn） | 当日未修复 → 次日 run 前置检查直接 error 级通知 |
| 3 R1 secrets 命中 | Step 2 R1 判定为真 | 模式/正则清单命中记录 | 不提交不 ignore；owner 群当日告警，按 rubric §D 模板附 §A 敏感内容处置段与默认项（同 fingerprint 只发一次） | repo owner 绑定群 | owner 3 天无处理 → 周 digest 标红升级用户 |
| 4 git 操作失败 | `git status`/`add`/`commit` 非 0 退出 | exit code + stderr | 不删 lock 不跳 hook；精确 unstage 回退；该仓记 `processing error` 终态 | Console（level=warn） | 同仓连续 3 次 → error 级 + 周 digest |
| 5 session 治理读取失败 | `sqlite3 -readonly` 非 0，或 sessions 行不满足预期列数 | execFileSync / 行解析 throw | 中止本轮、写单行 log + notify，不发 owner hint | Console（level=error） | 当日用 refs 的 SQLite 命令复测；连续 2 run → 找 supermatrix-root 恢复 runtime DB / SQLite 可读性 |

## 禁用项 (Do NOT during execution)

- **不准 `git add -A` / `git add .`**。**Why**：会把 DENY/pending 文件打包进历史（aftersale-web 嵌套仓事故），且违反 Repo Management Principle §5.2 红线。**How to apply**：Step 5 只允许逐文件 `git add -- <file>`。
- **不准以「代码可能有 bug / 内容未完成 / 风格差 / 内容私有」为 RISKY/OWNER 理由**。**Why**：commit ≠ release；误拒使行为变更滞留 worktree，正是本机制要防的事故面。**How to apply**：Step 4 理由必须引用 E1/E3/E4/E5 编号，编号外的理由（含历史 E2）按 SAFE 处理。
- **不准自动 ignore R1/R2 类文件**。**Why**：用 ignore 掩盖 secrets / 数据库会把风险从视野里永久藏掉（ignore-policy denylist 继承）。**How to apply**：Step 2 R1/R2 处置只有告警与 manifest 裁决两条路。
- **不准处理 in-flight 仓**。**Why**：与正在工作的 session 竞态，可能提交半成品或撞 index.lock。**How to apply**：Step 6 ② 先判后处理。
- **不准发不带裁决准则与默认建议的 owner ask**。**Why**：裸问题让几十个仓的 owner 各自自由决策，同类内容跨仓五花八门、不可审计不可比。**How to apply**：Step 3 digest 项与异常表 Case-3 告警一律按 `references/owner-decision-rubric.md` §D 模板组装（问题 + 枚举动作 + 准则摘要 + 预判默认项），缺任一要素不发。

## Inputs & Outputs 契约

- **Inputs**：repo 清单 — 来源 `sqlite3 -readonly "$SM_RUNTIME_ROOT/data/supermatrix.db"` 的 `sessions`，过滤 `status!='deleted' AND scope!='child' AND affiliated_to='first-principle' AND category NOT IN ('外部','员工')`，再取唯一的现存 git `workdir`；不读取 Bitable `Daily Commit` 列。样本行 `{"name":"ads-master","path":"/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/ads-master"}`。
- **Outputs**：①commit（可选）；②ledger 行（每仓每 run 一行，**幂等键 = `run_id` + `repo`**）扩展字段样本：`{"run_id":"daily-2026-07-04T19:15:00.000Z","repo":"ad-adjust","action":"commit","head_after":"ab12cd3","per_file_dispositions":[{"file":"sop/INDEX.md","class":"R9","verdict":"SAFE","source":"l2-fresh"},{"file":"full-docs","class":"R9","verdict":"RISKY","reason":"E5","source":"l2-fresh"}],"decision_source":"l2-fresh"}`；③manifest 增量 rule（样本见 Step 3）。
- **Receipt / 验证 token**：`tail -1 data/daily-commits.log` 当日行 + `npm run git-ledger -- --repo <repo>` 能查到本 run 的 per-file dispositions。
- **批量 evidence（§3.1）**：per-file dispositions 数组即逐项 evidence——事后只看 ledger 该行即可判每个文件走了哪层、谁判的、为何留下。空数组或仅 `ok` 不合格。

## Companion Files

- `references/SOP-daily-commit-judgment-matrix-l2-review-prompt.md`：L2 复审 prompt 唯一权威（含输出 schema 与 E1/E3/E4/E5 枚举）。
- `references/SOP-daily-commit-judgment-matrix-secret-patterns.md`：R1 文件名模式与内容正则唯一权威。
- `references/owner-decision-rubric.md`：owner 裁决准则与消息模板唯一权威（与分支巡检 SOP 共用；owner 按它判，不自由发挥）。
- 类目目录：`references/daily-commit-ignore-policy.md`（allowlist / denylist / artifact-first / must-commit 清单）——本 SOP 是流程，它是目录，改类目只改它。

## 参数表

| param | 值 | 说明 |
|---|---|---|
| loop_budget_min | 18 | 主循环 wall-clock 预算（scheduler 30min hard-kill 留 12min 尾部余量） |
| reviewer_timeout_s | 120 | 单次 codex 调用超时 |
| untracked_head_lines | 80 | untracked 文本取样行数 |
| diff_head_bytes | 4096 | tracked 单文件 diff 取样字节 |
| big_file_mb | 10 | R3 任意文件上限 |
| big_binary_mb | 2 | R3 二进制上限 |
| inflight_window_h | 2 | in-flight 判定窗口 |
| artifact_digest_days | 7 | pending_owner 进周 digest 的累积天数 |
| content_scan_max_files | 500 | 单仓内容取样文件数上限，超限记 content_scan_truncated |
| l2_max_files | 60 | 单仓单轮 L2 候选上限，溢出件记 pending_owner 走 manifest 收编 |

## Common Pitfalls

- 把 L2 的 `wip:` 提交当成质量背书——它只是持久化，review 义务仍在 owner。
- manifest 裁决只写 digest 回复不回写 JSON 文件——下轮照旧 pending，裁决必须落 `registry/repo-policies/`。
- 给 R6 加宽 glob 图省事——ignore-policy §2 要求窄条目，宽 glob 会藏掉未来交付物。

## Verification

- `npm test`（矩阵分类为纯函数，须有表驱动用例）；跑一轮后 `jq 'select(.repo=="<样本仓>") | .per_file_dispositions' data/git-ledger.jsonl | tail -1` 非空且每文件有 class+verdict。

## Examples (Worked Cases)

- **Case A — 混合脏集拆分（ad-adjust 型）**：8 文件 = 6 个 sop/ 迁移（R9→SAFE）+ 1 个规划残留 `docs/superpowers/plans/…`（R9→SAFE，「内容未完成」非法拒绝理由）+ 1 个指向仓外绝对路径的 symlink `full-docs`（R9→RISKY E5）→ 提交 7 个文件，symlink 留工作区进 digest。现行机制此仓已整仓卡 7 天。
- **Case B — artifact 池收编（budiansha 型）**：11507 个 `data/**` 文件（R8）→ manifest 无规则 → pending_owner 满 7 天进周 digest → 用户裁决 `ignore` → 回写 manifest → 次轮机械追加 `.gitignore`，仓库转 clean，此后零开销。

## 提交前自检（Definition of Done）

- [x] §9 渐进披露：文件顶到 Step 1 ≤ 25 行
- [x] §5 异常枚举：5 行，五要素齐
- [x] §1-2 自由度全锁：阈值入参数表，prompt/正则下沉单文件，无「视情况」
- [x] §3 样本行：Inputs/Outputs/manifest 均有真实样本 + 幂等键写死
- [x] §8 命名 + INDEX：文件名/frontmatter 一致，INDEX 六列已登记
- [x] §3.1 逐项 evidence：per-file dispositions 落 ledger
