---
name: identity-doc-major-change-review
description: 当 watchdog 通过 /api/spawn 把 identity_doc_major_change（CLAUDE.md/AGENTS.md ≥30 净行 或 新增 top-level .md）路由给 FP 时使用；不覆盖 reviewer/tool 故障引起的纯 retry 场景（仍是 watchdog 自己 bounded retry），也不覆盖日常 T1 routine edit（watchdog 直接 commit）。
---

# SOP: Identity-Doc Major-Change Review (watchdog → FP handoff)

> Created: 2026-05-21 | Last updated: 2026-05-21

## 核心目标（What problem does this SOP solve）

**这是一个什么类型的 SOP：** watchdog `daily-commit-skip-handling` 把 `identity_doc_major_change` 路由到 FP 后的接收侧 runbook。

**它要解决什么问题：** `templates/console-principles.md` §Session Identity Document Change Discipline 已经定义 T1–T4 分级和 watchdog 自动放行边界，watchdog 也按约定 spawn FP 并附 `comm_identity_doc_major_<ts>` verification token。但 FP 这边没有标准流程承接——每次都得即兴判断、即兴回复，verification token 也容易漏带回。本 SOP 把这条 handoff 闭环固化下来。

## When to Use

事件触发，任一即激活：

1. 收到来自 `watchdog` 的 `/api/spawn`，prompt 包含 `[verification: comm_identity_doc_major_<ts>]` 且引用 `console-principles.md` §Session Identity Document Change Discipline
2. 用户直接命令 FP "审一下 `<repo>` 的 CLAUDE.md/AGENTS.md 大改"（绕开 watchdog 的人工触发同流程）

**不适用场景（Do NOT use when）—— 必填**：

- watchdog skip 原因是 `not_reviewed_time_budget` / `reviewer_or_tool_failure`（codex ETIMEDOUT、stall）且 dirty set 还没被分类过 —— 那是 watchdog 自己 bounded retry / 修 reviewer 的事，FP 不接
- T1 routine edit（<30 净行、无新增 top-level `.md`、明显 session-specific、不涉及 FP category-template 规则改写）—— watchdog 直接 commit，不会 spawn FP
- FP-orchestrated rollout 已经带 `identity: FP <rollout-name>` 前缀的提交 —— watchdog 视为 pre-approved，也不会 spawn FP
- 邻近 SOP `category-template-distribution.md` 覆盖的"FP 主动起草并下发 category 模板"场景 —— 那是 FP→sessions 的推送链路，本 SOP 是 watchdog→FP 的接收链路

## See Also

- `sop/category-template-distribution.md`：如果分类判断结果是 **T3 baseline change**（session 改了 FP category 模板继承来的规则），重做 category 模板分发要回那一份
- `sop/periodic-review-operation-manual.md` §Phase 3：本 SOP 的定期版本——巡检主动扫 conform，本 SOP 是事件触发的反应版
- watchdog `sop/daily-commit-skip-handling.md`：上游契约。watchdog 怎么分类 + 怎么 spawn FP 写在那里，本 SOP 是下游接收方

## Prerequisites

- 收到 watchdog spawn 时 prompt 里能解析出：目标 repo 绝对路径、verification token `comm_identity_doc_major_<ts>`
- 目标 session 在 `FP管辖` scope 内（不在 scope 内的直接回 watchdog "out of FP scope, owner-routed" 即可，不走本 SOP 全流程）
- 本地 `templates/console-principles.md` §Session Identity Document Change Discipline 是最新版

## Inputs & Outputs (SOP-level Contract)

**Inputs:**

- `target_repo`: 目标 session workdir 的绝对路径（watchdog 在 prompt 里给）
- `verification_token`: `comm_identity_doc_major_<yyyymmddHHMMss>`（必须原样回传给 watchdog）
- `target_session_name`: 从 `target_repo` 反查 SQLite `sessions.workdir` 得到
- 目标 session 当前 dirty diff（`git -C <repo> diff` / `git diff --cached`）
- FP category template 当前内容（`templates/claude-md-<category>.md` / `agents-md-<category>.md`，匹配 session 的 `分类`）

**Outputs:**

- 一条 `data/principles-log.db` changelog 行：`trigger_type='event'`, `trigger_source='watchdog'`, `target_doc=<对应 category 或 fp-self>`, `judgment` ∈ {`accepted`, `rejected`, `deferred`, `session_override`}
- 回复 watchdog 的 spawn 响应：单行回执，**必须原样含 verification token**，格式：
  ```
  FP-IDENTITY-DOC-DECISION token=comm_identity_doc_major_<ts> repo=<repo> tier=<T2|T3|T4> action=<commit_by_session|commit_by_watchdog_with_prefix|reject_route_template_update|reject_route_relocate> — <one-sentence reason>
  ```
