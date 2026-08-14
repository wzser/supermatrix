# Watcher 兜底规则设计

## Watcher 的定位

Watcher 不是主动扫描所有异常的巡检器,而是一个被动触发的兜底处理 session。

代码层在执行 spawn 闭环时,只要识别到两类问题,就触发 watcher:

1. `delivery_failed`:投递失败。
2. `not_completed`:没有完成。

当前 watcher owner 是 `sk-watcher` session。它只处理这两类 closure event,不处理入口层能同步拦截的问题。

## 不进入 watcher 的问题

这些问题必须在代码层直接处理,不触发 `sk-watcher`:

| 问题 | 处理位置 | 处理方式 |
|---|---|---|
| contract schema 不合法 | `/api/spawn2.0` intake | 直接拒绝,返回结构化错误 |
| `from` 缺失或不存在 | `/api/spawn2.0` intake | 直接拒绝 |
| `target` 缺失或不存在 | `/api/spawn2.0` intake | 直接拒绝 |
| `execution.backend` 不存在或不允许 | `/api/spawn2.0` intake | 直接拒绝 |
| `closure.kind` 非法 | `/api/spawn2.0` intake | 直接拒绝 |
| `closure.target.type` 非法 | `/api/spawn2.0` intake | 直接拒绝 |
| closure target 格式明显非法 | `/api/spawn2.0` intake | 直接拒绝 |
| child 没有创建成功 | `/api/spawn2.0` execution | 同步返回 `spawn_failed` |
| 同 `client_request_id` 已有成功结果 | `/api/spawn2.0` intake 或 result lookup | 直接返回/引用已有结果 |

原则:代码层能确定的,不要交给 watcher。watcher 只处理已经进入执行/投递流程后的闭环缺口。

## 两类 watcher 事件

### 1. `delivery_failed`

定义:result evidence 已存在,但框架没有让 target evidence 成立。

必须同时满足:

- `spawn_results` 已有可用结果,或 message_run/artifact 中可确定已有结果。
- contract 中声明了 `closure.target`。
- `closure.target` 没有成功投递证据。

常见触发条件:

| 条件 | 说明 |
|---|---|
| `delivery_attempts.status='failed'` | 投递动作执行过,但失败 |
| `delivery_attempts.status='timeout'` | 投递动作超时 |
| `delivery_attempts.status='permission_denied'` | 目标无权限 |
| `delivery_attempts.status='target_missing'` | 投递目标在执行后不存在 |
| closure target 无 successful attempt | 应投递但没有成功记录 |
| `inline_response` 窗口关闭 | 结果迟到,原 HTTP 响应无法再承载结果 |
| `todo_pool` 写入失败 | 声明投递到待办池,但待办项没有创建成功 |

不属于 `delivery_failed`:

- 没有结果。
- child 仍在运行。
- `closure.kind` 要求的 result evidence 本身不存在。
- contract 在 intake 时就非法。

`delivery_failed` 的 watcher 目标:

1. 读取结果。
2. 判断投递目标是否仍有效。
3. 能补投递就补投递。
4. 目标失效或权限坏就 park 并要求修 closure contract。

### 2. `not_completed`

定义:这次 spawn 没有形成 `closure.kind` 要求的 result evidence。

满足任一条件:

| 条件 | 说明 |
|---|---|
| child 仍 running/pending | 同步窗口结束,但 child 还没有终态 |
| run terminal failed | failed/cancelled/timeout,且没有可用结果 |
| output empty | `closure.kind=message`,但 final_message 为空 |
| artifact missing | `closure.kind=artifact`,但文件/附件/产物不存在 |
| record payload missing | `closure.kind=record`,但 record mutation payload 不存在 |
| verification missing | `closure.check=verification_result`,但没有 pass/fail/unknown 结论 |

不属于 `not_completed`:

- 结果已存在但没送到。这是 `delivery_failed`。
- closure target 坏但 result evidence 存在。这还是 `delivery_failed`。
- contract schema 非法。这应在 intake 拒绝。

