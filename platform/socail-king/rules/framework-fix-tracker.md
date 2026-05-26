# 框架修复追踪

哪些 exception-patterns 的 framework 建议已经落地、哪些还在等 codexroot。
每次裁决前先查这张表——如果这个 failure_kind 的修法已部署但 async 项还是来了,说明有新变种,值得查。
如果修法没部署,且本次现场 artifact 齐全,可以走 shortcut 判 false_alarm 或对应 verdict,不浪费 token 做全量调查。

**证据红线:**

- shortcut 只能基于本 comm 的一手 artifact: `spawn_async_items`、`cross_session_log`、message_run、`result_sink_attempts`、predicate/patch 记录、watcher 结构化检查结果。
- `cross_session_log` 无行、prompt/final/message_run/sink 关键字段读不到、或只能靠 storm/timestamp/pattern 匹配时,禁止套本表 shortcut。先走 `sop/spawn-exception-transaction.md` 的 Step 1 全量收现场;仍无法判断就升级或标 stale/unknown,不要写 EP 结论。
- prompt 里的"无须回复"必须来自实际 prompt 或可审计 message_run/context,不能从历史同型或截图摘要反推。
- 同 prompt storm 只说明"值得查",不是 verdict 证据。

---

## EP-1: sync_inline delivery_missing

- **framework 建议**: `deliveredSinkAttemptExists` 把 `status=skipped` + note 含 `sync_inline handler owns delivery` 视同 delivery 成功
- **涉及文件**: `threePhaseCheck.ts:186-187`, `spawnClosureClassify.ts:643`
- **状态**: 🟢 已部署 (2026-05-21)
- **裁决 shortcut**: 理论上不应再收到此类。若仍收到 → 是新变种,走全量裁决

## EP-2: late_result 误判

- **framework 建议 #1**: `classifyAsyncItem` 对 `late_result + !executionPassed + !executionTerminal` → `noop`(继续等)
- **framework 建议 #2**: 不入 async 项的前提——`message_run.status=running` 且无 error → 不登记 delivery 失败
- **涉及文件**: `spawnClosureClassify.ts:149-154`(建议#1), courier-model delivery check(建议#2)
- **状态**: 
  - 建议 #1: 🟢 已部署 (2026-05-21, `late_result + !executionTerminal` → noop, `+ executionTerminal` → redrive)
  - 建议 #2: 🟡 待评估(codexroot 确认 courier model 是否覆盖"仍在跑则不登记 async")
- **裁决 shortcut**: 
  - 仍收到的 `late_result` → 应该只剩两种:executionPassed=true(正常补投) 或 executionTerminal+!executionPassed(真异常,值得查)
  - 若再出现 child 仍 running 的 late_result 裁决 → watcher 的 noop 没生效,查 watcher bug

## EP-3: fire-and-forget empty_output

- **framework 建议**: `checkExecution` 在 `callerInvocation=fire_and_forget` 时跳过空产出检查
- **涉及文件**: `threePhaseCheck.ts:91-96`
- **状态**: 🟢 已部署 (2026-05-21)
- **裁决 shortcut**: 不应再收到此类。若仍收到 → 检查 `callerInvocation` 是否正确传入 `/api/spawn`

## client_request_id 跨 comm 去重

- **framework 建议**: 升级前查同 `client_request_id` 的另一条 completed comm
- **涉及文件**: `spawnClosureClassify.ts:651-676`(classify 逻辑), `cross_session_log`(client_request_id 列 + 索引), `/api/spawn`(写入)
- **状态**: 🟢 已部署,全链路验证通过 (2026-05-21)
- **裁决 shortcut**: 不应再收到此类。若仍收到 → caller 没带 `client_request_id`,正常裁决

## 孤儿 comm 兜底回收

- **framework 建议**: 启动时 + watcher tick 扫 pending + 无 child 的 comm
- **涉及文件**: `orphanSweep.ts`(已实现), watcher 脚本(已导入), `bootstrap.ts`(启动时调用)
- **状态**: 🟢 已部署
- **裁决 shortcut**: 不适用(watcher 代码层处理,不升级 SK)
