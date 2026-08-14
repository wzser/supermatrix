# daily-commit skip-handling — companion references

> 本文件是 `SOP-daily-commit-skip-handling-*` 的第 3 层背景总台（SOP Principle §9）。
> body 只留指针；改模板 / 清单只改这里。

## §R1 证据命令总台

按顺序取证（SOP Step 1 的输入）：

```bash
cd /Users/LOCAL_USER/SuperMatrixRuntime/workspaces/localgit
tail -1 data/daily-commits.log                 # 本轮 run 结果（每仓终态）
tail -20 data/daily-commit-dispatches.jsonl    # owner hint 发送 / 抑制记录
tail -20 data/daily-commit-decisions.jsonl     # owner / localgit 裁决记录
tail -80 data/git-ledger.jsonl                 # 每仓 commit / skip 账本行
```

调度侧与目标仓：

```bash
# scheduler 运行状态（只读；task id = localgit-daily-commit）
curl -s 'http://localhost:3500/tasks/185ddf95-3f0e-4b7b-9d11-77028c5d8793/runs?limit=1'

# 目标仓现场
git -C <repo> status --short
git -C <repo> diff --stat
git -C <repo> diff --check
git -C <repo> diff -- <path>            # reviewer 因截断没看到的文件，取全量 diff
git -C <repo> diff --cached -- <path>
```

本地 session 治理选择（不读飞书）：

```bash
sqlite3 -readonly "${SM_RUNTIME_ROOT:-/Users/LOCAL_USER/SuperMatrixRuntime}/data/supermatrix.db" \
  "SELECT name, workdir
   FROM sessions
   WHERE status != 'deleted'
     AND scope != 'child'
     AND affiliated_to = 'first-principle'
     AND category NOT IN ('外部', '员工')
     AND workdir != ''
   ORDER BY name;"
```

reviewer 依赖健康探针（time-budget skip 收尾必跑）：

```bash
codex --version
codex exec --model "${LOCALGIT_DAILY_COMMIT_CODEX_MODEL:-gpt-5.4}" \
  --sandbox read-only \
  'Reply with exactly OK'
```

identity-doc 变更检查：

```bash
git -C <repo> diff --numstat -- ':(top)CLAUDE.md' ':(top)AGENTS.md'
git -C <repo> diff --cached --numstat -- ':(top)CLAUDE.md' ':(top)AGENTS.md'
git -C <repo> status --short -- ':(top)*.md'
```

## §R2 spawn 模板：identity_doc_major_change → first-principle

逐仓发一条；`<dispatch_id>` 取 daily-commit dispatchId，`<verification_token>` 用 `comm_identity_doc_major_<dispatch_id>`（非字母数字替换为 `_`），`<repo>` 替换成目标仓名。

```bash
curl -s -X POST http://localhost:3501/api/spawn2.0 \
  -H "Content-Type: application/json" \
  -d '{
    "target":"first-principle",
    "from":"localgit",
    "prompt":"[verification: <verification_token>] Daily-commit found identity_doc_major_change in <repo>.\n关联ID：<dispatch_id>\nDirty-Fingerprint：<dirty_fingerprint>\nSkipped reason: <skipped_reason>\nRead /Users/LOCAL_USER/SuperMatrixRuntime/workspaces/first-principle/templates/console-principles.md section \"Session Identity Document Change Discipline\", then inspect <repo> identity-doc diff. Acceptance: decide whether this is T2 session-owned self-evolution, T3 baseline-template change request, T4 forbidden new identity doc, or FP-orchestrated rollout; either commit with the correct identity prefix or tell localgit the exact safe next action. Localgit must not auto-commit this dirty set without your decision.",
    "client_request_id":"'"$(date +%F)"':localgit:first-principle:identity-doc-major-<repo>",
    "closure":{"kind":"message","target":{"type":"todo_pool"}},
    "verification_predicate":{
      "type":"inbox-message",
      "session_name":"first-principle",
      "field":"prompt",
      "contains_all":["<verification_token>"],
      "expected_window_sec":600
    }
  }'
```

Receipt 语义：

- HTTP 202 且 JSON 同时满足 `ok:true` / `mode:"async_kickoff"` / `closure:"todo_pool"` / `ref` 非空 / `spawnCommId` 非空 = spawn2.0 todo_pool accepted；HTTP 409 且 `duplicate:true`、`existing.commId` 非空、`existing.status` 非空 = 同 `client_request_id` 已登记，拿 `existing.commId` / `existing.status` 继续跟进；两者都只证明 delegation accepted，不证明 FP review 完成。
- 不能把任意 HTTP 2xx、`ok:false`、`mode:"switched_async"`、或缺 `spawnCommId` / `existing.status` 的回执当作 accepted。
- 其它 HTTP 状态 / 非 JSON / curl 失败 → 写 `fp_escalation` `status:"failed"` dispatch 行，仓保持 blocked，不自动提交。
- dispatch 行必须带 `clientRequestId`、verification token、accepted receipt（如 `spawn2.0 todo_pool accepted ref=... spawnCommId=...` 或 duplicate existing commId/status）。

