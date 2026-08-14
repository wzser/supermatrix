# Repeatable Automation 托管接入 SOP

## 核心目标

本 SOP 定义业务 session 或人员如何向 `autobitable` 申请一个可重复的 Bitable 自动化流程。`autobitable` 采用“托管接入 + 半自动配置”模式：业务方给出需求、脚本或 prompt，`autobitable` 负责生成 webhook、独立 secret、台账行、POST 请求配置、dry-run 和启用验收。

适用范围：

- Feishu Bitable 记录、按钮或字段变化触发 SuperMatrix 能力。
- 触发后执行确定性 `script`，或委派给目标 session 处理 `prompt`。
- 自动化需要可复用、可审计、可暂停、可恢复，而不是一次性手工操作。

不适用范围：

- 业务判断本身，例如是否要补货、是否要修改 listing。
- 业务脚本内部逻辑。脚本归业务 owner 或 target session 所有。
- Feishu 工作流的危险覆盖。`workflow-get` 返回稀疏 steps 时，禁止直接 update 现有工作流。

## 0. 内容天王接入暴露的问题

### 要解决的问题

内容天王这次接入暴露出的问题不是某个字段缺失，而是入口、责任边界、台账和配置交付没有形成标准产品流程。

### 观察

- 需求入口不够结构化：业务方提出“点按钮触发自动化”，但没有一次性说明 owner、executor、脚本状态、成功证明和副作用。
- owner 与 executor 容易混：表和需求属于内容侧，但实际执行脚本落在 `listing-editor`，必须显式登记 `owner_session`、`target_session`、`approved_by`。
- 脚本标准后置：脚本路径、argv、超时、PATH、输出 JSON 和 receipt proof 是接入中途才补齐。
- Feishu 配置交付不足：只登记 webhook 不够，用户需要看到完整 `POST 请求配置`。
- secret 策略后置：最初复用 `dev-secret`，后续才改成每个 webhook 独立 secret。
- 台账同步滞后：本地 registry、Feishu 配置台账、POST 配置字段需要在草稿阶段同步，而不是测试后补。
- 自动配置边界不清：哪些能由 `autobitable` 直接用 lark-cli 配好，哪些只能给用户配置清单，需要明确。
- 验收标准不够固定：dry-run、live test、幂等、run_id、receipt proof 和失败通知都需要固定输出。

### 产物

这些问题转化为本 SOP 的强制步骤，不靠口头提醒。

### 下一步消费方

所有后续 Bitable webhook / Repeatable Automation 接入都按本 SOP 执行。

## 1. 提出需求

### 要解决的问题

业务方经常只描述“想让表格触发某事”，但 `autobitable` 需要把这个意图变成可验证的 webhook contract。

### 输入

申请方必须提供以下信息；缺一项时保持 `draft`，不进入配置阶段：

- 申请人或申请 session。
- 业务 owner session。
- 实际执行 target session。
- 业务目标：触发后要完成什么。
- Bitable 来源：base/table/view/按钮或触发条件。
- 执行类型：`script` 或 `prompt`。
- 脚本路径和 argv，或 prompt 草稿。
- 是否有业务副作用，例如写表、发消息、创建任务、修改 listing。
- 成功证明：脚本输出、目标 session 回复、外部证据或 Bitable 回写。
- 是否必须把业务字段放进 POST；默认不需要。

### 处理

`autobitable` 把需求分成三类：

- `script_job`：确定性脚本，adapter 直接执行白名单 argv。
- `prompt_delegation`：adapter 调 `/api/spawn`，由 target session 子会话处理。
- `monitoring` / `notification`：只检查或通知，不改变业务状态。

如果表属于 A、执行属于 B，必须让 B 确认它愿意接收这个触发。不能只凭表 owner 代替 executor ACK。

### 产物

- 接入申请草稿。
- 缺口清单。
- 初步 class / owner / target / receipt proof 判断。

### 下一步消费方

`autobitable` 根据申请进入接入评审。

## 2. 提供规范与接入评审

### 要解决的问题

业务方需要知道自己必须满足什么规范，`autobitable` 也要在录入前发现高风险点。

