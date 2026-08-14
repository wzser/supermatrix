---
id: 3wa4uu
name: daily-commit-skip-handling
description: 当 localgit-daily-commit 跑完出现 skipped 仓、要发/抑制 owner hint、或要记录 fingerprint 裁决时用；不覆盖逐文件提交判定（judgment-matrix）与 ignore 类目定义（references/daily-commit-ignore-policy.md）。
status: active
owner: localgit
created: 2026-06-01
updated: 2026-08-05
---

# SOP: daily-commit skipped 仓处置

## 核心目标（一句话）
把每个 skipped 仓从「无人认领的脏工作区」收敛到可审计终态——可隔离的分歧提交到 `localgit/hold/*`，敏感/冲突继续 blocked，既不让 must-review 行为变更被静默吞掉，也不拿重复告警轰炸 owner。

## When to Use
scheduled `localgit-daily-commit` 结束且结果含 skipped 仓；要人工补提交先前 skipped 仓；收到 owner 对某 fingerprint 的裁决要记录。**不适用**：单文件该不该提交（走 `SOP-daily-commit-judgment-matrix-*`）；ignore 类目增删（走 `references/daily-commit-ignore-policy.md`）；分支/冲突处置（走 `SOP-repo-branch-merge-patrol-*`）。

## Prerequisites
- 工作区 `/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/localgit`；四份审计文件可读写：`data/daily-commits.log`、`data/daily-commit-dispatches.jsonl`、`data/daily-commit-decisions.jsonl`、`data/git-ledger.jsonl`。
- codex CLI 与 spawn2.0（`localhost:3501`）可用；证据命令总台 / spawn 模板 / 切分清单见 `references/SOP-daily-commit-skip-handling-refs.md`（下称 refs）。

## Steps

### Step 1: 分类 skipped_reason（逐仓，机械字符串匹配）

- **要解决的问题**：「没审到」是流程缺口、「审过但危险」是内容控制，混判会漏提交安全变更或误提交风险内容。
- **输入**：本轮 run 的每仓 `skipped_reason`（来源 = `tail -1 data/daily-commits.log` 与 ledger skip 行；命令见 refs §R1）。
- **处理**：按子串匹配四分类——含 `daily-commit time budget (18min) exceeded` → `not_reviewed_time_budget`；含 `daily-commit session selection failed` → `control_plane_failure`；含 `processing error:` → `reviewer_or_tool_failure`；含 `diff was truncated` / `cannot confirm absence of secrets` / `runtime artifacts` / `__pycache__` / `.db-wal` / `.db-shm` / `.DS_Store` / `conflict detected` / `unsafe to bulk-commit` / `manual inspect` / `permission denied` / `provided diff was empty` 任一 → `reviewed_content_risk`。全部不匹配 → 按 `reviewer_or_tool_failure` 兜底并逐字记录原文。独立于四分类，再跑 refs §R1 的 identity-doc 检查：`CLAUDE.md`/`AGENTS.md` 增删行合计 ≥30（`git diff --numstat` 加 `--cached`），或出现新顶层 `.md` → 叠加标 `identity_doc_major_change`（候选 commit message 以 `identity: FP <rollout-name>` 开头者例外，按 FP 预审放行；禁止本地自造该前缀）。
- **产物**：每仓一个分类标签（可叠加 identity 标）。
- **下一步消费方**：`not_reviewed_time_budget` → Step 2；`identity_doc_major_change` → Step 3；`reviewed_content_risk` → Step 4；`control_plane_failure` / `reviewer_or_tool_failure` → 异常表 Case-1 / Case-2。
- **失败回滚**：分类是纯读操作，可重跑；误分类发现后以 ledger 原文重新分类并在 decisions 记一行更正。

### Step 2: 处理 not_reviewed_time_budget（localgit-owned，bounded retry）