- 视分类分支产生附带产物：
  - T2 → spawn 目标 session 让它自己提交（`identity:` prefix）；不直接由 FP 提交
  - T3 → 在 `requests/` 起草一份 template-update 请求 + spawn 目标 session 告知 dirty 暂留、等模板定稿后再 conform
  - T4 → spawn 目标 session 把内容迁到 `CLAUDE.md` 主体 / `sop/<name>.md` / `NOTES.md`，并删掉违规新文件

**Receipt / Verification token:** verification token 必须原样出现在回 watchdog 的 finalMessage 头部。watchdog 端 verification_predicate 是 `inbox-message` 的 `contains_all=[token]`；少一个字符就 receipt_missing。

## Companion Files (Progressive Disclosure)

- `scripts/`：本 SOP 暂无配套脚本。如果未来 T2/T3/T4 分类条件复杂化（例如要 diff FP category template 段落级匹配），把判定逻辑写成 `scripts/classify-identity-doc-change.sh` 再 inline 调用，**不要在 SOP body 里堆 shell**。
- `references/`：典型 case（首次新建 CLAUDE.md/AGENTS.md 走 T2、改 category baseline 段走 T3、新建治理类 .md 走 T4）的 worked example 如果膨胀超过 30 行，外放成 `references/identity-doc-major-change-examples.md`。当前 inline 即可。

**外放阈值：** body 内联 case >30 行、或内联 shell >15 行 → 外放到 companion files。

## Steps

### Step 1: 解析 spawn prompt + 验证 scope

- **要解决的问题（Problem）**：必须先确认这是合法的 watchdog handoff（带 token、引用了 console-principles 段落、目标 session 在 FP 管辖范围内），否则容易把 owner-routed 的非管辖 session 误纳入。
- **输入（Input）**：watchdog spawn 的 prompt 文本
- **处理（Processing）**：
  ```bash
  TOKEN=$(echo "$PROMPT" | grep -oE 'comm_identity_doc_major_[0-9]+' | head -1)
  REPO=$(echo "$PROMPT" | grep -oE '<SM_WORKSPACE_ROOT>/[^ ]+' | head -1)
  TARGET=$(sqlite3 <SM_RUNTIME_ROOT>/data/supermatrix.db \
    "SELECT name FROM sessions WHERE workdir='$REPO' AND status!='deleted' LIMIT 1;")
  bash scripts/fp-managed-list.sh | grep -qx "$TARGET" || { echo "out of FP scope"; exit_with_token; }
  ```
- **产物（Output）**：`TOKEN / REPO / TARGET` 三元组；scope 已确认
- **下一步消费方（Next）**：Step 2

### Step 2: 抓 dirty diff + 拉 category template

- **Problem**：分类决策必须基于实际 diff，不能凭 commit message 或 watchdog 总结判断。
- **Input**：`REPO`、`TARGET` 的 `分类`
- **Processing**：
  ```bash
  git -C "$REPO" diff --stat -- CLAUDE.md AGENTS.md
  git -C "$REPO" diff -- CLAUDE.md AGENTS.md > /tmp/identity-diff-$TARGET.patch
  git -C "$REPO" status --short -- '*.md'   # 查新增 top-level .md
  CATEGORY=$(sqlite3 <SM_RUNTIME_ROOT>/data/supermatrix.db \
    "SELECT category FROM sessions WHERE name='$TARGET' LIMIT 1;")
  # 对应 category template
  ls templates/claude-md-$CATEGORY.md templates/agents-md-$CATEGORY.md
  ```
- **Output**：diff 文件 + category 模板路径
- **Next**：Step 3 分类判定

### Step 3: 分类判定（T2 / T3 / T4）

