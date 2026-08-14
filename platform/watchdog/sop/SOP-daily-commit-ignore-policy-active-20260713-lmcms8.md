---
id: lmcms8
name: daily-commit-ignore-policy
description: 当 daily-commit 需要判断 dirty path 能否自动忽略、修复或提交时使用；不处理 scheduler 点火与业务 owner 的领域判断。
status: active
owner: watchdog
created: 2026-05-18
updated: 2026-07-13
---
# SOP: Daily Commit Ignore Policy

## 核心目标

把每个 dirty repo 收敛为可审计的 `committed`、`auto-remediated`、`deferred`、`owner-routed`、`fp-routed` 或 `watchdog-owned`，且不靠 `.gitignore` 隐藏风险。

## When to Use

当 daily-commit reviewer 或 skip follow-up 要判断 dirty path 的 ignore ownership 时使用。｜**不适用**：scheduler trigger/lifecycle；业务产物是否应纳入版本库的领域判断；`CLAUDE.md` / `AGENTS.md` 大改治理。

## Prerequisites

- 已知目标 repo 绝对路径，且可运行 `git status` / `git diff`；`data/daily-commits.log` 可写；完整规则见 `references/daily-commit-ignore-policy-rules.md`。

### Step 1: 固化 dirty snapshot

- **要解决的问题**：防止 reviewer 只看到摘要或截断 diff 后作出 ignore 决策。
- **输入**：目标 repo 绝对路径与当次 daily-commit 日期；上游样本见 Inputs。
- **处理**：依次运行 `git -C <repo> status --short`、`git -C <repo> diff --stat`、`git -C <repo> diff --cached --stat`、`git -C <repo> ls-files --others --exclude-standard`；候选 source/config/doc 再运行 staged 与 unstaged full diff。
- **产物**：一份包含 changed paths、staged/unstaged 状态、untracked paths、可读 full diff 的 snapshot。
- **下一步消费方**：Step 2 reviewer 用 snapshot 逐条匹配 canonical rules。
- **失败回滚**：任一 git 命令非 0 时不改 `.gitignore`、不 stage；把 repo 记为 `watchdog-owned` process failure，进入异常表 E3。

### Step 2: 按 canonical rules 分类

- **要解决的问题**：把可复现机器噪声与数据、凭证、交付物、共享平台行为分开。
- **输入**：Step 1 snapshot、现有 `.gitignore`、`references/daily-commit-ignore-policy-rules.md`。
- **处理**：只有规则文件 §2 的四个条件全部为真才判 `auto-remediate`；命中 §3 任一 denylist 就判 `left uncommitted intentionally` 或 `owner-routed`；命中 §4 owner-routed path 先依次尝试 `deferred`、安全自解、`watchdog-owned issue`，只有领域语义无法从 diff 证明时才 handoff。
- **产物**：每 repo 一个分类、原因、changed paths 与下一动作；`watchdog owns` 全局 allowlist/denylist，`repo owner owns` repo-local 交付物规则。
- **下一步消费方**：Step 3 执行分类结果。
- **失败回滚**：同一 dirty set 同时命中 allowlist 与 denylist 时强制选择 denylist 终态，不写 ignore，进入异常表 E1。

### Step 3: 执行动作并二次筛查

- **要解决的问题**：避免 `.gitignore` 改动本身掩盖 source、config、data deliverable 或 evidence。
- **输入**：Step 2 分类与原 snapshot。
- **处理**：`auto-remediate` 只增加覆盖已观察噪声的最窄 path-specific entry；随后重新执行 Step 1。只有新 dirty set 仍是一项逻辑变更、无 denylist、第二次 reviewer 为 YES 才 stage/commit。其他分类不得改 `.gitignore`。
- **产物**：focused commit，或保持未提交的明确分类。
- **下一步消费方**：Step 4 写逐 repo evidence；skip follow-up 读取未提交项。
- **失败回滚**：二次 reviewer 非 YES 时撤销本次新增的 ignore 行，保留原 dirty files，并记录 `auto-remediate rejected`。

### Step 4: 写逐 repo evidence

- **要解决的问题**：批量跑 N 个 repo 后，只看结构化记录即可判断每项走了哪条政策分支。
- **输入**：Step 3 终态、commit hash 或 skipped reason。
- **处理**：把每 repo result 写入 `data/daily-commits.log` 当日 JSON 的 `repos[]`；至少保留 `name`、`files_changed`、`committed`、`message`、`skipped_reason`，并按分支写 `deferred:true` 或 `watchdog_owned:true`。owner handoff 另留 changed path、不能自解原因与 owner action。
- **产物**：逐项 evidence 行与当日 totals；空白或仅写 `ok` 不算 evidence。
- **下一步消费方**：Console/Bitable summary 与 `daily-commit-skip-handling`。
- **失败回滚**：日志写入失败时禁止报告 run 成功；保留 repo 工作树不动，通知 watchdog 群并在本轮结束前建 watchdog issue。

## 异常枚举

