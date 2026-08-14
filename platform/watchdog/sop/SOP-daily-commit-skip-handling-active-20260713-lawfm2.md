---
id: lawfm2
name: daily-commit-skip-handling
description: 当 watchdog-daily-commit 留下 skipped repo 时使用；不把 process failure 伪装成 owner 内容风险，也不替业务 owner 作领域判断。
status: active
owner: watchdog
created: 2026-05-14
updated: 2026-07-13
---
# SOP: Daily Commit Skip Handling

## 核心目标

逐 repo 区分未审查、控制面/工具故障、内容风险与 identity governance，并推进到 verified terminal outcome，所有 skip 均显式留痕。

## When to Use

当 Console 或 `data/daily-commits.log` 出现 `skipped_reason` 时使用。｜**不适用**：正常 committed repo；scheduler trigger 配置；尚未完成 dirty snapshot 的 ignore 判定。

## Prerequisites

- 可读 `data/daily-commits.log`、scheduler run API、目标 repo git 状态及 Feishu `Daily Commit` 控制字段；先读 `SOP-daily-commit-ignore-policy-active-20260713-lmcms8.md`。

### Step 1: 读取并锁定原始 skip evidence

- **要解决的问题**：避免只凭 Console 摘要猜 skipped 原因，或把后续 working-tree 变化当成原始证据。
- **输入**：最新 daily-commit log row、task `185ddf95-3f0e-4b7b-9d11-77028c5d8793` 最新 run、目标 repo path、Feishu control row。
- **处理**：按顺序读取 `tail -1 data/daily-commits.log`、scheduler latest run、`git status --short`、`git diff --stat`、`git diff --check` 与 control field；把 `<date>:<repo>:<skipped_reason>` 固化为 follow-up key。
- **产物**：含原始 repo result、当前 dirty snapshot、trigger state、control state 的 evidence bundle。
- **下一步消费方**：Step 2 使用精确原文分类。
- **失败回滚**：任一来源不可读时不提交、不 handoff；标 `watchdog-owned: evidence unavailable`，进入异常表 E1/E3。

### Step 2: 机械分类 skipped reason

- **要解决的问题**：把“没审到”与“审过且不安全”分开。
- **输入**：Step 1 bundle 与 `references/daily-commit-skip-handling-rules.md` §1。
- **处理**：按固定优先级分类：control fetch failure → `control_plane_failure`；`processing error:` → `reviewer_or_tool_failure`；18min 文案 → `not_reviewed_time_budget`；风险 pattern → `reviewed_content_risk`。随后独立计算 identity diff：`CLAUDE.md`/`AGENTS.md` additions+deletions `>=30` 或出现新 top-level `.md` 时覆盖为 `identity_doc_major_change`，除非上游 FP rollout 已提供 `identity: FP <rollout-name>` commit prefix。
- **产物**：每 repo 唯一 primary classification 与 supporting evidence。
- **下一步消费方**：Step 3 路由对应动作。
- **失败回滚**：多个分类同时命中时采用 `identity_doc_major_change` > `control_plane_failure` > `reviewer_or_tool_failure` > `not_reviewed_time_budget` > `reviewed_content_risk`；不默选低风险分支。

### Step 3: 按 owner 边界处理

- **要解决的问题**：让 process/control failure 留在 watchdog，自解优先，owner handoff 仅处理真实领域缺口。
- **输入**：Step 2 classification。
- **处理**：`control_plane_failure` / `reviewer_or_tool_failure` 建 watchdog issue；`not_reviewed_time_budget` 只重跑被预算跳过的 repo，遵守 per-repo timeout 与 18min 总预算；`identity_doc_major_change` 使用 reference §2 的 spawn2.0 contract 路由 first-principle；`reviewed_content_risk` 检查完整 diff、拆 safe/risky path，只提交可独立验证的 safe unit，剩余风险使用 reference §3 的 watchdog child/owner contract。
- **产物**：`committed`、`clean`、`delegated`、`issue filed` 或 `left uncommitted intentionally`。
- **下一步消费方**：Step 4 验证并记录闭环。
- **失败回滚**：任何 code/shared-platform behavior 没有 executable verification 时不得提交；已 stage 的本轮文件执行 `git reset <paths>` 退回 unstaged，不触碰原有其他 stage。

### Step 4: 验证 terminal outcome 并逐项留痕

- **要解决的问题**：防止 spawn accepted、commit command exit 0 或“已处理”口头回执被当成完成。
- **输入**：Step 3 产物与原 follow-up key。
- **处理**：commit 用 `git show --stat --oneline <hash>` + 对应 verification；clean 用 `git status --short` 为空；delegated 用非空 owner final result + acceptance criteria；issue 用 `npx tsx src/cli.ts list <status>` 读回。把 classification、inspected paths、verification、terminal outcome 写进 issue result/note，并保留原 `daily-commits.log` row。
- **产物**：可执行 verification 通过的 per-repo closure receipt。
- **下一步消费方**：Console summary、watchdog issue queue、下一轮 daily-commit。
- **失败回滚**：verification 非 0 时不标 done；retry 1 次，仍失败则 issue 标 `failed` 并写 exact command/output 摘要。

## 异常枚举

