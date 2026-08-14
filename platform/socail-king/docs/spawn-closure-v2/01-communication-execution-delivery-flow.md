# 通讯、执行、投递流程

## 三段定义

一次跨 session spawn 被拆成三段:

| 阶段 | 问题 | 客观证据 |
|---|---|---|
| 通讯 | A 的请求有没有到 B | comm 记录存在、child session 创建成功 |
| 执行 | B 有没有完成任务并产出结果 | message_run 状态、final_message、artifact、错误信息 |
| 投递 | A 有没有拿到声明的结果 | delivery_attempts、caller inbox、文件/表/飞书写入记录 |

三段必须按顺序判断。通讯没成,不能讨论执行。执行没产出,不能讨论投递。投递失败,不能倒推 B 没执行。

## 调用方提交的最小请求

示例:

```json
{
  "from": "autobitable",
  "target": "pakage-done",
  "execution": {
    "backend": "kimi"
  },
  "prompt": "请确认采购入库 webhook 接入记录并返回验收状态",
  "closure": {
    "kind": "message",
    "target": {
      "type": "session",
      "session": "wuliu2"
    },
    "check": "verification_result"
  },
  "client_request_id": "autobitable:pakage-done:purchase-inbound-webhook-check:2026-05-26"
}
```

`from` 是发起方和责任归属方,不等于结果接收方。上例中发起方是 `autobitable`,但结果要投递给 `wuliu2`。

调用方不声明"是不是长任务",也不声明重跑策略。框架只根据真实 run 状态推进;重跑不是默认路径,必须另有专门安全规则。

## 同步路径

1. `/api/spawn2.0` 接收请求并校验 contract。
2. 写入 `cross_session_log` 和 `spawn_contract`。
3. 根据 `execution.backend` 创建 child session。
4. child 完成或同步等待窗口结束。
5. 如果 child 完成:
   - 有结果:写 `spawn_results`。
   - 无结果:进入 `not_completed`。
6. 按 `closure.target` 执行投递。
7. 投递成功:返回调用方并关闭。
8. 投递失败或同步窗口结束:代码层识别为 `delivery_failed` 或 `not_completed`,写 closure event,必要时写 heartbeat todo,并触发 `sk-watcher`。

## 异步路径

异步不是调用方选择的 mode,而是同步路径无法当场闭环后的追踪状态。

进入异步的典型原因:

- child 仍在 running,同步窗口结束。
- child 已完成,但投递失败。
- child terminal failed,且没有可用结果。
- closure contract 指向的目标不存在。

异步路径不代表失败。它只表示"这条 spawn 还没有完成闭环"。

## 结果写入

当 B 有结果时,先写 `spawn_results`,再做投递。

字段建议:

- `comm_id`
- `closure_kind`
- `payload_text`
- `payload_ref`
- `produced_by_child_session`
- `produced_at`

如果结果很长,`payload_text` 可以只存摘要或指针,完整结果落文件或对象存储。

## Closure 投递执行

投递由框架执行,不是由 watcher 发送自然语言让 B 理解。

常见 closure:

| closure.kind | target.type | 含义 |
|---|---|
| `message` | `inline` | 同步 HTTP 响应 |
| `message` | `session` | 指定 session 的结果收件箱 |
| `message` | `feishu` | 飞书消息 |
| `message` | `todo_pool` | 待办池消息 |
| `artifact` | `file_path` | 指定文件路径 |
| `artifact` | `feishu_file` | 飞书文件消息 |
| `artifact` | `todo_pool` | 待办池文件指针 |
| `record` | `bitable` | 多维表格记录 |
| `record` | `database` | SQLite/Postgres 等数据库记录 |
| `record` | `todo_pool` | 待办池结构化记录 |

每次投递都写 `delivery_attempts`:

- `comm_id`
- `closure_kind`
- `target_type`
- `target_ref`
- `status`
- `error`
- `attempted_at`

## 关键不变量

1. 结果存在和投递成功是两件事。
2. 投递失败不触发任务重跑。
3. child still running 不触发任务重跑。
4. redrive 不是默认动作;如后续引入,必须通过幂等安全检查。
5. contract 坏时 park contract,不要重跑业务任务。
6. 无结果不允许按 no_reply close。
7. 所有状态推进都必须能从 comm_id 串回完整证据。
8. 需要稍后检查或补投递时,写 heartbeat todo,不要让 watcher 循环等待。