### 输入

- 第 1 步的接入申请。
- `docs/bitable-webhook-contract.md`。
- 当前 session 列表和 owner 边界。

### 处理

`autobitable` 必须向申请方明确以下规范：

- POST body 最小化：只保留 `webhook_id`、`table_id`、`view_id`、`record_id`，可选 `triggered_at`。
- 请求体不带 `source`、`command`、`script_name`、自由 prompt、ASIN、触发动作或整行字段。
- 业务字段只有在 `field_allowlist` 登记后才可进入 `fields`。
- 每个 webhook 必须有独立 `security.secret`，Feishu Header 写 `X-SM-Webhook-Secret`。
- `script` 只能用固定 argv，不能从请求体拼 shell。
- `prompt` 只能渲染登记模板，来自表格的数据必须放入数据块，不得当系统指令。
- 每个 webhook 必须有幂等键、超时、并发策略和 receipt proof。

`autobitable` 评审以下事项：

- owner 和 target 是否存在且职责合理。
- target session 是否需要 ACK。
- 脚本路径是否存在，argv 是否固定。
- prompt 是否包含不可控指令注入风险。
- receipt proof 是否能证明业务真的完成，而不是只证明 HTTP 202。
- Feishu 工作流是否能由 CLI 安全配置。

### 产物

- 接入评审结论：通过 / 需要补充 / 拒绝。
- 给申请方的规范说明。
- 待 owner 或 target 确认的问题列表。

### 下一步消费方

通过评审后进入录入阶段。

## 3. 录入脚本或 Prompt

### 要解决的问题

自动化必须先在本地 registry 和 Feishu 台账中有稳定身份，再让用户配置 Feishu。

### 输入

- 已通过评审的申请。
- owner / target ACK。
- 脚本 argv 或 prompt template。

### 处理

`autobitable` 新增或更新 `registry/bitable-webhooks.json`：

- 生成稳定 `webhook_id`，格式 `wh_<owner>_<purpose>`。
- 生成独立 `security.secret`，格式建议 `smwhsec_<random>`。
- `status` 初始为 `draft`。
- `field_allowlist` 默认 `[]`。
- `params_schema.required` 默认包含 `webhook_id`、`table_id`、`view_id`、`record_id`。
- `idempotency.key_template` 必须覆盖重复点击或重复投递场景。
- `receipt_proof` 必须显式登记。
- `approved_by` 记录确认方；未确认则保持空值或 `draft`。

脚本要求：

- argv 必须是数组。
- 跨 repo 脚本入口优先使用绝对路径。
- 脚本 stdout 推荐输出 JSON：`ok`、`summary`、`evidence`。
- adapter 会补全基础 `PATH`，但脚本不能依赖交互式 shell profile。

prompt 要求：

- 模板由 registry 管理，请求体不能传 prompt。
- 目标 session 必须是登记的 `command.target_session`。
- 长任务使用 `async_kickoff`。

### 产物

- 本地 registry 记录。
- 独立 webhook secret。
- Feishu 台账行。
- `POST 请求配置` 字段，包含 URL、Header、Params、Body 模板和真实 secret。
- `Feishu AI 配置 Prompt` 字段，包含触发条件、步骤、HTTP 请求细节和真实 per-webhook secret。

### 下一步消费方

Feishu 自动化配置者、目标 session 或用户读取 `Feishu AI 配置 Prompt` 配置工作流。

## 4. 配置引导、Feishu AI Prompt 或代配置

### 要解决的问题

用户不应该猜 HTTP 请求怎么填。`autobitable` 默认给出一段可直接复制给飞书 AI 的配置 Prompt；能用 lark-cli 安全代配时再直接代配；两者都不可用时才退回人工配置清单。

### 输入

- Feishu 台账中的 `POST 请求配置`。
- Feishu 台账中的 `Feishu AI 配置 Prompt`。
- Bitable base/table/view/workflow 信息。
- lark-cli 能力探测结果。

### 处理

`autobitable` 按以下顺序处理：

