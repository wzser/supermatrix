# Spawn Closure V2 总览

## 这组文档解决什么

旧的 spawn closure 设计把调用方保护得太彻底:调用方不用说明结果契约,后面的 watcher 只能根据超时、空输出、迟到结果、投递缺失等粗信号补猜。这会把兜底机制推成主执行路径,最终形成 token 风暴和重复业务动作。

V2 的目标是把责任边界重新切清:

- 调用方只声明最小闭环契约:谁发起、要形成哪类闭环、闭环结果送到哪里。
- 调用方可以声明 `execution.backend`,保留指定 backend 的能力。
- 框架负责执行、记录结果、投递结果、异步追踪。
- watcher 只被动处理两类闭环缺口:`delivery_failed` 和 `not_completed`。
- `sk-watcher` 是 watcher owner,负责处理代码层触发的 closure event。
- Heartbeat todo pool 负责低频续跑等待和补投递。

## 文档拆分

| 文档 | 说明 |
|---|---|
| `00-overview.md` | 总览、目标、边界、角色分工 |
| `01-communication-execution-delivery-flow.md` | 通讯、执行、投递三段流程 |
| `02-state-machine.md` | spawn 闭环状态机与关键不变量 |
| `03-watcher-fallback-rules.md` | watcher 兜底问题清单、判断条件、读取信息和动作 |
| `04-closure-contract.md` | `closure.kind` 与 `closure.target` 的固定枚举定义 |
| `05-heartbeat-todo-pool.md` | heartbeat 待办池、异步续跑、补投递队列 |

## 核心原则

### 1. 调用方不判断长短任务

调用方不需要也不应该声明"是不是长任务"。这个判断很难准,而且一旦判断错,会把框架带偏。

框架只看事实状态:

- child 还在 running:继续等。
- child completed 且有结果:记录结果并投递。
- child terminal failed 且无结果:进入 incident;只有另行设计过专门规则时才考虑 redrive。
- 投递目标坏:修 closure contract,不要重跑任务。

### 2. 调用方必须声明最小闭环契约

调用方不用懂 watcher、redrive、内部 heartbeat 续跑,但必须说清楚"本次通讯要形成什么闭环,以及闭环结果送到哪里"。

最小契约包括:

- `from`:发起方和责任归属方。它表示谁发起这次通讯、谁为这次请求负责,不等于结果接收方。
- `target`:交给哪个 session 执行。
- `execution.backend`:可选,指定 target session 使用的执行后端。
- `closure.kind`:闭环形态,必须使用固定枚举,定义见 `04-closure-contract.md`。
- `closure.target`:具体接收位置,可以是某个 session、飞书群、文件路径、表记录、数据库定位或待办池。它可以不同于 `from`。
- `client_request_id`:同一业务任务的稳定逻辑键,用于去重。

调用方不声明多个主结果,也不声明重跑策略。重新执行是否安全由专门规则判断;无法证明安全时不重跑。

### 3. Result evidence 和 target evidence 必须拆开

`closure` 合并的是调用方声明,不是底层证据。result evidence 存在,不代表 target evidence 成立。target evidence 不成立,也不代表任务要重跑。

框架必须分别记录:

- B 是否产出 result evidence。
- result evidence 是什么、在哪里。
- target evidence 是否成立。
- 如果 target evidence 不成立,是投递问题还是结果问题。

### 4. Watcher 是被动兜底处理器

代码层先识别问题,只有两类问题会触发 watcher:

- `delivery_failed`:result evidence 已存在,但 target evidence 不存在。
- `not_completed`:没有形成 `closure.kind` 要求的 result evidence。

watcher 不做这些事:

- 不判断回答内容好不好。
- 不把自然语言控制消息注入给业务 session。
- 不主动扫描全量日志。
- 不在幂等性不明确时重跑真实业务任务。

## 角色分工

| 角色 | 责任 |
|---|---|
| 调用方 A | 提供最小闭环契约,消费结果 |
| `/api/spawn2.0` | 受理契约、创建 comm、启动 child、记录初始状态 |
| child session B | 执行任务并产出结果 |
| result store | 存储结果 payload 或 artifact 指针 |
| delivery executor | 按契约执行投递,记录投递尝试 |
| heartbeat todo pool | 保存后续检查、补投递、parked review 等异步待办 |
| code detector | 在执行/投递层识别 `delivery_failed` / `not_completed` |
| sk-watcher | 被动接收 closure event,处理投递失败和未完成 |

## 最小数据模型

建议至少有五类记录:

| 记录 | 作用 |
|---|---|
| `spawn_contract` | A 声明的 execution、closure、target、去重键 |
| `spawn_results` | B 产出的结果内容或 artifact 指针 |
| `delivery_attempts` | 每次投递动作、目标、状态、错误 |
| `closure_events` | 代码层触发给 sk-watcher 的 `delivery_failed` / `not_completed` 事件 |
| `heartbeat_todos` | 异步续跑、补投递、检查 target evidence 的待办 |

## 成功标准

V2 成功不是"watcher 能处理更多异常",而是:

1. 正常 spawn 不触发 sk-watcher。
2. 超时但仍在 running 的任务不被当失败。
3. 已有结果但投递失败时只补投递,不重跑任务。
4. 每次触发 sk-watcher 都必须明确属于 `delivery_failed` 或 `not_completed`。
5. 同一 `comm_id + event_type` 不重复触发。
