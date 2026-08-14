# Spawn 闭环状态机

## 状态机目标

这份文档只定义一次 spawn 的主生命周期。它不展开所有异常原因,也不定义 watcher 的具体处理规则。

分工:

- `02-state-machine.md`:说明一条 spawn 从受理到闭环的主状态。
- `03-watcher-fallback-rules.md`:说明代码层如何识别 `delivery_failed` / `not_completed`,以及 `sk-watcher` 如何处理。

## 设计原则

状态机只回答一个问题:这条 spawn 现在处在闭环生命周期的哪一步?

状态机不回答这些问题:

- 为什么失败?
- 要不要重跑?
- 要不要补投递?
- 要不要触发 `sk-watcher`?

这些都属于 watcher 规则。

## 核心状态

| 状态 | 含义 |
|---|---|
| `accepted` | `/api/spawn2.0` 已受理请求,contract 和 execution backend 已记录 |
| `running` | child 已创建并正在执行,或正在等待 child 终态 |
| `result_ready` | 已有可投递结果,结果已记录或可记录 |
| `delivering` | 正在按 closure target 投递结果 |
| `closed` | 已完成闭环,无需 watcher 继续处理 |
| `needs_followup` | 同步路径无法闭环,代码层会触发 `sk-watcher` |

## 主路径

```text
accepted -> running -> result_ready -> delivering -> closed
```

含义:

1. 框架受理 spawn 并记录 contract。
2. 框架创建 child,child 执行任务。
3. child 产出结果,框架记录结果。
4. 框架按 closure target 投递结果。
5. 投递成功,闭环完成。

## 进入兜底

主路径进入执行后,只有执行层和投递层问题会进入 `needs_followup`:

```text
running ------> needs_followup
result_ready -> needs_followup
delivering ---> needs_followup
```

`accepted` 阶段的 contract 校验失败、target 不存在、child 创建失败等问题,由 `/api/spawn2.0` 同步返回结构化错误,不进入 watcher。

`needs_followup` 不是失败状态,只是表示同步路径没有当场闭环。代码层必须把它归类为 `delivery_failed` 或 `not_completed`,再触发 `sk-watcher`。

## Followup Type

复杂性不放进状态名,而放进 `followup_type` 字段。

只允许两类:

| followup_type | 含义 |
|---|---|
| `delivery_failed` | result evidence 已存在,但 target evidence 不存在 |
| `not_completed` | 没有形成 closure 要求的 result evidence |

具体判断条件见 `03-watcher-fallback-rules.md`。

## 状态转移表

| 当前状态 | 事件 | 下一状态 |
|---|---|---|
| `accepted` | child 创建成功 | `running` |
| `accepted` | child 创建失败 | 同步返回 `spawn_failed`,不进入 watcher |
| `running` | child 仍在运行但同步窗口结束 | `needs_followup(followup_type=not_completed)` |
| `running` | child completed 且有结果 | `result_ready` |
| `running` | child completed 但输出为空 | `needs_followup(followup_type=not_completed)` |
| `running` | child failed/cancelled/timeout 且无结果 | `needs_followup(followup_type=not_completed)` |
| `result_ready` | closure target 可执行 | `delivering` |
| `result_ready` | closure target 执行时不可用 | `needs_followup(followup_type=delivery_failed)` |
| `delivering` | 投递成功 | `closed` |
| `delivering` | 投递失败 | `needs_followup(followup_type=delivery_failed)` |

## Watcher 只被动接收一个状态

`sk-watcher` 只处理:

```text
needs_followup(delivery_failed | not_completed)
```

这能避免 watcher 同时理解过多生命周期状态。代码层负责识别两类 followup,`sk-watcher` 负责后续处理。

## 不变量

1. `closed` 必须有闭环证据:target evidence 成立。
2. `result_ready` 必须能拿到可投递结果或结果指针。
3. `delivering` 必须已有结果,不能在无结果时投递。
4. `needs_followup` 必须有 `followup_type`,且只能是 `delivery_failed` 或 `not_completed`。
5. `followup_type` 不是动作,不能因为 `not_completed` 就直接 redrive。
6. redrive 不作为默认 watcher 动作。
7. 进入 `needs_followup` 后,如果需要等待或补投递,必须有 heartbeat todo 承接续跑。

## 为什么这样简化

旧写法把生命周期状态、异常原因、watcher 动作混在一起,导致状态数量膨胀,也跟 watcher 规则文档重复。

新写法只保留主生命周期:

```text
accepted -> running -> result_ready -> delivering -> closed
```

所有未闭环情况统一进入:

```text
needs_followup(followup_type=delivery_failed|not_completed)
```

这样 `02` 只讲生命周期,`03` 专心定义两类 watcher 事件。