FP 裁决后的落地规则：

- FP-orchestrated rollout → commit message 必须以 `identity: FP <rollout-name>` 开头。
- T2 session-owned self-evolution → 由 owning session 以 `identity:` 前缀提交。
- T3/T4 → 按 FP 的 template-change / relocation 指示执行，daily-commit 不代提交。
- 禁止本地自造 `identity: FP` 前缀绕过分类；前缀只能来自 FP rollout handoff 或候选 commit message。

## §R3 spawn 模板：reviewed_content_risk → localgit 子会话

```bash
curl -s -X POST http://localhost:3501/api/spawn2.0 \
  -H "Content-Type: application/json" \
  -d '{
    "target":"localgit",
    "from":"localgit",
    "prompt":"[verification: comm_daily_commit_skip_<yyyymmddHHMMss>] Review daily-commit skipped repo <repo>. Reason: <skipped_reason>. Inspect full diff, split safe changes from risky changes, commit only reviewed safe changes, and report risky leftovers with acceptance criteria.",
    "client_request_id":"'"$(date +%F)"':localgit:localgit:daily-commit-skip-<repo>",
    "closure":{"kind":"message","target":{"type":"inline"}},
    "verification_predicate":{
      "type":"inbox-message",
      "session_name":"localgit",
      "field":"prompt",
      "contains_all":["comm_daily_commit_skip_<yyyymmddHHMMss>"],
      "expected_window_sec":600
    }
  }'
```

注意：不用 ATP 做 content-risk review——ATP 是实现路径选定后的真实用户环境行为验证，不是「脏工作区能不能提交」的判定工具。

## §R4 safe / risky 切分清单（Step 4 用）

常见 safe 单元（可独立提交）：

```text
AGENTS.md + CLAUDE.md synchronized T1 wording change（<30 行、无新顶层 .md）
FP-orchestrated identity rollout（commit message 前缀 "identity: FP ..."）
```

常见 risky 单元（不准 bulk commit，逐项处理）：

```text
identity_doc_major_change without FP-orchestrated commit prefix
Feishu sender / notification module
scheduler task registration
framework dispatcher or spawn path
database schema or migration
bulk generated data / runtime logs
credential-bearing config
binary or compressed artifacts
```

Feishu 路由 / 通知 / 群名 / `/new` / `/backend` / 卡片渲染 / spawn 流这类真实
Feishu 行为变更：子会话先切分，落码后由实现方申请对应下游验证路径。

## §R5 skip 三分类与 decision 枚举语义（Step 4 / Step 5 用）

owner handoff 是最后手段，转移前先三分类：

1. `localgit-owned`：process error、Codex timeout、reviewer stall、wall-clock
   budget skip、session-selection failure。localgit 自修，不吵 owner，不计入 Console
   content `skipped`。含 source/config/test/SOP/identity-doc/package/migration/
   schema/平台行为的 stale 脏集 = localgit-owned must-review backlog，不是 quiet defer。
2. `self-resolvable`：artifact-only 静置脏集、窄 allowlist 机器噪音、可读的
   单逻辑低风险变更。defer / auto-remediate / 验证后提交。
3. `owner-required`：交付物语义不明、私有/客户数据、凭证风险、不可读二进制/DB、
   需 repo-local 切分判断的混合变更、无法从 diff 证明足够窄的 ignore 规则。
   仅此类可发 owner hint（先过 Step 5 抑制）。

`npm run daily-commit-decision` 的 `--decision` 枚举：

| 值 | 何时用 |
|---|---|
| `quiet_until_changed` | 当前 fingerprint 不该再被问；变化前保持静默 |
| `owner_will_commit` | owner 接手承诺自己提交 |
| `blocked` | owner 确认该脏集必须保持未提交 |
| `localgit_retry` | 工具 / reviewer 容量失败，localgit 自己重试 |
| `notify_again` | 唯一能主动重开已抑制 fingerprint 的值 |

## §R6 自动提交允许 / 必跳清单（Step 6 复核用；逐文件判定以判定矩阵 SOP 为准）

允许自动提交须全部为真：reviewer 看到了相关完整 diff（非截断前缀）；单一逻辑单元；
无 secrets / tokens / 私有数据 / DB WAL/SHM / cache / runtime artifact；不静默改共享
平台行为；commit message 描述真实行为；代码变更已跑相称验证（doc-only 免）；
identity-doc 变更是 T1 或带 `identity: FP` 前缀；`.gitignore` 变更过类目目录
（`references/daily-commit-ignore-policy.md`）且足够窄。

必须跳过任一为真：diff 截断掩盖关键文件；触碰 Feishu / scheduler / 框架路由 /
spawn / issue queue / 通知且无可执行验证；含 untracked bulk output / `.pyc` /
`.DS_Store` / `*.db-wal` / `*.db-shm` / 压缩包 / 媒体 / raw 业务数据；疑似 secrets；
混合无关变更；reviewer 读不了内容；有冲突标记或分支分叉症状；
`identity_doc_major_change` 无 FP 前缀；拟 ignore 的是 owner-routed 路径且
localgit 无法证明安全自解。