- **要解决的问题**：wall-clock 预算耗尽 ≠ 内容不安全；但工具容量问题不准洗掉 must-review 变更。
- **输入**：Step 1 标为 `not_reviewed_time_budget` 的仓清单。
- **处理**：逐仓 `git -C <repo> status --short && git -C <repo> diff --stat`。①已 clean → 记「无需动作」收尾。②纯 T1 同步身份文档（<30 行、无新顶层 `.md`、session 专属）→ `git diff --check` 后直接提交；带 `identity: FP` 前缀同理。③含 source/scripts/Feishu/scheduler/凭证邻近/数据文件或多逻辑单元 → 按判定矩阵 SOP 逐文件切分后走 Step 6。④收尾前必跑 refs §R1 codex 健康探针；rate-limited/stalled → 等 reset 后 bounded retry：只重试 time-budget skips、保留 per-repo timeout 与整轮重试预算（≤1 轮）、保留原 skipped 记录、追加第二条结果记录。禁止只调大 scheduler timeout（18min 预算是为了在 hard-kill 前跑完日志/通知/Bitable 同步/reload）。must-review 脏集重试后仍审不了 → 记 fingerprint、ledger 标 `blocked: must-review dirty set could not be reviewed by localgit (...)`，owner 不因此收 hint。
- **产物**：committed / clean / blocked-记fingerprint / 重试结果记录。
- **下一步消费方**：blocked 项进次日 run 与 Step 7 复盘；重复 time-budget 事故 → file localgit issue（可选项：二次 bounded pass / 降 per-repo timeout / 换小模型 / 小并发批量 / 预提交琐碎 doc-only）。
- **失败回滚**：重试失败不改变任何仓状态（只读审查 + 精确 staging），保留原 skip 记录即回滚完成。

### Step 3: 路由 identity_doc_major_change → first-principle

- **要解决的问题**：T2/T3/T4 身份文档大改的治理判断不归 daily-commit；但也不准让仓「skipped 无 owner」漂着。
- **输入**：Step 1 叠加标 `identity_doc_major_change` 且无 FP 前缀的仓。
- **处理**：按 refs §R2 模板 spawn `first-principle`（逐仓一条；幂等键 `client_request_id` = `<date>:localgit:first-principle:identity-doc-major-<repo>`；closure=`message/todo_pool`；带 inbox verification_predicate，600s 窗口）。只有严格的 todo_pool 202 回执（`ok:true` / `mode:"async_kickoff"` / `closure:"todo_pool"` / `ref` / `spawnCommId`）或可审计 duplicate 409（`duplicate:true` 且 `existing.commId` + `existing.status`）证明 delegation accepted；必须写 `fp_escalation` dispatch 行（含 `clientRequestId` / verification token / accepted receipt），不等于 FP review 完成。FP 裁决后按 refs §R2 落地规则执行（rollout 前缀 / T2 自提 / T3-T4 按 FP 指示）。time-budget 处理与本步正交：仍走 Step 2 的探针与重试，本步只改「谁 own 这份 diff」。
- **产物**：spawn accepted 回执 + FP 决定 + 对应 commit 或 FP 指示的后续动作。
- **下一步消费方**：Step 5 记录 decision（actor=first-principle）；Step 6 若 FP 判可提交。
- **失败回滚**：FP 无 ack 走异常表 Case-3；期间该仓保持 blocked 不提交，无需回滚。

### Step 4: 处理 reviewed_content_risk（切分，绝不整树提交）

- **要解决的问题**：reviewer 已判定 bulk commit 不安全；要把 safe 单元救出来、risky 单元给出口。
- **输入**：Step 1 标 `reviewed_content_risk` 的仓 + `skipped_reason` 点名的风险文件。
- **处理**：①对点名文件取全量 diff（refs §R1）。②按判定矩阵 SOP 逐文件判定，safe/risky 常见切分见 refs §R4；safe 单元独立成立才走 Step 6 提交。③剩余风险工作量大时按 refs §R3 模板 spawn localgit 子会话接管（不用 ATP）。④对留下的 risky 集按 refs §R5 三分类（localgit-owned / self-resolvable / owner-required），仅 `owner-required` 进 Step 5 的 hint 通道。
- **产物**：safe 单元 commit + risky 清单及其分类 + （如有）子会话回执。
- **下一步消费方**：Step 5（owner-required hint 与 decision）；Step 7 复盘重复模式。
- **失败回滚**：切分只动 staging 区，`git -C <repo> reset -- <file>` 撤 stage 即回滚；已提交的 safe 单元用 `git revert`（见 `SOP-git-ledger-*`）。

### Step 5: owner hint 发送闸门与裁决记录（fingerprint 去重）