`not_completed` 的 watcher 目标:

1. 判断是否只是仍在运行。
2. 如果仍在运行,写 heartbeat todo 做下次检查。
3. 如果已终态但没有结果,形成 incident。
4. 默认不重跑业务任务。

## 触发方式

Watcher 被代码层触发,不是自己主动扫全表。

推荐事件结构:

```json
{
  "event_type": "delivery_failed",
  "comm_id": "comm_xxx",
  "from": "autobitable",
  "target": "pakage-done",
  "detected_by": "delivery_executor",
  "reason": "inline_response_window_closed",
  "snapshot_ref": "closure_snapshot_xxx"
}
```

或:

```json
{
  "event_type": "not_completed",
  "comm_id": "comm_xxx",
  "from": "scheduler",
  "target": "email-admin",
  "detected_by": "execution_checker",
  "reason": "child_still_running",
  "snapshot_ref": "closure_snapshot_xxx"
}
```

代码层负责:

- 识别事件类型。
- 写 closure event。
- 去重同一 `comm_id + event_type`。
- 触发 `sk-watcher`。

`sk-watcher` 负责:

- 根据 `comm_id` 和 snapshot 读取证据。
- 执行对应 SOP。
- 写回处理结果。

## `delivery_failed` 处理 SOP

输入:

- `comm_id`
- `spawn_contract`
- `spawn_results`
- `delivery_attempts`
- closure target 当前状态
- heartbeat todo 当前状态

步骤:

1. 确认结果存在。
2. 列出 failed/missing 的 closure target。
3. 检查 target 是否仍有效。
4. 如果 target 有效且错误可重试:执行 redeliver。
5. 如果 target 无效或无权限:park closure contract。
6. 写回 closure event 结果。

动作:

| 判断 | 动作 |
|---|---|
| target 有效,错误可重试 | `redeliver` |
| target 有效,但需要稍后重试 | `write_heartbeat_todo(redeliver)` |
| target 有效,但重复失败超过预算 | `incident` |
| target 不存在 | `park_contract` |
| target 无权限 | `park_contract` |
| 结果引用丢失 | 转 `not_completed` 或 `incident` |

## `not_completed` 处理 SOP

输入:

- `comm_id`
- `spawn_contract`
- `message_runs`
- artifact/record 检查结果
- heartbeat todo 当前状态

步骤:

1. 确认 contract 要求的 closure。
2. 检查 child/run 当前状态。
3. 如果仍在 running:写 heartbeat todo,不要重跑。
4. 如果 terminal failed 且无结果:形成 incident。
5. 如果 completed 但 output 不满足 closure:形成 incident。
6. 写回 closure event 结果。

动作:

| 判断 | 动作 |
|---|---|
| child 仍 running | `write_heartbeat_todo(check_completion)` |
| run terminal failed,无结果 | `incident` |
| output empty,但 closure 需要结果 | `incident` |
| artifact/record 不存在 | `incident` |
| 后续检查发现结果已出现 | 转 `delivery_failed` 或直接投递 |

## 关于重跑

watcher 默认不重跑任务。

重跑是业务动作,风险很高。是否支持某类 redrive,必须另写专门规则和安全证明,不能作为 `delivery_failed` 或 `not_completed` 的默认动作。

## 关于 LLM

`sk-watcher` 可以是 Kimi backend,但它不应该逐条自由判断所有日志。

它只接收两类已经由代码层识别出的事件:

- `delivery_failed`
- `not_completed`

对于同型事件,代码层应先去重和聚合,避免一条失败唤醒一次 LLM。

## 风暴防线

- 代码层只触发两类事件。
- 同一 `comm_id + event_type` 去重。
- 同一 signature 聚合。
- 等待和补投递交给 heartbeat todo pool,不让 watcher 自己循环。
- `delivery_failed` 和 `not_completed` 分开限流。
- `sk-watcher` 每轮处理数量有上限。
- 处理结果必须写回,否则不再重复触发。
