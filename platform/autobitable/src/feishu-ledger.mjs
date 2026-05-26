import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

const STATUS_MAP = {
  active: "active",
  draft: "draft",
  paused: "disabled",
  deprecated: "disabled",
  disabled: "disabled"
};

const TRIGGER_MAP = {
  manual_button: "manual_button",
  field_updated: "field_change",
  field_change: "field_change",
  record_created: "record_create",
  record_create: "record_create",
  scheduled: "scheduled"
};

export async function loadRegistry(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function loadRunRows(path) {
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  return content
    .split(/\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function latestSuccessByWebhook(runs) {
  const latest = new Map();
  for (const run of runs) {
    if (run.final_status !== "success" || !run.webhook_id || !run.received_at) continue;
    const current = latest.get(run.webhook_id);
    if (!current || String(run.received_at) > current) {
      latest.set(run.webhook_id, String(run.received_at));
    }
  }
  return latest;
}

export function webhookToLedgerFields(webhook, options = {}) {
  const lastSuccessAt = options.lastSuccessAtByWebhook?.get(webhook.webhook_id);
  const fields = {
    "Webhook ID": webhook.webhook_id,
    "名称": webhook.display_name,
    "状态": STATUS_MAP[webhook.status] ?? "disabled",
    "Webhook class": webhook.class,
    "业务分类": webhook.category ?? "",
    "Owner session": webhook.owner_session ?? "",
    "Target session": webhook.command?.target_session ?? "",
    "Base token alias": webhook.bitable?.base_token_alias ?? "",
    "Table ID": webhook.bitable?.table_id ?? "",
    "View ID": webhook.bitable?.view_id ?? "",
    "Record ID 来源": "request_body.record_id",
    "触发器": TRIGGER_MAP[webhook.bitable?.trigger] ?? "manual_button",
    "字段白名单": JSON.stringify(webhook.bitable?.field_allowlist ?? []),
    "Workflow ID": webhook.bitable?.workflow_id ?? "",
    "Command type": webhook.command?.type ?? "",
    "Script name": webhook.command?.script_name ?? "",
    "Prompt 摘要": summarizePrompt(webhook.command?.prompt_template),
    "Secret alias": webhook.security?.header ?? webhook.secret_name ?? "",
    "POST 请求配置": JSON.stringify(buildPostRequestConfig(webhook, options), null, 2),
    "Feishu AI 配置 Prompt": buildFeishuAiWorkflowPrompt(webhook, options),
    "幂等键模板": webhook.idempotency?.key_template ?? "",
    "Receipt proof": JSON.stringify(webhook.receipt_proof ?? {}),
    "Last dry-run at": webhook.last_dry_run_at,
    "Last success at": lastSuccessAt,
    "Updated at": webhook.updated_at,
    "备注": webhook.description ?? ""
  };

  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== null)
  );
}

export async function syncRegistryToFeishuLedger(options) {
  const registry = await loadRegistry(options.registryPath);
  const runs = await loadRunRows(options.runStorePath);
  const lastSuccessAtByWebhook = latestSuccessByWebhook(runs);
  const results = [];

  for (const webhook of registry.webhooks ?? []) {
    const fields = webhookToLedgerFields(webhook, {
      lastSuccessAtByWebhook,
      publicWebhookUrl: options.publicWebhookUrl,
      webhookSecretPlaceholder: options.webhookSecretPlaceholder
    });
    const recordId = await findLedgerRecordId(options, webhook.webhook_id);
    const upsert = await upsertLedgerRecord(options, fields, recordId);
    results.push({
      webhook_id: webhook.webhook_id,
      action: recordId ? "updated" : "created",
      record_id: recordId ?? extractRecordId(upsert)
    });
  }

  return results;
}

export async function findLedgerRecordId(options, webhookId) {
  const body = {
    keyword: webhookId,
    search_fields: ["Webhook ID"],
    select_fields: ["Webhook ID"],
    limit: 10
  };
  const result = await runLarkCli(options, [
    "base", "+record-search",
    "--as", options.identity ?? "bot",
    "--base-token", options.baseToken,
    "--table-id", options.tableId,
    "--json", JSON.stringify(body),
    "--format", "json"
  ]);
  const ids = result.data?.record_id_list ?? [];
  return ids[0] ?? null;
}

export async function upsertLedgerRecord(options, fields, recordId) {
  const args = [
    "base", "+record-upsert",
    "--as", options.identity ?? "bot",
    "--base-token", options.baseToken,
    "--table-id", options.tableId,
    "--json", JSON.stringify(fields)
  ];
  if (recordId) args.push("--record-id", recordId);
  return runLarkCli(options, args);
}

function runLarkCli(options, args) {
  return new Promise((resolve, reject) => {
    execFile(options.larkCliPath ?? "lark-cli", args, { timeout: options.timeoutMs ?? 20_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${err.message}\nstdout: ${stdout}\nstderr: ${stderr}`;
        reject(err);
        return;
      }
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (parseErr) {
        parseErr.message = `${parseErr.message}\nstdout: ${stdout}`;
        reject(parseErr);
      }
    });
  });
}

function extractRecordId(result) {
  return result.data?.record?.record_id ?? result.data?.record_id ?? null;
}

function buildPostRequestConfig(webhook, options = {}) {
  const publicWebhookUrl = requirePublicWebhookUrl(options);
  const body = {
    webhook_id: webhook.webhook_id,
    table_id: webhook.bitable?.table_id ?? "{{table_id}}",
    view_id: webhook.bitable?.view_id ?? "{{view_id}}",
    record_id: "{{record_id}}",
    triggered_at: "{{triggered_at}}"
  };

  const allowlist = webhook.bitable?.field_allowlist ?? [];
  if (allowlist.length > 0) {
    body.fields = Object.fromEntries(allowlist.map((field) => [field, `{{${field}}}`]));
  }

  return {
    method: "POST",
    url: publicWebhookUrl,
    params: {},
    headers: {
      "Content-Type": "application/json",
      [webhook.security?.header ?? "X-SM-Webhook-Secret"]: webhook.security?.secret ?? options.webhookSecretPlaceholder ?? "<AUTOBITABLE_WEBHOOK_SECRET>"
    },
    body
  };
}

function requirePublicWebhookUrl(options = {}) {
  const value = String(options.publicWebhookUrl ?? "").trim();
  if (!value) {
    throw new Error("AUTOBITABLE_PUBLIC_WEBHOOK_URL is required for Feishu ledger POST config");
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error(`AUTOBITABLE_PUBLIC_WEBHOOK_URL must be an absolute http(s) URL: ${value}`);
  }
  return value;
}

export function buildFeishuAiWorkflowPrompt(webhook, options = {}) {
  const postConfig = buildPostRequestConfig(webhook, options);
  const triggerLabel = formatTriggerLabel(webhook);
  const buttonFieldBlock = formatButtonFieldBlock(webhook);
  const fieldConditionBlock = formatFieldConditionBlock(webhook.bitable?.field_condition);
  const fieldFiltersBlock = formatFieldFiltersBlock(webhook.bitable?.field_filters);
  const triggerGuidance = formatTriggerGuidance(webhook);
  const bodyJson = JSON.stringify(postConfig.body, null, 2);
  const allowlist = webhook.bitable?.field_allowlist ?? [];
  const fieldsRule = allowlist.length > 0
    ? `本 webhook 允许附带的 fields 只有：${allowlist.map((field) => `\`${field}\``).join("、")}。如果飞书 AI 能取到这些字段，请按 Request body 里的 fields 结构填写；不要加入白名单外字段。`
    : "本 webhook 不需要业务字段；不要在 Request body 里添加 fields。";
  const headerName = webhook.security?.header ?? "X-SM-Webhook-Secret";
  const secretValue = webhook.security?.secret ?? options.webhookSecretPlaceholder ?? "<AUTOBITABLE_WEBHOOK_SECRET>";

  return `你是飞书多维表格自动化配置助手。请帮我在当前多维表格中配置一个自动化工作流，目标是触发后向 SuperMatrix autobitable 服务发送 HTTP POST 请求。

一、触发条件

请在当前多维表格中创建或修改工作流，触发条件如下：

- 触发方式：${triggerLabel}
${buttonFieldBlock}
- 所在表：${webhook.bitable?.table_name ?? ""}
- Table ID：${webhook.bitable?.table_id ?? ""}
- 所在视图：${webhook.bitable?.view_name ?? webhook.bitable?.view_id ?? ""}
- View ID：${webhook.bitable?.view_id ?? ""}
- 记录 ID 来源：使用当前触发按钮或触发事件所在的记录 ID，填入 Request body 的 record_id
${fieldConditionBlock}
${fieldFiltersBlock}
${triggerGuidance}

二、后续流程步骤

触发后只需要执行一个动作：发送 HTTP 请求。

不要添加其它业务判断步骤，不要生成脚本，不要改写表格业务字段，不要调用任何模型能力。业务逻辑由 SuperMatrix autobitable 根据 webhook_id 路由处理。

三、HTTP 请求配置

请求方法：

POST

请求地址 URL：

${postConfig.url}

请求参数 Params：

留空 {}，不需要添加 query 参数。

请求头 Headers：

Content-Type: application/json
${headerName}: ${secretValue}

请求体 Request body 使用 Raw JSON，内容如下：

\`\`\`json
${bodyJson}
\`\`\`

填写要求：

1. webhook_id 必须固定为 \`${webhook.webhook_id}\`，不要改名。
2. table_id 必须固定为 \`${webhook.bitable?.table_id ?? ""}\`。
3. view_id 必须固定为 \`${webhook.bitable?.view_id ?? ""}\`。
4. record_id 必须取当前触发记录的记录 ID，不要写死成示例值。
5. 不要添加 source、command、script_name、prompt、ASIN、触发动作、整行字段。
6. ${fieldsRule}
7. Header 里的 \`${headerName}\` 必须填写为上面给出的真实 secret，不要替换成占位符。

四、响应配置

请把 HTTP 请求响应配置为 JSON 响应即可。
如果飞书需要配置成功判断，2xx 状态码视为 HTTP 请求发送成功。注意：HTTP 成功只代表 autobitable 已收到请求，不代表业务最终完成。

五、配置完成后请返回

请告诉我以下信息：

1. 工作流名称
2. 触发条件摘要
3. HTTP 请求 URL
4. Header 是否已包含 \`${headerName}\`
5. Request body 最终 JSON
6. 是否已经启用工作流`;
}

function formatTriggerLabel(webhook) {
  const trigger = webhook.bitable?.trigger ?? "manual_button";
  if (trigger === "manual_button") return "点击按钮触发";
  if (trigger === "field_updated" || trigger === "field_change") return "字段变化触发";
  if (trigger === "record_created" || trigger === "record_create") return "新记录创建触发";
  if (trigger === "scheduled") return "定时触发";
  return trigger;
}

function formatButtonFieldBlock(webhook) {
  if (webhook.bitable?.trigger !== "manual_button" || !webhook.bitable?.button_field) return "";
  return `- 按钮字段：${webhook.bitable.button_field}`;
}

function formatTriggerGuidance(webhook) {
  const trigger = webhook.bitable?.trigger ?? "manual_button";
  if (trigger === "manual_button") {
    const buttonField = webhook.bitable?.button_field
      ? `按钮字段「${webhook.bitable.button_field}」`
      : "当前记录的按钮点击动作";
    return `请把工作流绑定到${buttonField}。不要配置字段更新监听。`;
  }
  if (trigger === "field_updated" || trigger === "field_change") {
    return "请配置字段变化触发器，并只在字段满足上述条件时触发。";
  }
  if (trigger === "record_created" || trigger === "record_create") {
    return "请配置新记录创建触发器，并使用新建记录的记录 ID。";
  }
  if (trigger === "scheduled") {
    return "请配置定时触发器，并按该 webhook 的固定记录来源规则填写 record_id。";
  }
  return "请按上述触发方式配置工作流，并使用触发事件所在记录的记录 ID。";
}

function formatFieldConditionBlock(condition) {
  if (!condition) return "";
  const parts = [];
  if (condition.field_name) parts.push(`字段：${condition.field_name}`);
  if (condition.operator) parts.push(`条件：${condition.operator}`);
  if (condition.value !== undefined) parts.push(`目标值：${condition.value}`);
  if (parts.length === 0) return "";
  return `- 字段条件：${parts.join("；")}\n`;
}

function formatFieldFiltersBlock(filters) {
  if (!Array.isArray(filters) || filters.length === 0) return "";
  return filters
    .map((filter) => {
      const parts = [];
      if (filter.field_name) parts.push(`字段：${filter.field_name}`);
      if (filter.operator) parts.push(`条件：${filter.operator}`);
      if (filter.value !== undefined) parts.push(`目标值：${filter.value}`);
      if (parts.length === 0) return "";
      return `- 过滤条件：${parts.join("；")}`;
    })
    .filter(Boolean)
    .join("\n")
    .concat("\n");
}

function summarizePrompt(prompt) {
  if (!prompt) return "";
  const normalized = String(prompt).replace(/\s+/gu, " ").trim();
  return normalized.length > 200 ? `${normalized.slice(0, 197)}...` : normalized;
}