- **要解决的问题**：未变化脏集反复告警会训练 owner 忽略 localgit。
- **输入**：Step 3/4 产出的 `owner-required` 项；owner / localgit 返回的裁决。
- **处理**：发送前按抑制键 `repo + dirty_fingerprint + skipped_reason class` 三查——①dispatches 已有 `kind:"owner_hint"`+`status:"sent"` 同键行；②decisions 有未过期同键裁决（最新值非 `notify_again`）；③ledger 已有同键 `operation:"skip"` 行。任一命中 → 只追加 suppressed 行，不重复发飞书，但未裁决项仍保留在 digest。未命中 → 发 hint（内容按 owner-decision-rubric §D：枚举动作 + localgit 预判默认项），且必须用 `--as bot` / 默认 bot identity。若 daily-commit 已产出 `committed_hold`，则发送 `kind:"hold_review"`，必须附 original branch、hold branch、commit SHA、文件清单及带 `--hold-commit <reviewed-sha>` 的确定性命令；owner 只可选 `merge|archive|keep_until`，由 `npm run hold-decision -- ...` 执行。所有裁决先验证 hold ref 仍精确等于 reviewed SHA；`merge` 再要求原分支 clean、原 HEAD 仍为 hold 基线且可 ff，并只合并该 SHA；`archive` 与 `keep_until` 只追加 decision，不删除分支。
- **产物**：dispatch 行（sent 或 suppressed）+ decision 行。
- **下一步消费方**：下轮 run 的抑制三查；周裁决 digest（与判定矩阵 SOP 的 pending_owner 合并同一张卡）。
- **失败回滚**：dispatch/decision 都是 append-only，误记时追加更正行（decision 用 `notify_again` 或新 decision 覆盖语义），不改历史行。

### Step 6: 人工补提交（安全单元落库）

- **要解决的问题**：把审过的 safe 单元变成可审计 commit，不夹带。
- **输入**：Step 2/3/4 判定为 safe 的单一逻辑单元；提交前对照 refs §R6 允许/必跳清单复核。
- **处理**：①`git -C <repo> add -- <file1> <file2>`（精确路径，禁 `add -A`/`add .`）。②`git -C <repo> diff --cached --check`；代码变更再跑该仓真实测试命令。③`git -C <repo> -c user.name=<session-name> -c user.email=<session-name>@local commit -m "<message>"`（代该 session 行事时）。④属别的 session 且需领域判断 → 不代提交，发 handoff。⑤daily-commit 脚本自身要改行为 → 在 localgit 仓改、验证、提交，让下轮 scheduled run 证明。
- **产物**：commit sha + 所用验证记录（进 ledger）。
- **下一步消费方**：`SOP-git-ledger-*` 审计与回滚；Outputs 终态记录。
- **失败回滚**：提交前 `git reset -- <file>`；提交后 `git revert <sha>`（非破坏性，见 git-ledger SOP）。

### Step 7: run 后复盘与规则调优（每轮必做）

- **要解决的问题**：HTTP 触发成功 ≠ 日结治理完成；重复告警 / 容量失败 / 漏提交只在本地日志里可见。
- **输入**：refs §R1 四条 tail 命令的输出。
- **处理**：回答四问——①有 owner 收到重复同键 hint？有 = localgit bug，修抑制并补测试。②localgit-owned 失败（ETIMEDOUT / loop budget / Bitable sync / reload evidence）重复？有 = 修容量或记 bounded retry 计划，不转 owner。③内容 skip 暴露重复 safe 模式？只在规则窄、确定、有测试覆盖时才优化，否则记 fingerprint decision。④owner 已给明确 `keep_until` 且 fingerprint 未变？期限前只 suppress 重复 hint；未给裁决不得转静默终态。允许的优化：加/收紧抑制逻辑、加窄的带测试分类器、按用户纠正更新本 SOP 或类目目录、记 decision。禁止的优化见「禁用项」。
- **产物**：闭环确认或 localgit issue / SOP 修订 commit。
- **下一步消费方**：次日 run；sopmaster 巡检。
- **失败回滚**：复盘是只读 + append，无需回滚。

## 异常枚举（§5）

