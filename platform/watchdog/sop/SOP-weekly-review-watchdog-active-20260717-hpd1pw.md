---
id: hpd1pw
name: weekly-review-watchdog
description: 已暂停；仅在用户明确恢复后，才可重新启用 weekly-review-watchdog 与 standing sweep。
status: suspended
owner: watchdog
created: 2026-06-03
updated: 2026-07-23
---
# SOP: Weekly Review Watchdog

> **暂停状态（2026-07-22，用户指令）**：scheduler task `ebed1046-e19f-49d5-8320-474c36d4918f`（weekly-review-watchdog）与 `5d1e4428-8a37-41bd-a411-e1b90387aead`（standing sweep）已停用。不得因本 SOP、历史报告或未关闭 follow-up 自动恢复；恢复必须由用户明确指令，并经 scheduler 读回确认。

## 核心目标

把每周双 reviewer、verifier、owner follow-up、receipt 与 watchdog 群通知闭环为可执行证据，同时守住 scheduler trigger-only 边界。

## When to Use

当 task `ebed1046-e19f-49d5-8320-474c36d4918f` 接受 Tuesday 06:30 trigger 后使用。｜**不适用**：修改 cron/enabled/retry/service logic；weekly CLI upgrade review。

## Prerequisites

- `/api/spawn2.0`、`/api/notify`、`data/watchdog.db`、`reports/weekly-review/` 可用；完整 payload/closure contract 见 `references/weekly-review-watchdog-contract.md`。

### Step 1: 验证 trigger ownership

- **要解决的问题**：防止 scheduler success 被误读为 review 完成，或结果被路由回 scheduler inbox。
- **输入**：scheduler task definition、本次 child ref、`data/watchdog.db` 与 `reports/weekly-review/`；样本见 Inputs。
- **处理**：先运行 `npx tsx src/scripts/weekly-review-closure.ts --standing-sweep --orphan-sla-hours 24`，读取 `standing-sweep.json` 的全部非终态 issue、当前 verifier FAIL、超 24 小时 stranded issue 与无 package-failure issue 的 orphan FAIL；独立 6h script task 不能消费 exit 1，所以默认 E7 escalation 会 POST `/api/notify`（`source:"watchdog"`）并对尚无 `weekly_review_standing_retries` receipt 的 stranded issue 按缺失 receipt marker 用 `spawn2.0` 重派一次，只有全部 dispatch accepted/already-registered 后才在同一事务写该 receipt 与递增通用 retry_count；`standing-sweep.json.escalation` 留 notify/dispatch receipt，`--no-escalate` 仅供本地只读检查。再 GET task `ebed1046-e19f-49d5-8320-474c36d4918f`，断言 spawn body `target:"watchdog"`、`from:"watchdog"`、closure target `todo_pool`。sweep exit 1 表示 `attentionRequired:true`，不是脚本崩溃；scheduler success 仍只记 trigger accepted。
- **产物**：`reports/weekly-review/standing-sweep.json`、`<YYYY-MM-DD>:weekly-review-watchdog` run key 与 owner-side dated directory。
- **下一步消费方**：Step 2 的两个 reviewer 使用相同 date scope 与 report root。
- **失败回滚**：payload owner 不符时不启动 reviewers；只允许修正本 task payload ownership，scheduler lifecycle 变更转 scheduler，进入异常表 E1。

### Step 2: 运行两个独立 reviewer

- **要解决的问题**：用独立视角覆盖最近 7 个自然日的 `/Users/LOCAL_USER/SuperMatrix` 与 `/Users/LOCAL_USER/SuperMatrixRuntime/workspaces`。
- **输入**：Step 1 run key、窗口 `[run-date-7d, run-date)`、两个固定 report path。
- **处理**：分别 spawn `codexroot` reviewer A/B；每个必须写非空 `reports/weekly-review/<YYYY-MM-DD>/reviewer-{a|b}/weekly-review.md`，并对每个 finding 记录 target/path、severity、evidence 与 executable verification。
- **产物**：两个独立 reviewer report；child accepted/ref 不是 report receipt。
- **下一步消费方**：Step 3 verifier 仅在两文件存在且非空后启动。
- **失败回滚**：单 reviewer 30 分钟无非空 final result 或 report 时只重试该 reviewer 1 次，写 `reviewer-<x>-retry/`，不覆盖首轮 evidence。