| Case | 触发条件（可机械判定） | 判定方式 | 应对动作 | 通知对象 | 升级时限 |
|---|---|---|---|---|---|
| E1 上游 dirty data 冲突 | 同一 path 同时匹配 allowlist 与 denylist，或 full diff 缺失 | 规则匹配结果非唯一，或候选文件无 full diff | denylist 优先；不写 ignore；记录 `reviewed_content_risk` | watchdog 群；确需领域判断再发 repo owner | 当轮结束前；owner 30 分钟无 ack 则保留未提交并建 issue |
| E2 下游 reviewer 不响应 | reviewer 超过 120 秒或返回空文本 | subprocess timeout/empty-output 记录 | 不提交；以相同 prompt 重试 1 次，仍失败记 `watchdog-owned` | watchdog 群 | 重试失败后当轮结束前建 issue |
| E3 自身 git/日志执行异常 | 任一 git 命令非 0，或 `daily-commits.log` append 失败 | exit code 非 0 / append 后读回缺少 repo name | 不改工作树；记录 process failure；修复后只重跑受影响 repo | watchdog 群 | 立即；下一次 scheduled run 前未恢复则升级 Console error |
| E4 owner handoff 无回执 | owner-routed 后 30 分钟无可执行答复 | handoff ref 无 ack/result | 不猜 owner 语义、不自动 ignore；重发 1 次并保留 watchdog tracking issue | repo owner 与 watchdog 群 | 重发后 30 分钟仍无 ack 标 `blocked-owner` |
| E5 二次筛查拒绝 | `.gitignore` 改后 reviewer 非 YES 或 dirty set 仍混杂 | Step 1 rerun + reviewer verdict | 撤销本次 ignore 行；原 dirty files 保留；转 `reviewed_content_risk` | watchdog 群 | 当轮结束前登记结果 |

## 禁用项 (Do NOT during execution)

- **never auto-ignore / 不准自动 commit secrets、token、credential-adjacent config、私有客户数据、raw business export、DB/WAL/SHM、archive、不可读 binary 或 media deliverable**。**Why**：会永久隐藏风险或交付证据。**How to apply**：Step 2 denylist 一票否决。
- **不准用 broad path（如 `data/`、`reports/`、`runs/`）替代已观察的窄路径**。**Why**：同名目录在不同 repo 可能是正式交付物。**How to apply**：Step 3 只允许 path-specific entry。
- **owner handoff is a last resort；watchdog should resolve about 90% 的 skipped repo**。**Why**：process failure 和可自愈噪声属于 watchdog。**How to apply**：Step 2 必须先走 defer/self-resolve/watchdog issue。

## Inputs & Outputs 契约

- **Input**：dirty repo snapshot，来源为 git working tree；样本行 `{"repo":"/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/mythos","status":["?? __pycache__/x.pyc"],"date":"2026-05-31"}`。
- **Output**：`data/daily-commits.log` 的 repo result；样本行 `{"name":"mythos","committed":false,"files_changed":2,"skipped_reason":"skipped: daily-commit time budget (18min) exceeded — codex reviewer likely stalled","watchdog_owned":true}`。
- **幂等键**：当次 run 内用 `<date>:<repo-name>`；同一 repo 的 bounded retry 保留原 result，并追加带同 key 与 `retry` 标记的 follow-up note，不覆盖原 evidence。
- **Receipt / 验证 token**：`tail -1 data/daily-commits.log | jq -e '.repos[] | select(.name=="<repo>") | has("committed")'` 返回 0。
- **批量 evidence（§3.1）**：每个 eligible repo 都必须在 `repos[]` 有具体分类证据；`message`/`skipped_reason`、`deferred`/`watchdog_owned` 与 totals 必须一致，空白或 `ok` 禁止。

## Companion Files

- `references/daily-commit-ignore-policy-rules.md`：ownership、allowlist、denylist、owner-routed path 与 enforcement 的完整规则。
- `SOP-daily-commit-skip-handling-active-20260713-lawfm2.md`：未提交结果的 follow-up 流程。

## Common Pitfalls

- 把 owner-routed 误读为自动 handoff；正确顺序是 watchdog 自解优先。
- 只看 `diff --stat` 就批准 ignore；候选 source/config/doc 必须看 full diff。
- 把 process timeout 计入 owner content skipped；它必须是 `watchdog-owned`。

## Verification

- `npx vitest run tests/scripts/daily-commit-ignore-policy.test.ts`
- `git diff --check && test "$(awk '/^### Step 1:/{print NR; exit}' sop/SOP-daily-commit-ignore-policy-active-20260713-lmcms8.md)" -le 25`

## Examples (Worked Cases)

- **Case A — 典型路径**：Input `?? __pycache__/score.pyc` → 加最窄 `__pycache__/` entry → rerun snapshot/reviewer → Output `auto-remediated` commit + repo evidence。
- **Case B — 非平凡分支**：Input `data/supermatrix.db` → denylist 与 owner-routed 同时命中 → denylist 优先，Output `left uncommitted intentionally`；若用途无法从 diff 判断才 handoff。

## 提交前自检

- [x] §9：Step 1 在第 25 行以内。
- [x] §5：异常表 ≥3 行且六列齐全。
- [x] §1–2：分类、阈值、优先级与 fallback 已锁定。
- [x] §3：Input/Output 有真实样本与幂等键。
- [x] §8：文件名/frontmatter/INDEX 使用同一 ID、状态与日期。
- [x] §3.1：逐 repo evidence 写入 `data/daily-commits.log`。
