# Heartbeat 待办池设计

## 定位

Heartbeat todo pool 是异步续跑的耐久层。

它不是 watcher,也不是另一个 LLM。它只保存"之后还要检查或补投递"的待办项,并由 heartbeat 低频唤醒。

Watcher 负责判断和决策。Heartbeat todo pool 负责把这些决策变成可续跑、可去重、可限流的执行队列。

## 两种使用方式

### 1. 声明式投递目标

调用方可以一开始就声明:

```json
{
  "closure": {
    "kind": "message",
    "target": {
      "type": "todo_pool",
      "pool": "cross_session_delivery",
      "topic": "purchase-inbound-webhook-check"
    }
  }
}
```

此时这次 spawn 的主闭环是"把结果投递到待办池"。

只要 todo item 创建成功,这次 spawn 就可以 closed。后续谁消费这个待办,属于待办池自己的业务流程。

### 2. 框架内部异步续跑

当原始 closure 还没有闭环时,代码层或 `sk-watcher` 可以写入 heartbeat todo:

- child 还在 running,需要稍后检查。
- result evidence 已存在,但 target evidence 暂时失败,需要稍后补投递。
- target 暂时不可用,需要按 backoff 再试。

此时 todo item 不是原始 spawn 的最终结果,只是原始 spawn 的续跑记录。原始 spawn 仍处于 `needs_followup`,直到最终 target evidence 成立或进入 incident。

## Todo 类型

| todo_kind | 来源 | 含义 |
|---|---|---|
| `declared_delivery` | 调用方声明 `closure.target.type=todo_pool` | 待办项本身就是主闭环目标 |
| `framework_followup` | 代码层或 watcher 写入 | 为未闭环 spawn 做后续检查或补投递 |

## Action 类型

| action | 何时创建 | heartbeat 做什么 |
|---|---|---|
| `check_completion` | child running 且同步窗口结束 | 读取 run 状态,有结果就进入投递,终态无结果就触发 `not_completed` |
| `redeliver` | result evidence 已有但 target evidence 未成立 | 重试投递,成功则 closed,失败则按 backoff 保留 |
| `verify_target` | 投递后需要确认目标证据 | 检查文件、表记录、inbox、message_id 等 target evidence |
| `parked_review` | target 不存在、无权限、contract 坏 | 不自动重试,等待人工或配置修复 |

## 字段建议

| 字段 | 含义 |
|---|---|
| `todo_id` | 待办唯一 ID |
| `todo_kind` | `declared_delivery` 或 `framework_followup` |
| `comm_id` | 对应 spawn 通讯 |
| `event_type` | `delivery_failed` / `not_completed` / 空 |
| `action` | `check_completion` / `redeliver` / `verify_target` / `parked_review` |
| `closure_kind` | 原始 closure kind |
| `target_type` | 原始 target type |
| `result_ref` | result evidence 指针 |
| `snapshot_ref` | 创建待办时的现场快照 |
| `status` | `pending` / `leased` / `done` / `parked` / `failed` |
| `next_run_at` | 下次检查时间 |
| `attempt_count` | 已尝试次数 |
| `last_error` | 最近一次错误 |

## 生命周期

```text
pending -> leased -> done
pending -> leased -> pending
pending -> leased -> parked
pending -> leased -> failed
```

规则:

- `pending`:等待 heartbeat 到期捞取。
- `leased`:某个 worker 正在处理,避免并发重复执行。
- `done`:target evidence 已成立,或者 declared delivery 已创建成功。
- `parked`:目标坏、权限坏、contract 坏,不能自动恢复。
- `failed`:超过预算仍失败,需要 incident。

## 与 watcher 的关系

代码层先判断事件类型:

- `delivery_failed`
- `not_completed`

然后才触发 `sk-watcher`。

`sk-watcher` 处理后,如果需要等待或稍后补投递,写 heartbeat todo,不要自己循环等待。

Heartbeat 到期后先做确定性检查:

1. 查 run 状态。
2. 查 result evidence。
3. 查 target evidence。
4. 能直接投递就投递。
5. 仍然需要判断时,再触发 `sk-watcher`。

## 风暴防线

- 同一 `comm_id + action + target_type` 只能有一个 active todo。
- heartbeat 低频扫描,不逐条唤醒 LLM。
- 每个 todo 有 lease,避免多个 worker 同时处理。
- 每个 action 有 retry budget 和 backoff。
- `parked` 状态不会自动重试。
- watcher 只处理代码层确认后的事件,不扫全量日志。
