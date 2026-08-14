# Daily Commit Ignore Policy — canonical rules

本文件是 `SOP-daily-commit-ignore-policy-active-20260713-lmcms8.md` 的 companion reference；主 SOP 决定执行顺序，本文件锁定完整分类表。

## 1. Ownership

- `watchdog owns`：全局 allowlist/denylist、auto-remediate 限制、skip classification、owner notification wording，以及 reviewer prompt 引用政策的测试。
- `repo owner owns`：business output/evidence、generated report/export、screenshot/media/capture、可能是 cache 也可能是 deliverable 的 data path，以及未被全局 allowlist 覆盖的 repo-specific tool output。
- `first-principle` owns：`CLAUDE.md` / `AGENTS.md` 大改、新 identity file 与 baseline/template governance。
- `scheduler` owns：daily trigger 与 scheduled-task lifecycle；不判断 dirty content。

watchdog 自有终态按以下顺序尝试：

1. `deferred`：inactive/stale repo 被记录和报告，不唤醒 owner。
2. `auto-remediated`：仅修复 allowlisted machine noise，再二次筛查。
3. `committed`：可读、单一逻辑单元、低风险且 verification 已通过。
4. `watchdog-owned issue`：process failure、Codex timeout、reviewer stall、wall-clock budget skip。
5. `owner-routed`：前四项无法安全表达且确需领域判断时才使用。

## 2. Auto-remediate allowlist

只有以下四项全部为真才允许新增 `.gitignore`：

1. dirty files 全部是可复现的低风险 machine noise。
2. entry 只覆盖已观察路径，不隐藏未来 source、config、data deliverable 或 evidence。
3. 改完 `.gitignore` 后 dirty set 仍是一项逻辑变更。
4. 第二次 reviewer 对完整新 dirty set 返回 YES。

允许的 noise class：

```text
node_modules/
dist/
build/
.next/
.turbo/
.cache/
coverage/
__pycache__/
*.pyc
.pytest_cache/
.mypy_cache/
.ruff_cache/
.DS_Store
*.log
tmp/
temp/
```

路径专用 entry 优先于 broad glob：只有 `runs/tmp/` 是临时目录时，禁止写 `runs/`。

## 3. Denylist / never auto-ignore

```text
secrets
tokens
credential-adjacent config
.env
.env.*
private customer data
raw business exports
*.db
*.sqlite
*.sqlite3
*.db-wal
*.db-shm
archives
large binaries
media deliverables
files the reviewer cannot read
```

也禁止用 `.gitignore` 隐藏 merge-conflict marker、branch-divergence symptom、mixed unrelated changes、unclear ownership，或没有 executable verification 的 Feishu routing / scheduler / framework routing / spawn / issue queue / notification behavior change。

## 4. Owner-routed paths

```text
artifacts/
outputs/
data/
exports/
screenshots/
captures/
reports/
media/
```

owner-routed 不是自动 handoff。只有以下任一条件成立才通知 repo owner：

1. deliverable semantics 无法从文件内容与 owner contract 判定。
2. 包含 private/customer data 或 credential risk。
3. binary/database 不可读。
4. mixed changes 需要 repo-local split judgment。
5. repo-local ignore rule 无法从 diff 证明足够窄。

handoff 必须包含 changed path、watchdog 不能安全自解的原因、owner 应执行的动作（repo-local `.gitignore`、split safe commit 或明确保留 tracked）。

## 5. Enforcement

政策必须同时进入：

1. first-pass reviewer prompt：YES / UNSURE / CONFLICT。
2. deep-review prompt：YES / NO。
3. auto-remediate prompt：只处理 allowlisted noise，随后 re-screen。

`src/scripts/daily-commit-ignore-policy.ts` 是 runtime prompt 的 canonical path pointer；`tests/scripts/daily-commit-ignore-policy.test.ts` 必须在 pointer 或 prompt 脱离本 SOP 时失败。
