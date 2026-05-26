# Bitable Webhook 接入规范

本文定义业务 session 接入 Bitable webhook 的合同。目标是让多维表格变更可以触发 SuperMatrix 能力，同时保留 owner、台账、幂等、运行证明和失败监管。

## 边界

`autobitable` 只负责接入层：

- 接收公网服务器转发来的 Bitable 自动化 POST。
- 验签、限流、幂等、解析 payload。
- 按台账路由到 `script` 或 `prompt`。
- 记录 webhook 配置和每次运行结果。

`autobitable` 不负责业务判断：

- 不决定具体业务对象是否需要处理。
- 不改业务 session 的源数据口径。
- 不替业务 session 写未确认的脚本。
- 不把 Feishu 消息伪装成用户输入发给业务 session。

## 最小 POST 请求体

平台标准请求体只保留路由和定位必需字段。业务字段不是标准字段，只有某个 webhook 明确需要时才加。

必填：

```json
{
  "webhook_id": "wh_owner_purpose",
  "table_id": "tbl_example",
  "view_id": "vew_example",
  "record_id": "rec_example"
}
```

按需可选：

```json
{
  "triggered_at": "2026-05-08T15:50:34+08:00",
  "fields": {
    "业务字段名": "业务字段值"
  }
}
```

规则：

- 请求体不带 `source`；当前能力只接 Feishu Bitable。
- 请求体不带 `command.type`、`script_name`、`prompt`；执行内容只从台账读取。
- 请求体不默认带 `ASIN`、`触发动作` 或其它业务字段。
- `fields` 为空或缺省时，adapter 按 `{}` 处理。
- `fields` 如果存在，只允许出现台账 `bitable.field_allowlist` 里声明的字段。
- `triggered_at` 用于区分同一记录的多次真实点击；如果 Feishu 无法稳定提供，可由 adapter 使用 `received_at` 生成运行时间，但幂等能力会弱一些。

## 执行类型

## Webhook Class

`class` 是 adapter 如何监管这个 webhook；`category` 是业务展示维度。两者正交。

| class | 适用场景 | 默认 receipt proof | 默认通知 |
|---|---|---|---|
| `script_job` | 确定性脚本，通常会写业务结果 | 必须显式声明，不能省略 | `trigger_failed` / `receipt_missing` 通知 owner |
| `prompt_delegation` | spawn 子 session 处理 prompt | `session_reply_present`，需要更严格证明时改为内容检查 | `trigger_failed` / `receipt_missing` 通知 owner |
| `monitoring` | 只检查状态，不直接改变业务数据 | `exit_zero` 或结构化输出检查 | `trigger_failed` 通知 owner，`receipt_missing` 默认不通知 |
| `notification` | 发送通知或轻量回写 | `exit_zero` / `session_reply_present` | 失败通知 owner |

除 `monitoring` 这种轻量探针外，`receipt_proof` 应由每个 webhook 显式填写。不要提供一个“看似有默认、实际一定失败”的 proof。

### `script`

用于不需要模型能力的确定性动作。收到请求后必须立即 ACK，再运行白名单脚本。

硬约束：

- `script_name` 必须存在于 `registry/bitable-webhooks.json` 的白名单。
- 脚本命令必须是 argv 数组或固定入口，不允许由请求体传入任意 shell 字符串。
- argv 允许使用 `{{record_id}}` / `<record_id>` 等定位字段模板；模板只替换已校验 payload 的定位字段。
- 跨 workspace 脚本可以声明 `command.cwd`，adapter 会在该工作目录下执行脚本。
- 参数必须通过 `params_schema` 校验。
- 脚本必须有超时。
- 脚本必须定义 receipt proof：不能只用 HTTP 202 当成业务成功。
- 非幂等脚本必须有明确的 `idempotency.key_template` 和重复触发策略。
- adapter 执行脚本时会继承当前环境并补全 `PATH`：`/usr/local/bin`、`/opt/homebrew/bin`、`$SM_REPO_ROOT/node_modules/.bin`（设置 `SM_REPO_ROOT` 时）、`/usr/bin`、`/bin`、`/usr/sbin`、`/sbin`。脚本和 registry 仍不应依赖交互式 shell profile；跨 repo 入口优先写可配置路径，脚本内调用 `lark-cli` / `node` / `python3` 只依赖 adapter 提供的进程 env。