- **Problem**：分类决定后续动作分支，错分会导致 baseline 被静默改写（T3 误判为 T2）或合法新建被拒（T2 误判为 T4）。
- **Input**：Step 2 的 diff、category 模板内容
- **Processing**：按下面决策树（**严格顺序，命中即停**）：

  1. **是否首次创建 `CLAUDE.md` / `AGENTS.md` / `NOTES.md`（这三份之一）？**
     → 是 → **T2**（首次新建这三份属于合法 session-owned 行为，不是 T4；参考 `console-principles.md` §Session Identity Document Change Discipline 关于"首次创建 CLAUDE/AGENTS/NOTES 不是 T4"的明确条款）
  2. **是否新建了 `CLAUDE.md` / `AGENTS.md` / `NOTES.md` 之外的 top-level 治理类 `.md`？**（治理类典型特征：含规则/contract/identity 措辞，或文件名含 governance/contract/identity/charter 等）
     → 是 → **T4**
  3. **diff 是否改/删了来自 FP category template 的规则？**
     - 提取该 session 当前 CLAUDE.md/AGENTS.md 中与 `templates/claude-md-<category>.md` 重合的段落作为 baseline 子集
     - 如果 diff 的 `-` 行落在这个子集里，或 `+` 行覆盖了这个子集 → **T3**
  4. **以上都否** → **T2**（session-specific self-evolution）

- **Output**：tier ∈ {T2, T3, T4} + 一句话理由
- **Next**：按 tier 走 Step 4 的对应分支

### Step 4: 按 tier 执行

- **Problem**：每种 tier 的合法终态不同，T2 必须由 session 自己提交（保持所有权），T3 不能提交（要走模板更新流程），T4 必须迁移内容而非提交。
- **Input**：Step 3 的 tier
- **Processing**：

  **T2 分支：**
  ```bash
  # spawn 目标 session，让它自己加 identity: 前缀并提交
  curl -s -X POST http://localhost:3501/api/spawn \
    -H "Content-Type: application/json" \
    -d "{\"target\":\"$TARGET\",\"from\":\"first-principle\",
         \"prompt\":\"[FP identity-doc review] 你的 CLAUDE.md/AGENTS.md 当前 dirty diff 已被 FP 判为 T2 self-evolution（session-specific 内容，未改 FP category baseline）。请用 'identity: <你的 commit message>' 前缀自行提交。提交完成后回一句 'identity-doc T2 committed at <sha>'。\"}"
  ```

  **T3 分支：**
  - 在 `requests/` 起一份 pending request：`requests/template-update-from-<TARGET>-<date>.md`，内容指出 diff 里改/删的 baseline 规则
  - spawn 目标 session：dirty 暂留、不要 commit；FP 会评估是否更新 category 模板
  - 走 `rules/update-judgment.md` 的常规请求处理流程

  **T4 分支：**
  ```bash
  curl -s -X POST http://localhost:3501/api/spawn \
    -H "Content-Type: application/json" \
    -d "{\"target\":\"$TARGET\",\"from\":\"first-principle\",
         \"prompt\":\"[FP identity-doc review] 你新建的 <文件名> 被判为 T4（CLAUDE/AGENTS/NOTES 之外不允许新增治理类 .md）。请把内容迁到：操作规则→CLAUDE.md / 流程→sop/<name>.md / scratch→NOTES.md，然后 git rm 原文件。完成后回 'identity-doc T4 relocated to <path>'.\"}"
  ```

- **Output**：上述任一分支的 spawn 子会话执行结果
- **Next**：Step 5 写 changelog + 回 watchdog

### Step 5: 写 changelog + 回 watchdog（带 verification token）

- **Problem**：少一行 changelog 等于决策无审计；少 verification token watchdog 的 inbox-message 谓词不命中、本次 spawn 报 receipt_missing。
- **Input**：tier、Step 4 的动作和结果
- **Processing**：
  ```bash
  sqlite3 data/principles-log.db "INSERT INTO changelog (trigger_type, trigger_source, target_doc, judgment, judgment_reason, change_summary, change_detail, request_file) VALUES ('event','watchdog','<doc>','<judgment>','watchdog identity_doc_major_change handoff','<tier> on $TARGET — <action>','<detail>',NULL);"
  # Feishu Bitable 镜像见 CLAUDE.md §Changelog Recording Rules

  # 回 watchdog 的 finalMessage（必须含 token 原样）
  echo "FP-IDENTITY-DOC-DECISION token=$TOKEN repo=$REPO tier=<T2|T3|T4> action=<...> — <reason>"
  ```
- **Output**：changelog 行 + 一行回执
- **Next**：watchdog inbox-message 谓词命中，handoff 闭环结束

## 禁用项 (Do NOT during execution)