### Step 3: 验证 review package

- **要解决的问题**：区分 package actionable 与 owner follow-up 已完成。
- **输入**：Step 2 两份 report。
- **处理**：spawn watchdog verifier，检查 file presence、section completeness、7-day scope、evidence quality、finding-by-finding executable verification；verifier 输出写 `verifier/weekly-review-verification.md`。
- **产物**：verifier `PASS`/`FAIL` 与具体缺口；`PASS` 只证明 package complete/actionable。
- **下一步消费方**：Step 4 根据 findings 建 issue 或记录 no-follow-up。
- **失败回滚**：FAIL 后 10 分钟内创建/更新同 date package-failure issue，并只给有缺口的 reviewer 写 `reviewer-<x>-correction/` correction；correction 30 分钟内未落盘只重发该 reviewer 1 次。全部 correction 到位后 10 分钟内写 `verifier-retry/`；仍 FAIL 时保持 issue 非终态，不得进入 Charter restored 或成功 notify。verifier 已采信保留的 Critical 可按 Step 4 紧急例外独立派发，但不等于 package PASS。

### Step 4: 登记并证明 follow-up closure

- **要解决的问题**：防止 report mtime、async ref、scheduler success 或 verifier PASS 冒充 owner completion。
- **输入**：verifier PASS、required owners/findings；或 verifier FAIL 中被明确采信保留的 Critical finding。
- **处理**：正常 follow-up 只在 verifier PASS 后登记。唯一紧急例外是 verifier 明确保留且有 target/path、Critical severity、evidence、owner、executable verification 的 finding：10 分钟内单独建 `source='weekly-review-watchdog'` issue 并 spawn owner，不等待 correction；其余 finding 仍等待 PASS。建单时必须把 reviewer 的 canonical owner 与对应 standalone marker 同时写入 `--required-owner <owner> --required-completion-marker "<owner> completion: verified"`；同一 finding 若有多个独立 completion owner，就按 owner 拆 issue，协作方只写 description。reviewer 没给 owner、owner 字段有歧义或后建 follow-up 没有独立 reviewer owner 时，必须用 `--unclassified`，禁止从标题、workspace 名或 verification 猜 canonical owner。每个 owner 返回源码 commit/红绿测试/live readback 后，watchdog 必须本地跑 issue verification；通过后才在 dated `follow-up-receipts.md` 写 standalone `- <owner> completion: verified`。然后运行 `weekly-review-closure.ts`；只有 exit 0 且 JSON `purpose_met:"met"` 才可报告 Charter restored。无 follow-up 时在 notify body 明写 `no follow-up`。
- **产物**：done issue + owner receipts + closure status，或明确 no-follow-up decision。
- **下一步消费方**：Step 5 发送 watchdog-group summary。
- **失败回滚**：closure exit 1 时保持 issue 非 done/继续 tracking；不得改 receipt marker 伪造成功。

### Step 5: 通知 watchdog 群并结束 owner-side run

- **要解决的问题**：让用户看到报告/风险/closure，同时不制造 scheduler inbox 噪声。
- **输入**：Step 3 package status 与 Step 4 follow-up status。
- **处理**：POST `/api/notify`，固定 `source:"watchdog"`、`metadata.runKind:"weekly-review-watchdog"`，body 含 dated paths、verifier verdict、follow-up/no-follow-up 与 closure evidence；不向 scheduler 发送 report paths、verifier result、risk summary、messageId、judgment 或 full REPORT。通知后再次运行 Step 1 的 standing sweep，确保本轮 FAIL/issue 已出现在 status JSON。
- **产物**：watchdog-group notify messageId、刷新后的 `standing-sweep.json` 与 owner-side final state。
- **下一步消费方**：human/watchdog issue queue；scheduler 不消费 result。
- **失败回滚**：notify 失败时保留 report/issue/receipts，重试 1 次；仍失败建 watchdog issue，不切换 `source:"weekly-review-watchdog"`。

## 异常枚举