| Case | 触发条件（可机械判定） | 判定方式 | 应对动作 | 通知对象 | 升级时限 |
|---|---|---|---|---|---|
| E1 上游 log/control 数据缺失 | latest log 无目标 repo，或 Feishu control fetch 非 0/空结果 | `jq -e` / `lark-cli` exit code | 不提交；分类 `control_plane_failure`；建 watchdog issue | watchdog 群 | 当轮结束前；下一次 03:15 前未恢复则 Console error |
| E2 下游 owner/FP 不响应 | spawn2.0 accepted 后 30 分钟无非空 final result | `/api/sessions/:id/result` finalMessage 为空 | 原 dirty set 保持；重发 1 次同 idempotency key | 对应 owner/FP 与 watchdog 群 | 重发后 30 分钟仍空则标 `blocked-owner` |
| E3 自身 git/CLI 执行异常 | git、Codex probe 或 issue CLI 非 0 | 捕获 exit code 与 stderr | 不改 owner 内容；retry 1 次；仍失败建/更新 watchdog issue | watchdog 群 | 立即，且当轮结束前留 issue |
| E4 diff 截断或不可读 | reviewer 文案含 `diff was truncated` / `provided diff was empty` / permission denied | pattern match + full diff command | 禁止 bulk commit；逐 path 读取并重审；仍不可读则保持未提交 | watchdog 群；确需领域判断再通知 owner | 当轮结束前 |
| E5 verification 失败 | terminal outcome 的 executable verification 非 0 | fresh command exit code | 不标 done；retry 1 次，仍失败标 issue `failed` | watchdog 群及原 owner | retry 后立即 |
| E6 18min retry 再超预算 | bounded retry elapsed `>=18min` | start/end monotonic time | 停止剩余 repo；逐项记 `watchdog-owned time budget`，不增加 scheduler timeout | watchdog 群 | 当轮结束前建 repeated-incident issue |

## 禁用项 (Do NOT during execution)

- **不准把 process failure、Codex timeout、reviewer stall、wall-clock budget skip 计为 owner content skipped**。**Why**：会污染 Console 风险统计并错误唤醒 owner。**How to apply**：Step 2/3 固定归 `watchdog-owned`。
- **不准因时间预算跳过就断言内容 unsafe**。**Why**：它只证明未审查。**How to apply**：只重跑受影响 repo，重新获取 full evidence。
- **不准用 ATP 判断 dirty tree 能否提交**。**Why**：ATP 验真实用户路径，不负责 code/content risk review。**How to apply**：先完成 Step 3；只有实际改了 Feishu/routing/card/spawn 行为才在实现后推动 ATP。
- **不准直接增加 scheduler timeout**。**Why**：18min 后还需留时间写日志、通知、Bitable sync 与 reload。**How to apply**：E6 停循环并显式记录。

## Inputs & Outputs 契约

- **Input**：`data/daily-commits.log` repo result；样本行 `{"date":"2026-05-31","repo":{"name":"mythos","committed":false,"files_changed":2,"skipped_reason":"skipped: daily-commit time budget (18min) exceeded — codex reviewer likely stalled","watchdog_owned":true}}`。
- **Output**：follow-up receipt；样本行 `{"key":"2026-05-31:mythos:time-budget","classification":"not_reviewed_time_budget","paths":["AGENTS.md","CLAUDE.md"],"terminal":"issue filed","verification":"npx tsx src/cli.ts list open","issue_id":"<uuid>"}`。
- **幂等键**：`<date>:watchdog:<target-owner>:daily-commit-skip-<repo>`；同 key 只允许一个 active follow-up，retry 写入同 issue/note。
- **Receipt / 验证 token**：terminal 对应的 fresh command exit 0；delegated 必须同时有 child ref 与非空 final result。
- **批量 evidence（§3.1）**：每个 skipped repo 单独记录 classification、inspected paths、owner、verification 与 terminal；只写 `done`/`ok` 不算。

## Companion Files

- `references/daily-commit-skip-handling-rules.md`：reason patterns、identity threshold、spawn2.0 payload、safe/risky gate 与 commit procedure。
- `SOP-daily-commit-ignore-policy-active-20260713-lmcms8.md`：ignore ownership 与 allowlist/denylist。

## Common Pitfalls

- 读取当前 git status 后覆盖原始 skipped_reason；原 log row 必须保留。
- 把 scheduler run success 当作 daily-commit business success；必须读 repo/log 产物。
- owner 回一句“已处理”就 done；必须跑本 SOP Step 4 verification。

## Verification

- `git diff --check`
- `test "$(awk '/^### Step 1:/{print NR; exit}' sop/SOP-daily-commit-skip-handling-active-20260713-lawfm2.md)" -le 25`
- `rg -q '^\| E[1-6] ' sop/SOP-daily-commit-skip-handling-active-20260713-lawfm2.md`

## Examples (Worked Cases)

- **Case A — 典型路径**：Input `18min exceeded` → `not_reviewed_time_budget` → 只重跑该 repo → verification 通过后 focused commit 或 issue receipt。
- **Case B — 非平凡分支**：Input `CLAUDE.md` 18 additions + 15 deletions → `identity_doc_major_change` → spawn first-principle；无非空 final result 前保持未提交。

## 提交前自检

- [x] §9：Step 1 在第 25 行以内。
- [x] §5：异常表 ≥3 行且六列齐全。
- [x] §1–2：reason pattern、threshold、优先级、retry 与 owner route 已锁定。
- [x] §3：Input/Output 有真实样本与幂等键。
- [x] §8：文件名/frontmatter/INDEX 使用同一 ID、状态与日期。
- [x] §3.1：每个 skipped repo 独立留 evidence。