- **不准由 FP 自己提交目标 session 的 CLAUDE.md/AGENTS.md 改动。** Why：违反 v3.1 spawn-confirm-first 原则（FP 不直接编辑 managed session 身份文件，详见 CLAUDE.md §CLAUDE.md / AGENTS.md Sync Review Rules）。How to apply：T2 必须 spawn session 让其自己提交；T3/T4 也由 session 执行迁移/暂留。
- **不准漏带 verification token。** Why：watchdog 的 verification_predicate 是 `contains_all=[token]`，少一个字 watchdog 上游就报 receipt_missing 触发 retry，造成重复 spawn 风暴。How to apply：Step 5 的回执模板里 `token=` 字段必填、原样。
- **不准跳过 changelog 写入，即使决定是 deferred / out-of-scope。** Why：决策记忆是后续 patrol 和重复 case 路由的依据（详见 CLAUDE.md §CLAUDE.md / AGENTS.md Sync Review Rules 的 decision memory 段）。How to apply：所有分支结尾都过 Step 5 的 INSERT 语句。
- **不准用 `--as user` 通知目标 session。** Why：违反 Communication Discipline；spawn 走 HTTP API 才是合法链路（见 CLAUDE.md §Cross-Session Collaboration）。How to apply：Step 4 全部用 `/api/spawn`。
- **不准基于 watchdog prompt 里的总结判断 tier，必须读实际 diff。** Why：watchdog reviewer 可能 stall 或 ETIMEDOUT 时根本没看过 diff，prompt 里的描述不可信。How to apply：Step 2 强制 `git diff` 抓原始 diff 后再分类。

## Common Pitfalls

- **把首次新建 CLAUDE.md/AGENTS.md 误判 T4**：watchdog 端 `identity_doc_major_change` 触发条件包含"新建 top-level `.md`"，但 T4 在 console-principles 里专指 CLAUDE/AGENTS/NOTES 之外的新治理文件。Step 3 决策树的第 1 条是兜底，先判这条。
- **T2 直接由 FP 提交**：违反 v3.1，所有权回不到 session 手里，下次该 session 自己改时会撞作者。
- **T3 误判 T2 后 spawn session 提交**：baseline 规则被静默改写，未来 patrol 时 conform 检查也会拿改过的 baseline 当对照。决策树第 3 条必须真做 diff 对照，不能凭直觉。
- **verification token 截断/拼错**：尤其当 prompt 经过多层引用复制时易丢字符。Step 1 用 grep -oE 提取后变量化，杜绝手敲。

## Verification

- changelog 表新增一行，`trigger_source='watchdog'` 且 `judgment_reason` 含 `watchdog identity_doc_major_change handoff`：
  ```bash
  sqlite3 data/principles-log.db \
    "SELECT timestamp, target_doc, judgment, change_summary FROM changelog WHERE trigger_source='watchdog' ORDER BY id DESC LIMIT 5;"
  ```
- 最近 5 min 内目标 session 新增一条 `identity:` 前缀 commit（T2 分支），或对应 .md 文件已删除（T4 分支），或 `requests/` 多出 `template-update-from-<TARGET>-*` 文件（T3 分支）
- watchdog 端 inbox-message 谓词命中，未触发 receipt_missing

## Examples (Worked Cases)

**Case A — T2（首次新建 identity doc）**

Input: watchdog spawn prompt 引用 `huojian-king` repo，diff 显示 `CLAUDE.md` 和 `AGENTS.md` 均为 untracked + 各 259 行。
Output: tier=T2 → spawn `huojian-king` "请用 `identity: initial CLAUDE/AGENTS for huojian-king` 自行提交"；changelog 写一行 `accepted`；回 watchdog `FP-IDENTITY-DOC-DECISION token=... repo=.../huojian-king tier=T2 action=commit_by_session — first-time identity doc creation, no baseline drift`。

**Case B — T3（改 baseline）**

Input: session `foo-bar` 把 CLAUDE.md 里来自 `templates/claude-md-业务.md` 的"WHY before HOW"段落删了。
Output: tier=T3 → 不提交；在 `requests/` 起 `template-update-from-foo-bar-2026-05-21.md`；spawn `foo-bar` 让它 dirty 暂留；回 watchdog `... tier=T3 action=reject_route_template_update — session attempted to remove WHY-before-HOW which is FP-baseline; routing to template-update flow`。

**Case C — T4（新增治理类 .md）**

Input: session `baz` 新建了 `IDENTITY.md`，内容是它自己重写的身份/职责章程。
Output: tier=T4 → spawn `baz` 把内容迁到 `CLAUDE.md` 主体或 `NOTES.md`、删除 `IDENTITY.md`；回 watchdog `... tier=T4 action=reject_route_relocate — IDENTITY.md is a forbidden new governance doc; relocate to CLAUDE.md/NOTES.md`。