推荐脚本输出 JSON：

```json
{
  "ok": true,
  "summary": "已生成补货建议 3 条",
  "artifacts": [
    {"kind": "file", "path": "/absolute/path/to/report.md"}
  ],
  "evidence": {
    "rows_written": 3,
    "shipment_plan_id": "sp_example_001"
  }
}
```

### `prompt`

用于需要业务 session 生成判断、总结、编辑或跨工具编排的动作。收到请求后必须立即 ACK，再调用 SuperMatrix：

```bash
curl -s -X POST http://127.0.0.1:3501/api/spawn \
  -H 'Content-Type: application/json' \
  -d '{
    "target": "<target_session>",
    "from": "autobitable",
    "mode": "async_kickoff",
    "prompt": "<rendered_prompt>"
  }'
```

硬约束：

- `target_session` 必须是台账里的 owner-approved session。
- prompt 模板只能引用定位字段和 `field_allowlist` 里的业务字段。
- payload 中来自表格的文本必须作为数据块包进 prompt，不能当系统指令。
- 长任务必须使用 `async_kickoff`，不能同步等模型跑完再回复 Bitable。
- 如果业务要求证明完成，receipt proof 必须是 `session_reply_present` 或 `session_reply_content_check`。

## 注册字段

每个 webhook 必须登记到 `registry/bitable-webhooks.json`。字段含义如下：

正式运营台账需要同步到 Feishu 节点，形态对齐 scheduler 的任务台账：本地 JSON 是 adapter 的执行配置来源，Feishu 台账是跨 session 可见的治理视图。新增、暂停、恢复、废弃 webhook 时，两边都必须更新。

| 字段 | 必填 | 说明 |
|---|---:|---|
| `webhook_id` | 是 | 稳定 ID，格式 `wh_<owner>_<purpose>`，禁止复用 |
| `display_name` | 是 | 中文名称，给人读 |
| `description` | 是 | 1-2 句中文，说明做什么、目的、关键约束 |
| `status` | 是 | `draft` / `active` / `paused` / `deprecated` |
| `class` | 是 | `script_job` / `prompt_delegation` / `monitoring` / `notification` |
| `owner_session` | 是 | 业务 owner session |
| `created_by` | 是 | 创建来源，用于追责和迁移回溯 |
| `category` | 是 | `数据采集` / `数据加工` / `报告产出` / `业务巡检` / `跨会话委派` / `平台运维` / `一次性补跑` / `已废弃` |
| `bitable.base_token_alias` | 是 | base token 的别名，不写真实 token |
| `bitable.table_id` | 是 | table id |
| `bitable.view_id` | 是 | view id；按钮触发必须能定位所在视图 |
| `bitable.table_name` | 是 | 人类可读表名 |
| `bitable.trigger` | 是 | `record_created` / `record_updated` / `field_updated` / `manual_button` |
| `bitable.field_allowlist` | 是 | webhook payload 允许读取的业务字段名；不需要业务字段时填 `[]` |
| `command.type` | 是 | `script` 或 `prompt` |
| `command.target_session` | 是 | 实际执行的业务 session |
| `command.script_name` | script 必填 | 白名单脚本名 |
| `command.argv` | script 必填 | 固定 argv 数组，由台账声明，禁止请求体覆盖 |
| `command.cwd` | 否 | script 执行工作目录；跨 workspace 脚本推荐显式声明 |
| `command.prompt_template` | prompt 必填 | prompt 模板或模板文件路径 |
| `security.header` | 是 | 默认 `X-SM-Webhook-Secret` |
| `security.secret` | 是 | 每个 webhook 独立 secret；用于校验 Feishu HTTP 请求 |
| `params_schema` | 是 | JSON Schema 子集，约束入参 |
| `idempotency.key_template` | 是 | 幂等键模板 |
| `idempotency.on_duplicate` | 是 | `skip` / `return_existing` / `reject` |
| `execution.expected_duration_ms` | 是 | 预期最长执行时间 |
| `execution.timeout_ms` | 是 | adapter 侧超时 |
| `execution.ack_mode` | 否 | `immediate` 表示先 202 ACK 再后台跑脚本；长于 Feishu HTTP 等待窗口的脚本应启用 |
| `execution.concurrency.scope` | 是 | `idempotency_key` / `record_id` / `webhook` |
| `execution.concurrency.on_conflict` | 是 | `skip_if_running` / `queue` / `reject` |
| `receipt_proof` | 是 | 业务完成证明 |
| `notify` | 是 | 失败/缺证明通知规则 |
| `writeback` | 是 | 是否回写 Bitable 状态字段 |
| `approved_by` | 是 | 确认接入的 session 或人 |
| `created_at` / `updated_at` | 是 | ISO8601 时间 |