1. 解析或确认 base/table/view。
2. 读取字段和视图结构。
3. 根据 registry 生成 `Feishu AI 配置 Prompt`，并同步到 Feishu 台账。
4. 交付 Prompt：如果接入请求来自 `/api/spawn` 或某个 session 委托，不能把完整 Prompt 作为子 session 的最终回复返回；必须解析请求来源 session 绑定的 Feishu 群，用 bot 身份把 Prompt 发到来源群。返回给 spawn caller 的内容只保留短回执：`webhook_id`、已发送状态、`message_id`。
5. 读取现有 workflow。
6. 判断是否可以安全代配 HTTP action。

`Feishu AI 配置 Prompt` 必须包含：

- 触发条件：按钮点击、字段变化、新记录创建等；字段变化必须写明字段、操作符和目标值。
- 后续流程：触发后只发送 HTTP 请求，不添加业务判断、不改表、不调用模型。
- HTTP 请求细节：method、URL、headers、params、Raw JSON body。
- URL 必须是 `AUTOBITABLE_PUBLIC_WEBHOOK_URL` 提供的真实公网地址；禁止在台账里出现 `<AUTOBITABLE_PUBLIC_WEBHOOK_URL>` 或其它占位符。
- 真实认证信息：`X-SM-Webhook-Secret` 必须写该 webhook 的真实 `security.secret`，不能使用占位符。
- POST body 填充规则：默认只带 `webhook_id`、`table_id`、`view_id`、`record_id`、可选 `triggered_at`；只有 allowlist 字段可进入 `fields`。
- 配置完成后的回传要求：让飞书 AI 返回工作流名称、触发条件、URL、Header、最终 body、是否启用。

Prompt 模板由 `src/feishu-ledger.mjs` 的 `buildFeishuAiWorkflowPrompt()` 生成，台账字段名为 `Feishu AI 配置 Prompt`。如果该字段为空，接入不得进入 dry-run。

来源群发送命令：

```bash
npm run prompt:send -- --webhook-id <webhook_id> --requester-session <source_session>
```

无法从 session 绑定解析群 ID 时，显式指定群：

```bash
npm run prompt:send -- --webhook-id <webhook_id> --chat-id <oc_xxx>
```

可代配条件：

- 目标 workflow 可由 lark-cli 创建，或 update API 返回完整可回写结构。
- 不会覆盖用户已有复杂 steps。
- URL、Headers、Body 可被 API 明确表达。

不可代配条件：

- `workflow-get` 返回稀疏 steps，无法保证 update 不覆盖。
- 需要用户在 UI 中选择按钮、触发器或权限。
- 需要业务方判断某个步骤放在哪里。

不可代配时，`autobitable` 必须给用户清单：

- 飞书 AI 配置 Prompt。
- Method：`POST`
- URL。
- Headers：`Content-Type` 和 `X-SM-Webhook-Secret`。
- Params：通常 `{}`。
- Body：最小 JSON。
- 响应体预期：adapter 返回 200 dry-run 或 202 accepted。

### 产物

- 已配置的 Feishu workflow；或
- 已用 bot 发到请求来源群的 Feishu AI 配置 Prompt 和 `message_id`；或
- 用户可直接照填的配置清单。

### 下一步消费方

`autobitable` 发起 dry-run 验证。

## 5. Dry-run 验证

### 要解决的问题

不能让第一次真实业务触发承担配置验证风险。

### 输入

- Feishu 自动化发出的测试请求，或 `curl` 等价请求。
- Registry 草稿。
- Feishu 台账行。

### 处理

dry-run 必须验证：

- 公网 endpoint 可达。
- `X-SM-Webhook-Secret` 为该 webhook 的独立 secret。
- `webhook_id` 命中 registry。
- `table_id` / `view_id` 与 registry 匹配。
- `record_id` 存在。
- `fields` 缺省时按 `{}` 处理。
- `fields` 如果存在，必须符合 allowlist。
- 幂等键能生成。
- `draft` 状态只允许 dry-run，不允许真实执行。
- `script` 能解析到白名单 argv。
- `prompt` 能渲染模板，但 dry-run 不 spawn。

### 产物

