# Closure 契约定义

## 为什么合并 Outcome 和 Delivery

旧设计把 `outcome.kind` 和 `delivery.sink` 分成两套枚举,看起来清楚,但实际不够 MECE(互斥且穷尽):

- `notification` 更像投递动作,不该同时也是 outcome。
- `record` 既可能是结果形态,也可能是投递目标。
- `artifact` 既可能是 B 产出的文件,也可能是框架写到某个路径的交付物。
- 多个 outcome 再乘以多个 delivery sink,会产生很多组合,watcher 又要猜哪个才是本次通讯真正要闭环的东西。

V2 改为一个 `closure` 对象。

一句话:一次通讯只声明一个主闭环。

## Backend 不属于 closure

`backend` 是执行路由,不能去掉。

它应该进入 `execution.backend`,由 `/api/spawn2.0` 在创建 child session 前使用:

```json
{
  "execution": {
    "backend": "kimi"
  }
}
```

规则:

- `execution.backend` 只决定 target session 使用哪个模型或执行后端。
- `execution.backend` 不参与 watcher 判断闭环。
- 不填时使用 target session 的默认 backend。
- 填了以后必须由 `/api/spawn2.0` 校验 backend 是否存在、target 是否允许使用。

## `from` 的定义

`from` 表示发起方和责任归属方:

- 谁发起了这次跨 session 通讯。
- 谁拥有这次请求的审计责任。
- 谁承担 `client_request_id` 的去重语义。

`from` 不表示结果接收方。结果接收方由 `closure.target` 定义。

## Contract 形态

推荐请求结构:

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

`closure` 同时回答三个问题:

1. 这次通讯要形成什么闭环。
2. 闭环结果交付到哪里。
3. watcher 应该用什么证据判断完成。

## `closure.kind`

`closure.kind` 是固定枚举。它定义"这次通讯怎样才算有结果"。

| kind | 定义 | result evidence |
|---|---|---|
| `message` | 形成一段可读消息,并送到目标位置 | message payload 非空 |
| `artifact` | 形成文件、文档、图片、压缩包、报告等产物 | artifact 路径、附件或对象指针存在 |
| `record` | 形成一次结构化记录创建或更新 | record mutation payload 存在 |

`record` 不是专指飞书多维表格。飞书多维表格是 `closure.target.type=bitable`。如果未来还有 SQLite/Postgres、配置表、内部状态表,也属于 `record` 的 target 类型。

不再单独设置 `answer`、`verification`、`notification`:

- 普通回答是 `message` + `check=non_empty`。
- 验收检查是 `message` + `check=verification_result`。
- 通知发送是 `message` + `target.type=feishu/session`,通常 `check=sent`。

## 禁止 no_reply

V2 不允许 `no_reply`。

原因:

- no_reply 会让"完成"只依赖进程状态,而不是业务结果。
- 跨 session 通讯的原则是 one communication = one outcome。
- 即使调用方不需要自然语言回答,也应该有一个可检查的闭环证据。

替代方式:

- 只是通知:用 `message` + `check=sent`。
- 要写入表或状态:用 `record`。
- 要异步交给后续系统处理:用 `closure.target.type=todo_pool`。

## `closure.target`

`closure.target` 定义主闭环交付位置。不同 `closure.kind` 允许不同 target type。

| closure.kind | target.type | 必填字段 | target evidence |
|---|---|---|---|
| `message` | `inline` | 无 | HTTP handler 已返回 payload |
| `message` | `session` | `session` | session inbox 行存在且状态 delivered |
| `message` | `feishu` | `chat_id` 或 `binding_session` | lark message_id 存在 |
| `message` | `todo_pool` | `pool`,`topic` | todo item 存在且包含 message payload/ref |
| `artifact` | `file_path` | `path` | 文件存在且 mtime/size 符合 |
| `artifact` | `feishu_file` | `chat_id` 或 `binding_session` | 文件消息 message_id 存在 |
| `artifact` | `todo_pool` | `pool`,`topic` | todo item 存在且包含 artifact ref |
| `record` | `bitable` | `base_id`,`table_id`,`record_id` 或查询键 | record 存在或字段更新时间符合 |
| `record` | `database` | `db_path`/`dsn`,`table`,`key` | row 存在或字段符合 |
| `record` | `todo_pool` | `pool`,`topic` | todo item 存在且包含 record mutation/ref |

`todo_pool` 可以作为声明的投递目标。此时这次 spawn 的主闭环是"把结果放进待办池",target evidence 是待办项存在。

这和 watcher 用待办池做异步续跑不是一回事。后者见 `05-heartbeat-todo-pool.md`。

## `closure.check`

`closure.check` 是可选的内容检查,不是第二套 outcome。

它只帮助 watcher 判断 `message` 是否满足最低内容要求。

| check | 定义 |
|---|---|
| `non_empty` | 默认值,消息非空即可 |
| `verification_result` | 消息必须包含 pass/fail/unknown 或等价验收结论 |
| `sent` | 不检查语义内容,只要求 target evidence 成立 |

对于 `artifact` 和 `record`,通常不需要 `closure.check`,因为它们的完成证据由 result evidence 和 target evidence 决定。

## 是否允许多个闭环

V2 默认不允许一个 spawn 声明多个 required closure。

原因是系统原则是"one communication = one outcome"。如果一个请求里同时要求"写表、发群、回另一个 session、生成文件",watcher 很难判断哪个失败代表这次通讯失败,也很容易引发重复补救。

处理方式:

- 如果多个结果都必须成功,拆成多次 spawn。
- 如果只是顺手通知或抄送,后续可以设计 non-blocking mirror,但它不参与主闭环判断。
- V2 的 watcher 只看一个主 closure。

## 不支持自然语言 closure

不允许:

```json
{
  "closure": "send it to whoever needs it"
}
```

也不允许:

```json
{
  "closure": {
    "kind": "whatever",
    "target": "the right person"
  }
}
```

自然语言只能放在 `prompt` 或 `notes` 里。`closure.kind` 和 `closure.target.type` 必须是固定枚举。

## Watcher 如何使用 closure

watcher 只判断两件事:

| 状态 | 判断 |
|---|---|
| `not_completed` | result evidence 不存在 |
| `delivery_failed` | result evidence 存在,但 target evidence 不存在 |

例子:

- `message` 已生成,但 session inbox 没有 delivered 记录:`delivery_failed`。
- `message` 没生成,child 已终态:`not_completed`。
- `artifact` 文件产物不存在:`not_completed`。
- `artifact` 已存在,但写入目标 path 失败:`delivery_failed`。
- `record` mutation payload 已有,但 Bitable 更新失败:`delivery_failed`。
- `record` mutation payload 都没有:`not_completed`。
- `todo_pool` 被声明为 target,但待办项没创建成功:`delivery_failed`。

## 重跑不属于调用方契约

调用方不声明重跑策略。

是否 redrive(重新执行)不由调用方声明,也不是 watcher 默认动作:

- result evidence 已存在但 target evidence 不存在:只 redeliver(补投递),不 redrive。
- child 仍 running:只 wait(等待),不 redrive。
- closure contract 坏:park(搁置),不 redrive。
- child 没创建成功:由 `/api/spawn2.0` 同步层直接返回,不进入 watcher。
- child 终态失败且无副作用证据:只有另行设计过专门 redrive 规则时才可能重跑。
- 幂等性无法证明:不 redrive,进入 incident(事件记录)。