### Feishu 台账同步

同步方式参照 scheduler：以本地 registry 生成字段，先按稳定 ID 查找现有记录，找到则更新，找不到则新建。Feishu 台账不反向覆盖本地 registry。

Feishu 台账一行一个 webhook，字段建议如下：

| Feishu 字段 | 来源 |
|---|---|
| `Webhook ID` | `webhook_id` |
| `名称` | `display_name` |
| `状态` | `status` |
| `Webhook class` | `class` |
| `业务分类` | `category` |
| `Owner session` | `owner_session` |
| `Target session` | `command.target_session` |
| `Base token alias` | `bitable.base_token_alias` |
| `Table ID` | `bitable.table_id` |
| `View ID` | `bitable.view_id` |
| `Record ID 来源` | 固定为 `request_body.record_id`，除非另行登记 |
| `触发器` | `bitable.trigger` |
| `字段白名单` | `bitable.field_allowlist` |
| `Workflow ID` | Feishu 自动化/工作流 ID |
| `Command type` | `command.type` |
| `Script name` | `command.script_name` |
| `Prompt 摘要` | `command.prompt_template` 的简短摘要或模板文件路径 |
| `Secret header` | `security.header`；如果 Feishu 现有字段仍叫 `Secret alias`，只写 header 名，不写 secret |
| `POST 请求配置` | Feishu HTTP 动作的 URL、Headers、Params、Body 模板；包含该 webhook 的真实 secret |
| `Feishu AI 配置 Prompt` | 可复制给飞书 AI 的工作流配置说明；包含触发条件、HTTP 请求细节和该 webhook 的真实 secret |
| `幂等键模板` | `idempotency.key_template` |
| `Receipt proof` | `receipt_proof` 摘要 |
| `Last dry-run at` | 最近 dry-run 通过时间 |
| `Last success at` | 最近业务成功时间 |
| `Updated at` | `updated_at` |
| `备注` | 人工说明 |

同步实现必须是幂等 upsert，查找键只能用 `Webhook ID`。删除不做物理删除，改 `status=deprecated` 后同步。

`X-SM-Webhook-Secret` 必须按 webhook 独立生成并登记在 `security.secret`。adapter 校验顺序是：优先使用 `security.secret`；旧记录没有该字段时，才退回全局运行环境变量 `AUTOBITABLE_WEBHOOK_SECRET`；再没有才退回测试默认值 `dev-secret`。新记录禁止依赖默认值。

`Feishu AI 配置 Prompt` 是工作流配置阶段的默认交付物，由 registry 渲染生成。它可以包含该 webhook 的真实 `security.secret`，但不得包含业务 base token、cookie 或 Authorization header。

`POST 请求配置.url` 和 `Feishu AI 配置 Prompt` 里的请求地址必须是 `AUTOBITABLE_PUBLIC_WEBHOOK_URL` 提供的真实公网 URL。同步脚本缺少该环境变量或拿到非 http(s) 绝对 URL 时必须失败，禁止把 `<AUTOBITABLE_PUBLIC_WEBHOOK_URL>` 这类占位符同步到正式台账。

当接入请求来自 `/api/spawn` 或业务 session 委托时，`Feishu AI 配置 Prompt` 的交付面是请求来源 session 绑定的 Feishu 群，而不是子 session 的最终回复。`autobitable` 必须用 bot 身份把完整 Prompt 发到来源群；返回给 spawn caller 的内容只能是短回执，例如 `webhook_id`、发送状态和 `message_id`。

## Receipt Proof

HTTP 202 只证明 adapter 收到了请求，不证明业务完成。每个 webhook 必须声明一个 receipt proof：