- dry-run 结果。
- `last_dry_run_at`。
- 失败时的修正清单。

### 下一步消费方

通过 dry-run 后进入 live smoke。

## 6. Live smoke 与启用

### 要解决的问题

启用前必须证明真实链路能跑通，同时不能制造不可控业务副作用。

### 输入

- dry-run 通过记录。
- owner / target ACK。
- 低风险测试记录或无副作用脚本。

### 处理

执行一次 live smoke：

- `script_job`：真实执行脚本，检查 exit code 和 receipt proof。
- `prompt_delegation`：真实 spawn 子 session，检查 child session reply。
- 重复发送同一请求，确认幂等策略符合预期。
- 记录 run_id、child_session_id、final_status、receipt_evidence。

通过后：

- registry `status` 改为 `active`。
- 更新 `updated_at`、`last_success_at`。
- 同步 Feishu 台账。
- 返回接入包给申请方。

### 产物

接入包必须包含：

- webhook_id。
- per-webhook secret。
- POST 请求配置。
- Feishu 台账链接。
- dry-run 结果。
- live smoke run_id。
- 启用状态。
- 运维联系人或 owner session。

### 下一步消费方

业务方开始正式使用；`autobitable` 进入运行监管。

## 7. 运行监管

### 要解决的问题

启用后每个触发都要能回答：谁触发、触发了什么、有没有重复、业务是否真的完成、失败通知给谁。

### 输入

- 运行请求。
- Registry。
- Run store。

### 处理

每次触发必须记录到 `data/webhook-runs.jsonl` 或后续 SQLite 表：

- run_id
- webhook_id
- idempotency_key
- received_at
- command_type
- target_session
- table_id / view_id / record_id
- trigger_status
- verify_status
- final_status
- receipt_evidence
- child_session_id 或 script summary
- error

失败通知按 registry `notify` 执行。`HTTP 202` 只代表 adapter 接收，不代表业务成功。

### 产物

- 可查询运行历史。
- 失败通知。
- 可审计 receipt proof。

### 下一步消费方

owner session、用户、`autobitable` 巡检读取运行历史和台账。

## 8. 暂停、恢复、废弃和轮换

### 要解决的问题

Repeatable 自动化不是一次性配置。业务变化、脚本废弃、secret 泄露或表结构变更时，要可控变更。

### 输入

- owner 请求。
- 异常运行证据。
- 表结构变化记录。
- secret 轮换请求。

### 处理

- 暂停：`status=paused`，adapter 拒绝真实执行但保留 dry-run。
- 恢复：重新 dry-run，通过后 `status=active`。
- 废弃：`status=deprecated`，关闭或提醒关闭 Feishu 自动化。
- 轮换 secret：生成新 `security.secret`，更新 registry，同步 Feishu `POST 请求配置`，完成 dry-run 后旧 secret 失效。
- 修改脚本或 prompt：必须重新 owner/target ACK，并重新 dry-run。

### 产物

- Registry 状态变化。
- Feishu 台账同步。
- 保留历史，不删除旧运行记录。

### 下一步消费方

后续巡检和问题追溯。

## 9. 用户入口模板

业务方来找 `autobitable` 时，可以直接提供：

```json
{
  "display_name": "按钮触发 Listing 修改队列派发",
  "owner_session": "content-king",
  "target_session": "listing-editor",
  "business_goal": "点击需求提交表按钮后派发未开始的 listing 修改任务",
  "bitable": {
    "base_token_alias": "content_king",
    "table_id": "tbl...",
    "view_id": "vew...",
    "table_name": "需求提交",
    "trigger": "manual_button",
    "field_allowlist": []
  },
  "command": {
    "type": "script",
    "script_name": "listing_editor_dispatch_pending",
    "argv": ["python3", "/absolute/path/to/script.py", "--dispatch-pending"]
  },
  "receipt_proof": {
    "kind": "exit_zero"
  },
  "side_effects": ["spawn listing-editor 子任务"],
  "expected_duration_ms": 60000
}
```

如果只提供一句自然语言需求，`autobitable` 负责按第 1 步追问补齐。