| Case | 触发条件（可机械判定） | 判定方式 | 应对动作 | 通知对象 | 升级时限 |
|---|---|---|---|---|---|
| E1 上游 task payload drift | target/from 不是 watchdog，或 closure 不是 todo_pool | GET task JSON 断言失败 | 停 reviewers；只修 ownership payload；lifecycle 变更 handoff scheduler | watchdog 群；涉及 lifecycle 再通知 scheduler | 当次 trigger 后 10 分钟内 |
| E2 下游 reviewer 不响应 | 30 分钟无非空 final result 或 report 不存在/为空 | result API + `test -s` | 只重试该 reviewer 1 次并保留首轮 ref/path | watchdog 群 | retry 后 30 分钟仍失败建 issue |
| E3 package verifier FAIL/closure 异常 | verifier 首行为 FAIL、文件缺 section，或 closure JSON 不可解析 | first-line verdict + section grep + JSON parse | 10 分钟内建/更新 package-failure issue；只派缺口 reviewer correction；到位后重跑 verifier-retry；不发 restored | watchdog 群；被 verifier 保留的 Critical 同时派对应 owner | correction 30 分钟；到位后 verifier-retry 10 分钟；各只重试 1 次 |
| E4 owner receipt 缺失 | issue done 但任一 required owner 无 standalone marker | `weekly-review-closure.ts` 返回 `not_met` | 把 issue 恢复/保持 tracking，追 owner，不接受口头完成 | required owner 与 watchdog 群 | 30 分钟无 ack 重发 1 次；再 30 分钟标 blocked-owner |
| E5 notify 下游失败 | `/api/notify` 非 2xx 或无 messageId | HTTP status/response schema | 相同 payload 重试 1 次；报告留盘，建 watchdog issue | watchdog 群（恢复后补发） | retry 后立即登记 issue |
| E6 scheduler callback 泄漏 | scheduler inbox 收到 report/result payload | cross-session receipt 或 callback audit 命中 forbidden fields | 停止后续 callback；把细节留在 report/notify/issue；修正 task prompt | watchdog 群 | 当轮结束前修正 |
| E7 standing sweep attention | `attentionRequired:true`，或 FAIL 报告超过 24 小时且无 package-failure issue，或非终态 issue 超过 24 小时 | `standing-sweep.json` 的 packageFailures/orphanedPackageFailures/strandedIssues、逐 issue `evidenceClassification`、`escalation` 与 `weekly_review_standing_retries` | 默认直接 warn notify watchdog 群；`canonical`/legacy classified 且无 E7 receipt 的 stranded issue 才按缺失 owner marker 以稳定 client_request_id 用 spawn2.0 重派一次；`unclassified` 必须显式留在 JSON/notify 且禁止把该字符串当 owner 派发；所有真实 owner dispatch accepted/already-registered 后才在事务内写 receipt 并以 active-state 条件递增通用 retry_count；不把 dispatch/exit 1 当 completion | 对应 owner（spawn2.0）与 watchdog 群（notify）；unclassified 只到 watchdog 群 | orphan 10 分钟；stranded 当次激活即重派或显式报 unclassified，notify 中要求 30 分钟内 owner evidence/分类 |

## 禁用项 (Do NOT during execution)

- **不准把 scheduler success/lastSuccessAt 当 review completion**。**Why**：scheduler-v2 只证明 spawn accepted。**How to apply**：Step 1 只建 run key，business proof 从 Step 2–5 产物读取。
- **不准把 verifier PASS 当 owner completion**。**Why**：PASS 只证明 package actionable。**How to apply**：有 follow-up 必须执行 Step 4 closure checker。
- **不准向 scheduler 回传 report path、verifier finalMessage、risk summary、notify messageId 或 follow-up judgment**。**Why**：会制造 inbox 噪声与 owner 漂移。**How to apply**：Step 5 只通知 watchdog 群。
- **不准使用 `source:"weekly-review-watchdog"` 发 notify**。**Why**：它是 task name，不是 session binding，会 fallback 到共享 Console。**How to apply**：固定 `source:"watchdog"`。
- **不准让 package FAIL 封住已采信 Critical**。**Why**：安全项可能滞留到下周 cron。**How to apply**：只对 verifier 明确保留且字段完整的 Critical 使用 Step 4 紧急例外；其他 finding 等 correction PASS。

## Inputs & Outputs 契约