| Case | 触发条件（可机械判定） | 判定方式 | 应对动作 | 通知对象 | 升级时限 |
|---|---|---|---|---|---|
| session 治理读取失败（运行时 DB） | `skipped_reason` 含 `daily-commit session selection failed` | Step 1 字符串匹配 | 本轮零 owner hint；用 refs §R1 SQLite 命令手工复测 sessions 选择；记 decision `localgit_retry` | localgit 绑定群（Console 卡 level=warn） | 连续 2 个 run 复现 → 暂停自动提交只记 ledger，当日找 supermatrix-root 排查 |
| reviewer 超时 / 停摆（自身异常） | `skipped_reason` 含 `processing error:`，或 codex 探针非 0 / 输出 ≠ `OK` | refs §R1 探针退出码与 stdout | 等 rate-limit reset 后 bounded retry（仅 time-budget skips、≤1 轮）；must-review 集记 fingerprint 标 `blocked` | localgit（file issue，不路由 owner） | 重试 1 轮仍失败 → 次日 run 前修 reviewer 容量 |
| spawn first-principle 无 ack（下游不响应） | 发出 §R2 spawn 后 600s 内 verification_predicate 未命中 | spawn2.0 返回的 predicate 校验结果 | 同 `client_request_id` 重发 1 次（幂等）；仍无 → 该仓保持 blocked 不提交 | localgit 绑定群（Console 卡 level=warn） | 24h 无 FP 回复 → 升级用户绑定群点名 |
| 重复 owner hint 即将发出（自身异常） | 抑制键 `repo+fingerprint+class` 命中 Step 5 三查任一 | 查 dispatches / decisions / ledger 三份 jsonl | 只写 `status:"suppressed"` dispatch 行，不发飞书 | 无（本地审计） | 无——fingerprint 变化或 `notify_again` 才解除 |
| owner hint 已发无裁决（下游不响应） | dispatch `status:"sent"` 且 decisions 无同键行 | 两份 jsonl 对查 | 不重发同键 hint；并入周裁决 digest，保持 `pending_owner` | 周裁决卡（用户绑定群） | 24h 无裁决 → 合并升级一次；此后每周 digest 保留，绝不自动静默 |

## 禁用项 (Do NOT during execution)

- **不准把 reviewer timeout / loop budget / control-plane 失败路由给 repo owner**。**Why**：工具容量问题会把行为变更从 owner 视野静默洗掉，且训练 owner 忽略 localgit。**How to apply**：Step 1 分类后 localgit-owned 类只走 Step 2 / 异常表。
- **不准对未变 fingerprint 重发 owner hint**。**Why**：告警疲劳淹没真正的新风险。**How to apply**：Step 5 三查强制，命中只写 suppressed 行。
- **不准用 `--as user` 发送 daily-commit machine dispatch（含 owner hint / FP escalation）**。**Why**：owner hint 文案要求人回「默认」或「选 X」，FP escalation 文案要求 first-principle 执行 review；用 user identity 会被 dispatcher 当真人输入并形成 phantom run。**How to apply**：Step 5 未抑制时用 bot identity；Step 3 需要 session 自动处理的任务走 spawn2.0/API，并记录 accepted receipt 而非伪装真人消息。
- **不准无 `identity: FP` 前缀自动放行 identity_doc_major_change**。**Why**：身份文档治理归 first-principle。**How to apply**：Step 3 强制 spawn，前缀不可本地自造。
- **不准 `git add -A` / 整树 bulk commit**。**Why**：夹带未审文件是本 SOP 要防的核心事故。**How to apply**：Step 6 只 `add -- <精确文件>`。
- **不准放宽 `.gitignore` / artifact allowlist 来掩盖 source/config/test、secrets、DB、migration、scheduler/spawn/reload 行为或身份文档**。**Why**：ignore 一旦盖上，风险从 daily-commit 视野永久消失。**How to apply**：Step 7 禁止优化项；类目变更只走 `references/daily-commit-ignore-policy.md` denylist 复核。

## Inputs & Outputs 契约（§3）

- **Input**：本轮 run 的每仓结果与 ledger skip 行。样本行（ledger，节选）：`{"recorded_at":"2026-07-02T19:33:34.895Z","run_id":"daily-2026-07-02T19:15:28.420Z","repo":"ziniao","branch":"main","actor":"localgit","operation":"skip","files_changed":35,"skipped_reason":"blocked: must-review dirty set could not be reviewed by localgit (daily-commit time budget (18min) exceeded); localgit must retry or improve reviewer capacity before owner routing","dirty_fingerprint":"30f715..."}`
- **Output — dispatch 行**（`data/daily-commit-dispatches.jsonl`）样本：`{"recorded_at":"2026-07-02T19:33:38.728Z","date":"2026-07-02","runId":"daily-2026-07-02T19:15:28.420Z","dispatchId":"dc-2026-07-02-product-info-727a0e876fec","kind":"owner_hint","targetSession":"product-info","repo":"product-info","status":"sent","message":"[daily-commit hint · 2026-07-02]..."}`——抑制时 `status:"suppressed"` + `suppressionReason`；FP spawn accepted 样本：`{"kind":"fp_escalation","targetSession":"first-principle","repo":"tag-manager","status":"sent","clientRequestId":"2026-07-13:localgit:first-principle:identity-doc-major-tag-manager","verificationToken":"comm_identity_doc_major_dc_2026_07_13_tag_manager_abcdef123456","acceptedReceipt":"spawn2.0 todo_pool accepted ref=spawn2.0:comm_abc spawnCommId=comm_abc"}`。
- **Output — decision 行**（`data/daily-commit-decisions.jsonl`）样本：`{"recorded_at":"2026-07-02T19:34:48.464Z","decision_id":"dcd-localgit-399a8b09c51e","repo":"localgit","dirty_fingerprint":"reviewer-capacity-daily-2026-07-02T19:15:28.420Z","decision":"localgit_retry","actor":"localgit","scope":"fingerprint","reason":"..."}`
- **幂等键**：hint 抑制键 = `repo + dirty_fingerprint + skipped_reason class`；dispatch = `dispatchId`（`dc-<date>-<repo>-<hash12>`）；decision = `decision_id`；spawn = `client_request_id`（`<YYYY-MM-DD>:localgit:<target>:<用途>-<repo>`，重发复用同值去重）。
- **Receipt / 验证 token**：FP spawn 用 `comm_identity_doc_major_<dispatch_id>` 派生 token（非字母数字替换为 `_`）；其它 spawn 模板见 refs §R2/§R3 内置 predicate；本地终态由 Verification 一节探针证明。
- **批量 evidence（§3.1）**：本 SOP 逐仓执行——每仓至少一行 ledger（`operation=skip|commit`），发 hint 加一行 dispatch，收裁决加一行 decision。判据：只看这三份 jsonl 即能判每仓终态与是否按 SOP 走，空白或裸 `ok` 不算。

