# SOP: Create Feishu Bitable for a Session

> Created: 2026-05-07 | Last updated: 2026-05-07

## 核心目标

**这是一个什么类型的 SOP：** Feishu 资源代建流程

**它要解决什么问题：** 当某个 session 需要一个新的 Feishu Bitable 作为结构化数据落地（如系列档案、订单流水、调研记录），由 FP 代建。痛点：默认建出来的 base 不带 SuperMatrix bot 协作者，session 后续用 `--as bot` upsert/写入会全量 91403。本 SOP 强制把"加 bot 协作者"作为建表收尾必跑步骤，断绝复发。

## When to Use

- 收到 session 请求"帮我建一个 Bitable 用于 X"
- FP 自身需要新建 Bitable（如新增治理表）
- **不适用：** 已有 base 加新 table（已有 base 的 share 列表已经包含 bot，无需重做）

## Prerequisites

- 知道目标 session 的 alias / 用途，决定 base 命名
- 知道字段 schema（列名 + 类型）；不全则先 spawn 目标 session 索要
- `lark-cli --as user` 可用（user identity 才能加协作者；bot 不能把自己加进 share）

## Steps

### Step 1: 建 base

- **要解决的问题**：拿到 base_token，作为后续 table/share 的 anchor。
- **输入**：base 名称、目标 folder_token（可选，默认放在 user 个人空间根目录）
- **处理**：
  ```bash
  lark-cli base +base-create --as user --name "<base 名称>" \
    [--folder-token <folder_token>]
  ```
- **产物**：返回 JSON 含 `app_token`（即 base_token）+ 默认表 `table_id`
- **下一步消费方**：Step 2 用 base_token 建/改 table schema

### Step 2: 建 table 并定义字段

- **要解决的问题**：确保 schema 与 session 实际写入需求一致；默认 table 没有所需字段。
- **输入**：base_token、字段定义清单（name、type、可选 property）
- **处理**：
  - 用 `lark-cli base +table-create` 新建命名表（保留默认表为草稿区也可）
  - 用 `lark-cli base +field-create` 逐个加字段；select / multi-select 字段需要带 `options`
- **产物**：table_id + 完整字段列表
- **下一步消费方**：Step 3 校验、Step 4 加 bot 协作者后由 session 直接写入

### Step 3: 加 SuperMatrix bot 为 full_access 协作者（强制）

- **要解决的问题**：lark-cli `--as bot` 走 SuperMatrix 应用 (`appid=LARK_APP_ID`) 的 tenant_access_token；新建的 base 默认只把 creator (user) 加进 share，bot 不在列表里所有 base API 都返回 `91403 you don't have permission`。这是历史复发坑（2026-05-07 writer 莎士比亚 base 即此故障）。**这一步不能跳，也不能放到"以后再加"——把它当作建 base 的最后一步。**
- **输入**：base_token
- **处理**：
  ```bash
  lark-cli drive permission.members create --as user \
    --params '{"token":"<base_token>","type":"bitable","need_notification":false}' \
    --data '{"member_type":"appid","member_id":"LARK_APP_ID","perm":"full_access"}' \
    --yes
  ```
  返回 `{"code":0, "data":{"member":{"perm":"full_access",...}}, "msg":"Success"}` 即成功。重复加报已存在（无害）。
- **产物**：bot 进入 share 列表，权限 `full_access`
- **下一步消费方**：Step 4 验证；session 后续可用 `--as bot` 直接读写

### Step 4: 用 `--as bot` 验证读写

- **要解决的问题**：share 写完不代表立刻生效（极少数情况下有几秒延迟），且要排除字段类型错误等其他写失败原因。
- **输入**：base_token + 任一 table_id
- **处理**：
  ```bash
  lark-cli base +record-list --as bot \
    --base-token <base_token> --table-id <table_id> --limit 1
  ```
  能返回 200 + 字段头即通过；91403 说明 share 没生效，重跑 Step 3。
- **产物**：bot 可访问确认
- **下一步消费方**：Step 5

### Step 5: 把 base_token / table_id 推回请求方

- **要解决的问题**：requester session 不能从 FP 内部状态里读到，必须显式回传。
- **输入**：base_token、table_id 列表、字段说明
- **处理**：通过 `/api/spawn` 回到 requester session 报告 base_token + table_id + 字段表（不要走 Feishu 转发，避免人机混线）
- **产物**：requester 拿到完整信息可立即 upsert
- **下一步消费方**：requester session

## Common Pitfalls

- **`--as bot` 调 permission.members.create 报 1063001 / 91403：** bot 不能把自己加进 share。必须用 `--as user`。
- **request body 带了 `type` 字段：** 当 member_type=appid 时，body 里的 `type` 字段（user/chat/department/group）必须省略，否则 1063001 invalid parameter。
- **建到 docx/wiki 而不是 bitable：** `permission.members.create` 的 `params.type` 必须是 `bitable`，与 token 类型严格匹配。
- **只给 `edit`：** bot 之后可能需要建/改 field、加 view，给 `full_access` 一步到位，不要省。
- **建表完忘了发 base_token 回 requester：** requester 没法从 SQL/文件里反查；FP 必须主动 spawn 回告。

## Verification

- `lark-cli base +record-list --as bot --base-token <token> --table-id <id> --limit 1` 返回 200
- requester session 收到 base_token + table_id 推送
- changelog 写一行 `trigger_type=user_command, target_doc=fp-self, judgment=accepted, change_summary="为 <session>/<base 名> 建 base + 加 bot share"`