- **Input**：scheduler-v2 spawn receipt；样本行 `{"task_id":"ebed1046-e19f-49d5-8320-474c36d4918f","run_date":"2026-07-07","target":"watchdog","from":"watchdog","closure":{"kind":"message","target":{"type":"todo_pool"}},"child_ref":"<session-id>"}`。
- **Output**：dated review receipt；样本行 `{"run_key":"2026-07-07:weekly-review-watchdog","standing_status":"reports/weekly-review/standing-sweep.json","reports":["reviewer-a/weekly-review.md","reviewer-b/weekly-review.md"],"verifier":"PASS","follow_up":"issue:<uuid>","closure":"purpose_met:met","notify_message_id":"<message-id>"}`。
- **幂等键**：`weekly-review-watchdog:<YYYY-MM-DD>`；同 date 复跑写 retry subdirectory/同 issue，不新建第二份 active follow-up。
- **Receipt / 验证 token**：`weekly-review-closure.ts` exit 0 + `purpose_met:"met"`，或 notify body 明确 `no follow-up`；notify response 必须含 messageId。
- **批量 evidence（§3.1）**：每个 reviewer finding 在 report 中有 target/path、severity、evidence、verification；每个 issue 在 DB 中有 canonical `required_owner` + `required_completion_marker`，或显式 `required_evidence_state='unclassified'`；每个 required owner 在 receipts 中有独立 completion marker，仅写 `done`/`ok` 不算。

## Companion Files

- `references/weekly-review-watchdog-contract.md`：task/spawn/notify payload、closure command 与 forbidden callback fields。
- `src/scripts/weekly-review-closure.ts`：Charter closure 的 authoritative verifier。

## Common Pitfalls

- verifier 通过后立刻写 Charter restored；缺 owner receipt 时应保持 `not_met`。
- 建 weekly-review issue 时只把 owner 写进标题/description，或让 closure 从 workspace 子串猜 owner；必须写结构化 owner+marker，无法确认就显式 unclassified。
- 用 `source:"weekly-review-watchdog"` 发通知；这会路由到错误群。
- retry reviewer 时覆盖初次失败 report/ref；应写 retry subdirectory 保留审计链。
- 只靠人工记得查本周目录；应在 Step 1/5 跑 standing sweep，让全部非终态 issue、FAIL package 与 24h orphan/SLA breach 落同一 JSON。
- 把独立 script task 的 exit 1 当成告警已送达；between-cycle sweep 必须有 `escalation.notification` 的 messageId，E7 dispatch 幂等性看 `weekly_review_standing_retries`，而 retry_count 只是通用可见计数，绝不是 owner completion。

## Verification

- `npx vitest run tests/scripts/weekly-review-closure.test.ts`
- `npx vitest run tests/db/schema.test.ts`
- `npx vitest run tests/db/issueStore.test.ts tests/cli.test.ts`
- `test "$(awk '/^### Step 1:/{print NR; exit}' sop/SOP-weekly-review-watchdog-active-20260717-hpd1pw.md)" -le 25`
- `rg -q 'purpose_met:\"met\"' sop/SOP-weekly-review-watchdog-active-20260717-hpd1pw.md`
- `rg -q -- '--standing-sweep --orphan-sla-hours 24' sop/SOP-weekly-review-watchdog-active-20260717-hpd1pw.md`
- `rg -q 'escalation.notification' sop/SOP-weekly-review-watchdog-active-20260717-hpd1pw.md`

## Examples (Worked Cases)

- **Case A — 典型路径**：Input trigger accepted → 两 reviewer reports → verifier PASS → no finding → watchdog notify body 写 `no follow-up`，无 scheduler callback。
- **Case B — 非平凡分支**：Input verifier PASS + two owners → issue done 但缺 owner B marker → closure `not_met` → 继续追 owner B，禁止发 restored。
- **Case C — Critical 例外**：Input verifier FAIL + retained Critical → 立即建独立 issue/spawn owner；同时派 reviewer correction → verifier-retry PASS；owner receipt 仍须由 watchdog fresh verification 后写入。

## 提交前自检

- [x] §9：Step 1 在第 25 行以内。
- [x] §5：异常表 ≥3 行且六列齐全。
- [x] §1–2：窗口、timeout、retry、closure truth source 与 callback boundary 已锁定。
- [x] §3：Input/Output 有真实样本与幂等键。
- [x] §8：文件名/frontmatter/INDEX 使用同一 ID、状态与日期。
- [x] §3.1：逐 finding 与逐 owner 留 evidence。