## Companion Files

- `references/SOP-daily-commit-skip-handling-refs.md`：§R1 证据命令总台 / §R2-R3 spawn 模板 / §R4 safe-risky 切分清单 / §R5 skip 三分类与 decision 枚举 / §R6 自动提交允许-必跳清单。
- `references/daily-commit-ignore-policy.md`：ignore 类目目录（allowlist / denylist / artifact-first / must-commit）。
- `references/owner-decision-rubric.md`：owner hint 消息模板与裁决准则（§D）。

## Common Pitfalls

- 把「时间预算没审到」当「内容危险」处理 → 安全变更被永久搁置；反向混判 → 风险内容被补提交。先跑 Step 1 再动手。
- 看到 scheduler run `success` 就当日结完成——它只证触发；终态只认三份 jsonl + ledger。
- 修 time-budget 事故时直接调大 scheduler timeout——会挤掉日志/通知/同步尾部动作，走 Step 2 第 8 项的五个可选项。

## Verification

- 抑制闭环探针：`grep -c '"status":"suppressed"' data/daily-commit-dispatches.jsonl` 且对任一 `repo+fingerprint` 键 `grep '"status":"sent"' data/daily-commit-dispatches.jsonl | grep -c <fingerprint>` ≤ 1。
- 终态齐全探针：对本轮每个 skipped 仓，`grep <repo> data/git-ledger.jsonl | tail -1` 能给出 skip/commit 行，且（如涉裁决）`grep <fingerprint> data/daily-commit-decisions.jsonl` 非空。

## Examples (Worked Cases)

- **Case A — time-budget → bounded retry → committed**：2026-07-02 run，ziniao 等 4 仓 `skipped: daily-commit time budget (18min) exceeded`。Step 1 归 `not_reviewed_time_budget`；Step 2 codex 探针 OK，bounded retry 重审，safe 单元经 Step 6 精确 staging 提交；ledger 新增 `operation:"commit"` 行，decisions 记 `localgit_retry`（decision_id `dcd-localgit-399a8b09c51e`）。
- **Case B — 非平凡分支：重复 fingerprint 被抑制**：product-info 同一脏集第二天再现，抑制键命中 dispatches 已有 `status:"sent"` 行（`dc-2026-07-02-product-info-727a0e876fec`）→ 只追加 `status:"suppressed"` 行，不发飞书；留给下一轮的是未变 fingerprint 的周 digest 候选。

## 提交前自检（Definition of Done）

- [x] **§9 渐进披露**：Step 1 于第 24 行可达，背景全下沉 refs。
- [x] **§5 异常枚举**：5 行五要素齐（上游脏 / 下游不响应 ×2 / 自身异常 ×2）。
- [x] **§1-2 自由度全锁**：分类 = 子串枚举；阈值写死（30 行 / 18min / 600s / ≤1 轮重试 / 2 run 升级）。
- [x] **§3 样本行**：ledger / dispatch / decision 真实样本 + 幂等键写死。
- [x] **§8 命名 + INDEX**：`SOP-daily-commit-skip-handling-active-20260805-3wa4uu.md` 四件套一致，INDEX 六列已登记。
- [x] **§3.1 逐项 evidence**：逐仓回写 ledger / dispatch / decision 三份 jsonl。
