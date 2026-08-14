import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildFeishuAiWorkflowPrompt, latestSuccessByWebhook, webhookToLedgerFields } from "../src/feishu-ledger.mjs";

describe("Feishu ledger sync mapping", () => {
  test("maps a webhook registry entry to the formal ledger fields", () => {
    const webhook = {
      webhook_id: "wh_owner_demo",
      display_name: "Demo Webhook",
      status: "active",
      class: "script_job",
      owner_session: "owner",
      category: "平台运维",
      bitable: {
        base_token_alias: "demo_base",
        table_id: "tblDemo",
        view_id: "vewDemo",
        trigger: "manual_button",
        field_allowlist: []
      },
      command: {
        type: "script",
        target_session: "owner",
        script_name: "demo_script"
      },
      security: {
        header: "X-SM-Webhook-Secret",
        secret: "demo-secret"
      },
      idempotency: {
        key_template: "{{webhook_id}}:{{record_id}}"
      },
      receipt_proof: {
        kind: "script_output_json",
        expect_ok: true
      },
      updated_at: "2026-05-08T19:55:00+08:00"
    };

    const fields = webhookToLedgerFields(webhook, {
      lastSuccessAtByWebhook: new Map([["wh_owner_demo", "2026-05-08T20:00:00+08:00"]]),
      publicWebhookUrl: "http://example.test/autobitable/feishu/bitable/webhook"
    });

    assert.equal(fields["Webhook ID"], "wh_owner_demo");
    assert.equal(fields["名称"], "Demo Webhook");
    assert.equal(fields["状态"], "active");
    assert.equal(fields["Webhook class"], "script_job");
    assert.equal(fields["Command type"], "script");
    assert.equal(fields["字段白名单"], "[]");
    assert.equal(fields["Last success at"], "2026-05-08T20:00:00+08:00");
    assert.equal(fields["Record ID 来源"], "request_body.record_id");
    const postConfig = JSON.parse(fields["POST 请求配置"]);
    assert.equal(postConfig.method, "POST");
    assert.equal(postConfig.url, "http://example.test/autobitable/feishu/bitable/webhook");
    assert.equal(postConfig.headers["X-SM-Webhook-Secret"], "demo-secret");
    assert.deepEqual(postConfig.params, {});
    assert.deepEqual(postConfig.body, {
      webhook_id: "wh_owner_demo",
      table_id: "tblDemo",
      view_id: "vewDemo",
      record_id: "{{record_id}}",
      triggered_at: "{{triggered_at}}"
    });
    assert.match(fields["Feishu AI 配置 Prompt"], /点击按钮触发/);
    assert.match(fields["Feishu AI 配置 Prompt"], /http:\/\/example\.test\/autobitable\/feishu\/bitable\/webhook/);
    assert.match(fields["Feishu AI 配置 Prompt"], /X-SM-Webhook-Secret: demo-secret/);
    assert.match(fields["Feishu AI 配置 Prompt"], /不要在 Request body 里添加 fields/);
    assert.ok(!Object.hasOwn(fields, "ASIN"));
    assert.ok(!Object.hasOwn(fields, "source"));
    assert.ok(!Object.hasOwn(fields, "触发动作"));
  });

  test("requires a concrete public webhook URL for ledger POST config", () => {
    const webhook = {
      webhook_id: "wh_owner_missing_url",
      bitable: {
        table_id: "tblDemo",
        view_id: "vewDemo",
        trigger: "manual_button",
        field_allowlist: []
      },
      security: {
        header: "X-SM-Webhook-Secret",
        secret: "demo-secret"
      }
    };

    assert.throws(
      () => webhookToLedgerFields(webhook),
      /AUTOBITABLE_PUBLIC_WEBHOOK_URL is required/
    );
    assert.throws(
      () => buildFeishuAiWorkflowPrompt(webhook),
      /AUTOBITABLE_PUBLIC_WEBHOOK_URL is required/
    );
    assert.throws(
      () => webhookToLedgerFields(webhook, { publicWebhookUrl: "<AUTOBITABLE_PUBLIC_WEBHOOK_URL>" }),
      /must be an absolute http\(s\) URL/
    );
  });

  test("builds Feishu AI workflow prompt with field condition and allowlisted fields", () => {
    const prompt = buildFeishuAiWorkflowPrompt({
      webhook_id: "wh_owner_field_change",
      bitable: {
        table_name: "拣货需求表",
        table_id: "tblPick",
        view_id: "vewPick",
        trigger: "field_updated",
        field_condition: {
          field_name: "需求状态",
          operator: "changed_to",
          value: "已执行"
        },
        field_allowlist: ["需求状态", "补货码"]
      },
      security: {
        header: "X-SM-Webhook-Secret",
        secret: "field-secret"
      }
    }, {
      publicWebhookUrl: "http://example.test/webhook"
    });

    assert.match(prompt, /字段变化触发/);
    assert.match(prompt, /字段：需求状态；条件：changed_to；目标值：已执行/);
    assert.match(prompt, /"fields": \{/);
    assert.match(prompt, /"需求状态": "{{需求状态}}"/);
    assert.match(prompt, /"补货码": "{{补货码}}"/);
    assert.match(prompt, /X-SM-Webhook-Secret: field-secret/);
    assert.doesNotMatch(prompt, /script_name":/);
  });

  test("builds Feishu AI workflow prompt with additional field filters", () => {
    const prompt = buildFeishuAiWorkflowPrompt({
      webhook_id: "wh_owner_filtered_field_change",
      bitable: {
        table_name: "采购计划表",
        table_id: "tblPurchase",
        view_id: "vewPurchase",
        trigger: "field_updated",
        field_condition: {
          field_name: "人工调整采购数量",
          operator: "changed",
          value: "not_empty"
        },
        field_filters: [
          {
            field_name: "采购状态",
            operator: "equals",
            value: "待确认"
          },
          {
            field_name: "采购交接状态",
            operator: "equals",
            value: "待交接"
          }
        ],
        field_allowlist: []
      },
      security: {
        header: "X-SM-Webhook-Secret",
        secret: "filter-secret"
      }
    }, {
      publicWebhookUrl: "http://example.test/webhook"
    });

    assert.match(prompt, /字段：人工调整采购数量；条件：changed；目标值：not_empty/);
    assert.match(prompt, /过滤条件：字段：采购状态；条件：equals；目标值：待确认/);
    assert.match(prompt, /过滤条件：字段：采购交接状态；条件：equals；目标值：待交接/);
  });

  test("builds Feishu AI workflow prompt for manual button without field-change guidance", () => {
    const prompt = buildFeishuAiWorkflowPrompt({
      webhook_id: "wh_owner_button",
      bitable: {
        table_name: "采购计划表",
        table_id: "tblPurchase",
        view_id: "vewPurchase",
        trigger: "manual_button",
        button_field: "触发人工调整重算",
        field_allowlist: []
      },
      security: {
        header: "X-SM-Webhook-Secret",
        secret: "button-secret"
      }
    }, {
      publicWebhookUrl: "http://example.test/webhook"
    });

    assert.match(prompt, /点击按钮触发/);
    assert.match(prompt, /按钮字段：触发人工调整重算/);
    assert.match(prompt, /请把工作流绑定到按钮字段「触发人工调整重算」/);
    assert.doesNotMatch(prompt, /字段变化触发/);
    assert.doesNotMatch(prompt, /字段条件/);
    assert.doesNotMatch(prompt, /过滤条件/);
  });

  test("extracts latest successful run per webhook", () => {
    const runs = [
      { webhook_id: "wh_a", final_status: "success", received_at: "2026-05-08T01:00:00.000Z" },
      { webhook_id: "wh_a", final_status: "pending", received_at: "2026-05-08T02:00:00.000Z" },
      { webhook_id: "wh_a", final_status: "success", received_at: "2026-05-08T03:00:00.000Z" },
      { webhook_id: "wh_b", final_status: "trigger_failed", received_at: "2026-05-08T04:00:00.000Z" }
    ];

    const latest = latestSuccessByWebhook(runs);

    assert.equal(latest.get("wh_a"), "2026-05-08T03:00:00.000Z");
    assert.equal(latest.has("wh_b"), false);
  });
});
