# Weekly Review Watchdog — payload and closure contract

本文件是 `SOP-weekly-review-watchdog-active-20260717-hpd1pw.md` 的 companion reference。

## 1. Trigger contract

Authoritative task：

```bash
curl -s http://127.0.0.1:3502/tasks/ebed1046-e19f-49d5-8320-474c36d4918f
```

spawn ownership 必须是：

```json
{
  "target": "watchdog",
  "from": "watchdog",
  "closure": {"kind":"message","target":{"type":"todo_pool"}}
}
```

不得使用 `from:"scheduler"`。scheduler-v2 在 spawn2.0 返回 child ref 时记录 trigger success；它不解析、endorse 或跟踪 review result。

## 2. Review package paths

```text
reports/weekly-review/<YYYY-MM-DD>/reviewer-a/weekly-review.md
reports/weekly-review/<YYYY-MM-DD>/reviewer-b/weekly-review.md
reports/weekly-review/<YYYY-MM-DD>/verifier/weekly-review-verification.md
reports/weekly-review/<YYYY-MM-DD>/follow-up-receipts.md
reports/weekly-review/<YYYY-MM-DD>/closure-status.md
```

Reviewer scope 固定为最近 7 个自然日 `[run-date-7d, run-date)`，覆盖：

```text
/Users/LOCAL_USER/SuperMatrix
/Users/LOCAL_USER/SuperMatrixRuntime/workspaces
```

每个 finding 必须含 target/path、severity、证据命令或文件行、明确 owner、executable verification。verifier 检查 file presence、section completeness、scope coverage、evidence quality、follow-up executability。

## 3. Follow-up closure contract

存在 owner follow-up 时，三项必须同时成立：

1. `data/watchdog.db` 的 issue `source='weekly-review-watchdog'`，且建单时已持久化 `required_evidence_state='canonical'`、`required_owner`、`required_completion_marker`；确无 reviewer owner 的派生项必须持久化 `required_evidence_state='unclassified'`。
2. issue `status='done'` 且 executable verification 已实际通过。
3. 每个 required owner 在 dated receipts 中有 standalone bullet：`- <owner> completion: verified`。

建单入口固定为：

```bash
npx tsx src/cli.ts add \
  --title "<finding title>" \
  --source "weekly-review-watchdog" \
  --description "<finding evidence and owner scope>" \
  --verification "<executable verification>" \
  --required-owner "<reviewer canonical owner>" \
  --required-completion-marker "<reviewer canonical owner> completion: verified"
```

Reviewer owner 缺失或歧义时，把最后两项替换为 `--unclassified`。同一 finding 有多个独立 completion owner 时按 owner 拆 issue；不得把逗号分隔 owner 塞进单值字段，也不得靠标题/description 子串补 canonical owner。

运行：

```bash
npx tsx src/scripts/weekly-review-closure.ts \
  --issue-id <weekly-review-issue-id> \
  --receipts reports/weekly-review/<YYYY-MM-DD>/follow-up-receipts.md
```

只有 exit 0 且 JSON `purpose_met:"met"` 才证明 Charter restored。exit 1 / `purpose_met:"not_met"` 表示仍待 owner closure。`--owners a,b` 仅用于旧 issue 的 verification 未列 receipt marker 时。

以下均不是 completion evidence：verifier PASS、report mtime、dispatch receipt、async ref、scheduler `lastSuccessAt`。

## 4. Standing sweep and Critical fast path

每次 weekly-review 开始和 owner-side 结束前运行：

```bash
npx tsx src/scripts/weekly-review-closure.ts \
  --standing-sweep \
  --orphan-sla-hours 24 \
  --write-standing-status reports/weekly-review/standing-sweep.json
```

JSON 固定列出全部 `open|in_progress|pending` weekly-review issue、最新 verifier、当前 FAIL package、超过 24 小时的 stranded issue，以及超过 24 小时且没有 package-failure tracking issue 的 orphan FAIL。每个 issue 必须带 `evidenceClassification`（`canonical|legacy_inferred|unclassified`）、`requiredOwners`、`requiredCompletionMarkers` 与 `missingOwners`；无法分类时必须输出 `unclassified`，不得用空 `missingOwners` 冒充“没有缺失 owner”。`attentionRequired:true` 时 exit 1；这表示需要 follow-up，不是命令执行失败。

between-cycle 的 scheduler `type=script` 不消费这个 exit code。故默认 `--standing-sweep` 还必须执行 E7 escalation：先把每条 stranded issue 的分类、缺失 owner completion marker 与 `retry_count` 写入 status，再 POST `/api/notify`（`source:"watchdog"`、`level:"warn"`）；对没有 `weekly_review_standing_retries` durable receipt、分类不是 `unclassified` 且有缺失 marker 的 issue，按 marker owner 以稳定 `client_request_id` 用 `/api/spawn2.0` 重派一次。`unclassified` 只进入 JSON/notify，禁止作为 target。所有真实 owner 的 dispatch 都为 accepted 或 idempotently already-registered 后，才在同一个 active-state transaction 写 E7 receipt 并递增通用 `retry_count`（它也可能包含 verification retry，不能作为幂等门）。`standing-sweep.json.escalation` 必须留下 notify messageId/error 和每个 dispatch 的状态；这些仅证明追办已发出，不是 owner completion。`--no-escalate` 只供本地只读检查。PASS verifier 的 age 不标 `slaBreached`，避免历史 PASS 报告制造恒真噪声。

package FAIL 后正常 findings 必须等 correction + verifier-retry PASS。唯一例外是 verifier 明确采信保留且同时具备 target/path、Critical severity、evidence、owner、executable verification 的 finding：watchdog 在 10 分钟内单独建 issue 并 spawn owner。owner accepted/ref 只算 dispatch；watchdog fresh verification 通过后才可写 `- <owner> completion: verified`。

## 5. Notify contract

```bash
curl -s -X POST http://localhost:3501/api/notify \
  -H 'Content-Type: application/json' \
  -d '{
    "source":"watchdog",
    "title":"weekly-review-watchdog <YYYY-MM-DD>",
    "body":"<dated report paths + verifier verdict + follow-up/no-follow-up + closure evidence>",
    "level":"info",
    "metadata":{"runKind":"weekly-review-watchdog"}
  }'
```

`source:"weekly-review-watchdog"` 禁止：它不是 session binding，API 会 fallback 到共享 Console group。

## 6. No scheduler callback

run 完成后不得向 scheduler 发送：

```text
report paths
verifier finalMessage
P1/P2/P3 risk summaries
watchdog notify messageId
watchdog follow-up/no-follow-up judgment
full REPORT payloads
```

如果 child runtime 强制需要 final sentence，只允许：

```text
weekly-review-watchdog closed inside watchdog; details were notified to the watchdog group.
```

完整 completion 只存在于 dated reports、watchdog notification 和 watchdog issue state。

## 7. Scheduler boundary

watchdog 可直接修正的唯一 scheduler-v2 task field 是本 task payload 的 result ownership（`target/from/closure`）。cron timing、enabled state、retry policy 与 scheduler-v2 service logic 均通过 spawn2.0 handoff 给 `scheduler`，不得在本 SOP 内修改。
