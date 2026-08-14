# Daily Commit Skip Handling — classification and handoff rules

本文件是 `SOP-daily-commit-skip-handling-active-20260713-lawfm2.md` 的 companion reference。

## 1. Classification patterns

按主 SOP 的优先级匹配：

| Classification | Exact signal |
|---|---|
| `control_plane_failure` | `daily-commit control fetch failed` |
| `reviewer_or_tool_failure` | `processing error:` |
| `not_reviewed_time_budget` | `skipped: daily-commit time budget (18min) exceeded` |
| `reviewed_content_risk` | `diff was truncated`、`cannot confirm absence of secrets`、`runtime artifacts`、`__pycache__`、`.db-wal`、`.db-shm`、`.DS_Store`、`conflict detected`、`unsafe to bulk-commit`、`manual inspect`、`permission denied`、`provided diff was empty` |

identity classification 独立于 reason pattern：

```bash
git -C <repo> diff --numstat -- ':(top)CLAUDE.md' ':(top)AGENTS.md'
git -C <repo> diff --cached --numstat -- ':(top)CLAUDE.md' ':(top)AGENTS.md'
git -C <repo> status --short -- ':(top)*.md'
```

当 `CLAUDE.md` / `AGENTS.md` additions+deletions 合计 `>=30`，或任何新 top-level `.md` 出现时，分类为 `identity_doc_major_change`。唯一例外：FP rollout handoff 已提供以 `identity: FP <rollout-name>` 开头的候选 commit message；不得由 watchdog 自行发明该 prefix。

## 2. `identity_doc_major_change` handoff

向 `/api/spawn2.0` 发送：

```json
{
  "target": "first-principle",
  "from": "watchdog",
  "prompt": "[verification: comm_identity_doc_major_<yyyymmddHHMMss>] Daily-commit found identity_doc_major_change in <repo>. Read first-principle Session Identity Document Change Discipline, inspect the exact diff, classify T2/T3/T4 or FP rollout, then either land the correct identity commit or return the exact safe next action.",
  "client_request_id": "<YYYY-MM-DD>:watchdog:first-principle:identity-doc-major-<repo>",
  "closure": {"kind":"message","target":{"type":"inline"}},
  "verification_predicate": {
    "type": "inbox-message",
    "session_name": "first-principle",
    "field": "prompt",
    "contains_all": ["comm_identity_doc_major_<yyyymmddHHMMss>"],
    "expected_window_sec": 600
  }
}
```

spawn2.0 accepted 只证明交付已接收。必须轮询 child result，且 final result 非空并给出可执行 next action，才算 handoff receipt。

## 3. `reviewed_content_risk` follow-up

1. 从 `skipped_reason` 提取 risky paths。
2. 逐 path 读取 staged/unstaged full diff。
3. 把 safe low-risk unit 与 risky unit 分开。
4. safe unit 只有在独立、可读、无 secret/private data/runtime artifact/shared-platform unverified behavior 时才可提交。
5. risky unit 用 watchdog child follow-up；只有确需领域语义时才转 repo owner。

watchdog child payload：

```json
{
  "target": "watchdog",
  "from": "watchdog",
  "prompt": "[verification: comm_daily_commit_skip_<yyyymmddHHMMss>] Review skipped repo <repo>. Reason: <skipped_reason>. Inspect full diff, split safe and risky paths, commit only verified safe changes, and return risky leftovers with acceptance criteria.",
  "client_request_id": "<YYYY-MM-DD>:watchdog:watchdog:daily-commit-skip-<repo>",
  "closure": {"kind":"message","target":{"type":"inline"}},
  "verification_predicate": {
    "type": "inbox-message",
    "session_name": "watchdog",
    "field": "prompt",
    "contains_all": ["comm_daily_commit_skip_<yyyymmddHHMMss>"],
    "expected_window_sec": 600
  }
}
```

Safe-unit examples：T1 `AGENTS.md` + `CLAUDE.md` 同步小改；带真实 FP rollout prefix 的 identity rollout。

Risky-unit examples：无 FP prefix 的 identity major change、Feishu sender/notification、scheduler registration、framework dispatcher/spawn、DB schema/migration、bulk generated data、runtime logs、credential-bearing config、binary/archive。

## 4. Automatic commit gates

以下条件全部为真才允许提交：

1. reviewer 看到相关 full diff，不是 truncated prefix。
2. 变更是一项逻辑单元。
3. 无 secret/token/private data/DB WAL-SHM/cache/runtime artifact。
4. 不会静默改变 shared-platform behavior。
5. commit message 描述实际行为。
6. code change 的 repo-native executable verification 已通过；doc-only 明确记录无需 runtime test。
7. identity docs 是 T1，或有真实 FP rollout prefix。
8. `.gitignore` 改动符合 canonical ignore policy 且足够窄。

任一条件不成立就保持未提交。owner handoff 前再分：

- `watchdog-owned`：process error、timeout、reviewer stall、budget/control-plane failure。
- `self-resolvable`：stale defer、allowlisted noise、可读的一项低风险变更。
- `owner-required`：deliverable semantics、private/customer data、credential risk、不可读 binary/DB、repo-local split/ignore judgment。

## 5. Focused commit procedure

```bash
git -C <repo> add <file1> <file2>
git -C <repo> diff --cached --check
git -C <repo> -c user.name=<session-name> -c user.email=<session-name>@local commit -m "<message>"
git -C <repo> show --stat --oneline HEAD
```

code changes 在 commit 前运行目标 repo 的真实 test runner。变更属于其他 session 且需 domain judgment 时不得代 commit。daily-commit 脚本自身变更在 watchdog 完成测试与 commit，下一次 scheduled run 再提供 production-shape evidence。
