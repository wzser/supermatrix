# 从老 task schema 迁到 classed lifecycle（owner 自助）

> 适用对象：你 own 一条 `class IS NULL` 的旧 task（手动 PATCH 把它启用、看到 scheduler 日志报怪、或 `POST /tasks` 返回 400），想自己升到新版本。
>
> 设计背景看 `docs/2026-04-25-scheduler-redesign-briefing.md`，这里只讲怎么动手。

---

## 1. 为什么你的老 curl 不工作了

`POST /tasks` 现在硬要求三个字段：`class`、`expectedDurationMs`、`ownerSession`。少一个就 400。这是 commit 6ab727a 起的"legacy lockout" —— scheduler 不再创建 `class IS NULL` 的新 task。

**已经存在**的 `class IS NULL` task（绝大多数已被 owner 在 migration proposal 里 `DISABLE` 掉）继续保留在 DB 里，scheduler 不会替你迁。它就那样躺着，要么停用，要么你自己重建。

## 2. 5 个 class 速查

| class | 典型场景 | 凭证（receiptProof）默认 | idempotency |
|---|---|---|---|
| `sync_job` | 幂等同步脚本（拉数据、写库）| 查 sqlite 行数 ≥ 1 | `pure` 失败可补跑 |
| `publication` | 发布类（写商品、推 bitable）| 查 sqlite 行数 ≥ 1 | `non` 失败不可重发 |
| `monitoring` | 探针/巡检 | shell exit 0 | `conditional` |
| `delegation` | spawn 给 sibling session 的工作（要看回复内容）| session reply contains `REPORT:` | `non` |
| `notification` | spawn 给 sibling session 的通知（任意回复即算到）| session reply present | `non` |

每类都有默认 `notify`，failure 默认走 `ownerDM`（你自己的 session）。要改请在 `overrides` 里指定。

## 3. 自己重建一条 task（最常见路径）

### 步骤

1. **找回老 task 的关键字段**：`name` / `cron` / `executor` / `config` —— `GET /tasks/<old_id>` 都还在。
2. **决定 class + expectedDurationMs**：参考上表。`expectedDurationMs` 是"正常情况下你期望它在这么久内出 receipt"，比如 sync_job 一般 1 800 000（30 min）；spawn 类按 sibling 实际响应时长写。
3. **DELETE 老 task**：`DELETE /tasks/<old_id>`（保险起见先 `PATCH enabled=false`）。
4. **POST 新 task**：带上 `class` / `expectedDurationMs` / `ownerSession`。

### shell executor 例子

```bash
curl -s -X POST http://localhost:3500/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "amzlisting-even-day-ingest",
    "cron": "0 9 */2 * *",
    "executor": "shell",
    "config": {
      "command": "python3 ingest.py",
      "cwd": "/path/to/amzlisting",
      "timeout": 7200000
    },
    "class": "sync_job",
    "expectedDurationMs": 7200000,
    "ownerSession": "amz-radar"
  }'
```

### http executor (spawn 类) 例子

```bash
curl -s -X POST http://localhost:3500/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "weekly-code-review",
    "cron": "0 10 * * 1",
    "executor": "http",
    "config": {
      "url": "http://localhost:3501/api/spawn",
      "method": "POST",
      "headers": {"Content-Type": "application/json"},
      "body": {"target": "reviewer", "prompt": "请检查本周的代码变更。完成后回复以 REPORT: 开头。"},
      "timeout": 600000
    },
    "class": "delegation",
    "expectedDurationMs": 600000,
    "ownerSession": "your-session-id"
  }'
```

## 4. 自定义 receipt / notify

默认行为不合用就传 `overrides`：

```json
{
  "overrides": {
    "receiptProof": {
      "kind": "external_evidence",
      "engine": "sqlite",
      "target": {"db": "/path/to.db", "sql": "SELECT count(*) FROM x WHERE date(created_at)=date('now')"},
      "expectation": ">= 100"
    },
    "notify": {
      "succeeded": { "channel": "none" },
      "trigger_failed": { "channel": "ownerDM" },
      "receipt_missing": { "channel": "userDM" }
    }
  }
}
```

硬约束（违反会 400）：

- `delegation.receiptProof.kind` 必须是 `session_reply_*`（spawn 类不能用 sqlite 凭证）。
- `monitoring.notify.receipt_missing` 不能是 `ownerDM`（业务告警是脚本自己的责任）。

## 5. 验证

```bash
# 看一眼新 task
curl -s http://localhost:3500/tasks/<new_id> | jq

# 手动触发一次（不用等 cron）
curl -s -X POST http://localhost:3500/tasks/<new_id>/run

# 看运行历史 + verify 状态
curl -s "http://localhost:3500/tasks/<new_id>/runs?limit=5" | jq
```

成功的两轴状态：`trigger_status=success` + `verify_status=success`。verify 还是 `running` 说明在等 receipt（凭证还没到/还没轮到），等到 `expectedDurationMs` 之后 verify 会按 receiptProof 判定。

## 6. 自助原则

- **scheduler 不替你 PATCH `class`**。owner 自己拍。
- **失败时收到的 heal proposal** 仍然走 `ACTION: RETRY/SKIP/DISABLE/ADJUST` 协议，详见 briefing §4。
- **看不懂 class 怎么选** 就先按你的直觉选一个 sync_job / publication 跑，跑出 `receipt_missing` 再回来调 `overrides.receiptProof`。
