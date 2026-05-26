#!/usr/bin/env node

import { syncRegistryToFeishuLedger } from "../src/feishu-ledger.mjs";

const required = {
  AUTOBITABLE_LEDGER_BASE_TOKEN: process.env.AUTOBITABLE_LEDGER_BASE_TOKEN,
  AUTOBITABLE_LEDGER_TABLE_ID: process.env.AUTOBITABLE_LEDGER_TABLE_ID,
  AUTOBITABLE_PUBLIC_WEBHOOK_URL: process.env.AUTOBITABLE_PUBLIC_WEBHOOK_URL
};

for (const [name, value] of Object.entries(required)) {
  if (!value) {
    console.error(`${name} is required`);
    process.exit(2);
  }
}

const results = await syncRegistryToFeishuLedger({
  registryPath: process.env.AUTOBITABLE_REGISTRY_PATH ?? "registry/bitable-webhooks.json",
  runStorePath: process.env.AUTOBITABLE_RUN_STORE_PATH ?? "data/webhook-runs.jsonl",
  baseToken: required.AUTOBITABLE_LEDGER_BASE_TOKEN,
  tableId: required.AUTOBITABLE_LEDGER_TABLE_ID,
  publicWebhookUrl: required.AUTOBITABLE_PUBLIC_WEBHOOK_URL,
  webhookSecretPlaceholder: process.env.AUTOBITABLE_WEBHOOK_SECRET_PLACEHOLDER,
  identity: process.env.AUTOBITABLE_LEDGER_IDENTITY ?? "bot",
  larkCliPath: process.env.AUTOBITABLE_LARK_CLI_PATH ?? "lark-cli"
});

for (const result of results) {
  console.log(`${result.action}\t${result.webhook_id}\t${result.record_id ?? ""}`);
}
