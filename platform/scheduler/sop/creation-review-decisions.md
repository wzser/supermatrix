# Task Creation Async Review — Decision SOP

This SOP is consumed by **scheduler session** when batch-spawned to review fresh
task creations. The L1 mechanical lint (sop/creation-lint-errors.md, 14 codes)
has already passed; this layer catches semantic issues only an LLM can judge.

## How you got here

scheduler service's `runCreationReviewTick` (src/review/scheduler.ts) attached
a batch of pending `creation_review` rows to a fire_and_forget spawn. Your
prompt contains N reviews. For each, decide one of: **approve / patch / reject
/ escalate**.

## 8 Semantic Checks

For each review, walk through these 8 questions. Any "should not pass" → patch
or reject or escalate.

| # | Check | Trigger |
|---|---|---|
| 1 | **description 真讲清做什么/目的/约束?** | Not just CJK presence (L1 already enforced). Read for intent: 做什么 / 目的 / 关键约束 / 完成条件 (if oneshot) |
| 2 | **delegation prompt 是否要求子会话用 `REPORT:` 回复?** | `class=delegation` + `receiptProof=session_reply_content_check` (`pattern=REPORT:` or override). L1 doesn't check prompt content (runtime checks finalMessage). If prompt doesn't explicitly tell child to use that token → patch (suggest prompt edit) |
| 3 | **idempotency 标注与脚本副作用是否一致?** | Read `config.command` (shell) or prompt (delegation). Commits / sends email / appends data → idempotency=non (heal won't auto-retry). Pure read / pure compute → idempotency=pure (heal auto-retries). If mismatch → patch |
| 4 | **expectedDurationMs 是否合理?** | No history yet. Sanity-check by task type: daily aggregate ~5-30 min; quick checks 30-90 sec; weekly batch jobs up to 60 min. > cron interval → reject (will perpetually overlap) |
| 5 | **cron 频率是否合理?** | 业务巡检 every 5 min is fine; 数据采集 every minute is suspicious. Check for sub-minute (`*/30 * * * *` = every 30 min, NOT every 30 sec; SCC syntax). Sub-cron frequencies → escalate (likely typo) |
| 6 | **category 与 class 是否一致?** | `monitoring` + `报告产出` = smell (use `publication`). `sync_job` + `跨会话委派` = smell (use `delegation`). See sop/task-description-convention.md for category-class normal pairings |
| 7 | **业务逻辑是否塞进 shell executor?** | Long-running business work (>10 min) in `config.command` → should `http` executor + spawn to target session. Heuristic: command starts with `python3 <WORKSPACE_ROOT>/some-business-session/scripts/` and timeout > 30 min → reject with hint "spawn to <session>" |
| 8 | **ownerSession 真为 task owner?** | L1 already checked it's in the registry. Common mistake: typo'd sibling name (`amz-asin` vs `amzlisting-radar`). If the task's nature mismatches the owner (e.g. listing-editor work but ownerSession=qc-master), → escalate (need owner confirmation) |

## Decision Rules

- **All 8 pass** → `approve`
- **1-3 small issues with clear fix** → `patch` (provide concrete PATCH body)
- **Hard issue (will surely fail in production / business-in-shell / typo'd owner / cron sub-minute)** → `reject` with `disable: true`
- **Need owner clarification** → `escalate` (no task modification; ownerDM via Task 11 wiring)

## reply-format §

Your `finalMessage` must produce structured decisions the scheduler's
`replyParser` can consume. Format:

```
REVIEW DECISIONS — N entries

review_id: <id>
decision: approved | patched | rejected | escalated
reason: <one or two sentences, can be in 中文>
patch: { ...JSON... }            # only for patched
disable: true | false            # only for rejected; default true if omitted
```

- One block per review_id, separated by a blank line
- The leading `REVIEW DECISIONS — N entries` header is optional but encouraged
- `patch:` value can be multi-line JSON (parser handles brace-balance)
- Markdown bolding (`**review_id:**`) is tolerated
- Unknown decision values → parser fails the whole batch; stick to the 4

## Worked Examples

### Example 1 — approve

```
review_id: r-abc-123
decision: approved
reason: monitoring class, exit_zero receipt, every-10-min cron — standard heartbeat shape, no issues.
```

### Example 2 — patch (cron too dense)

```
review_id: r-def-456
decision: patched
reason: cron `* * * * *` (every minute) with expectedDurationMs=120s 一定 overlap；改为 5 min。
patch: { "cron": "*/5 * * * *", "overlapPolicy": "skip_if_running" }
```

### Example 3 — reject (business in shell)

```
review_id: r-ghi-789
decision: rejected
reason: command 是 `python3 <HOME>/.../listing-editor/scripts/big-job.py`, timeout 90 min — 业务任务塞进 shell executor. 应当 spawn 给 listing-editor session。
disable: true
```

### Example 4 — escalate (owner typo)

```
review_id: r-jkl-012
decision: escalated
reason: ownerSession=`nas-asin` 不像真的 session 名（可能是 `nas` 或 `amzlisting-radar` 的笔误）。需要 owner 确认。
```

## Failure Modes

- If you can't parse a task's snapshot → escalate, don't guess
- If the prompt is malformed → reply with the SAME format but include a leading `# PARSE ERROR\n` comment block before the decision blocks
- If you skipped any reviews (e.g. ran out of time / context), the unsubmitted ones stay `dispatched` and Task 9's decisionPoll will expire them after 24h → owner gets notified

## Related Files

- `sop/creation-lint-errors.md` — L1 mechanical errors (14 codes)
- `sop/task-description-convention.md` — description SOP and category↔class pairings
- `src/review/replyParser.ts` — what parses your reply
- `src/review/scheduler.ts` — what built the prompt and where the spawn comes from