```json
{"kind": "exit_zero", "ok_exit_codes": [0]}
```

用于只需要脚本退出码的轻量监控。

`ok_exit_codes` 可登记脚本定义的非错误退出码，例如业务跳过或 dry-run 完成；未配置时默认只接受 `0`。

```json
{"kind": "script_output_json", "expect": "$.ok == true"}
```

用于脚本输出结构化 JSON 的业务证明。

```json
{"kind": "external_evidence", "engine": "bitable", "target": {"status_field": "执行状态"}, "expectation": "成功"}
```

用于业务结果必须落回多维表格的场景。

```json
{"kind": "session_reply_content_check", "pattern": "REPORT:", "pattern_type": "contains", "timeout_ms": 300000}
```

用于 prompt/spawn 子 session 必须产出特定回复的场景。

## 状态模型

Webhook 配置状态：

```text
draft -> active -> paused -> active
                 -> deprecated
```

运行状态：

```text
received -> accepted -> running -> final_status
                         |
                         + trigger_status: pending / ok / failed / duplicate_skipped
                         + verify_status: pending / pass / fail
                         + final_status: pending / success / trigger_failed / evidence_missing / duplicate_skipped
```

`accepted` 不是成功，只代表 `autobitable` 已接管。

`last_success_at` 只能在 `final_status=success` 时更新。`trigger_status=ok` 或 HTTP 202 不能写成功水位。

## 禁止项

- 除每个 webhook 的 `security.secret` 以及由它渲染出的 `Feishu AI 配置 Prompt` 外，禁止在台账里写真实 token、cookie、Authorization header。
- 禁止从请求体拼 shell 命令。
- 禁止让 Bitable 任意字段直接进入 prompt 指令区。
- 禁止没有 `owner_session` 的 webhook。
- 禁止没有幂等键的非只读动作。
- 禁止以 Feishu 消息 `--as user` 触发跨 session 工作。
- 禁止跳过 receipt proof 后直接把 `last_success_at` 标为成功。

## 业务 Session 接入申请模板

业务 session 向 `autobitable` 申请接入时，必须提供：

```json
{
  "display_name": "按钮触发补货检查",
  "class": "prompt_delegation",
  "owner_session": "gongying",
  "created_by": "gongying",
  "description": "当用户点击补货检查按钮时，触发补货检查；不直接创建货件。",
  "category": "数据加工",
  "bitable": {
    "base_token_alias": "inventory_monitor_base",
    "table_id": "tblInventoryMonitor",
    "view_id": "vewInventoryMonitor",
    "table_name": "库存监控",
    "trigger": "manual_button",
    "field_allowlist": []
  },
  "command": {
    "type": "prompt",
    "target_session": "gongying",
    "prompt_template": "请基于以下 Bitable 定位信息做补货检查，只输出 REPORT: 开头的结论..."
  },
  "security": {
    "header": "X-SM-Webhook-Secret",
    "secret": "smwhsec_xxx"
  },
  "params_schema": {
    "type": "object",
    "required": ["webhook_id", "table_id", "view_id", "record_id"],
    "properties": {
      "webhook_id": {"type": "string"},
      "table_id": {"type": "string"},
      "view_id": {"type": "string"},
      "record_id": {"type": "string"},
      "triggered_at": {"type": "string"},
      "fields": {"type": "object"}
    }
  },
  "idempotency": {
    "key_template": "{{webhook_id}}:{{table_id}}:{{view_id}}:{{record_id}}:{{triggered_at}}",
    "on_duplicate": "return_existing"
  },
  "execution": {
    "expected_duration_ms": 300000,
    "timeout_ms": 600000,
    "concurrency": {
      "scope": "record_id",
      "on_conflict": "skip_if_running"
    }
  },
  "receipt_proof": {
    "kind": "session_reply_content_check",
    "pattern": "REPORT:",
    "pattern_type": "contains",
    "timeout_ms": 300000
  },
  "notify": {
    "trigger_failed": {"channel": "owner_session"},
    "receipt_missing": {"channel": "owner_session"},
    "succeeded": {"channel": "none"}
  },
  "writeback": {
    "enabled": true,
    "status_field": "执行状态",
    "run_id_field": "SM运行ID",
    "result_field": "执行摘要"
  }
}
```
