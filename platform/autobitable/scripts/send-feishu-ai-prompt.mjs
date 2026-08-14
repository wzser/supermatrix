#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { buildFeishuAiWorkflowPrompt } from "../src/feishu-ledger.mjs";

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  printHelp();
  process.exit(2);
}

if (args.help || !args.webhookId || (!args.chatId && !args.requesterSession)) {
  printHelp();
  process.exit(args.help ? 0 : 2);
}

const registry = JSON.parse(await readFile(args.registryPath ?? "registry/bitable-webhooks.json", "utf8"));
const webhook = registry.webhooks?.find((entry) => entry.webhook_id === args.webhookId);
if (!webhook) {
  console.error(`webhook not found: ${args.webhookId}`);
  process.exit(2);
}

const chatId = args.chatId ?? await resolveSessionChatId({
  runtimeDb: args.runtimeDb ?? process.env.SM_DB_PATH,
  requesterSession: args.requesterSession
});

const prompt = buildFeishuAiWorkflowPrompt(webhook, {
  publicWebhookUrl: args.publicWebhookUrl ?? process.env.AUTOBITABLE_PUBLIC_WEBHOOK_URL
});

const message = [
  `**${webhook.display_name ?? webhook.webhook_id}：Feishu AI 工作流配置 Prompt**`,
  "",
  "请把下面这段内容复制给飞书 AI，让它在当前多维表格里完成自动化工作流配置。",
  "",
  "````text",
  prompt,
  "````"
].join("\n");

if (args.dryRun) {
  console.log(JSON.stringify({ chat_id: chatId, webhook_id: webhook.webhook_id, markdown: message }, null, 2));
  process.exit(0);
}

const result = await runJson(args.larkCliPath ?? "lark-cli", [
  "im", "+messages-send",
  "--as", "bot",
  "--chat-id", chatId,
  "--markdown", message
], { timeoutMs: 30_000, maxBuffer: 2 * 1024 * 1024 });

console.log(JSON.stringify({
  ok: true,
  chat_id: chatId,
  webhook_id: webhook.webhook_id,
  message_id: result.data?.message_id ?? null
}, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      parsed.help = true;
    } else if (token === "--dry-run") {
      parsed.dryRun = true;
    } else if (token.startsWith("--")) {
      const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${token} requires a value`);
      }
      parsed[key] = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node scripts/send-feishu-ai-prompt.mjs --webhook-id <id> --requester-session <session>
  node scripts/send-feishu-ai-prompt.mjs --webhook-id <id> --chat-id <oc_xxx>

Options:
  --webhook-id <id>           Registry webhook_id to render
  --requester-session <name>  Source session name; sends to its bound Feishu group
  --chat-id <oc_xxx>          Explicit target chat ID
  --registry-path <path>      Defaults to registry/bitable-webhooks.json
  --runtime-db <path>         Defaults to SM_DB_PATH
  --public-webhook-url <url>  Overrides AUTOBITABLE_PUBLIC_WEBHOOK_URL
  --lark-cli-path <path>      Defaults to lark-cli
  --dry-run                   Print the resolved message without sending`);
}

async function resolveSessionChatId(options) {
  if (!options.runtimeDb) {
    throw new Error("missing runtime DB path; pass --runtime-db or set SM_DB_PATH");
  }
  const sql = [
    "SELECT b.group_id",
    "FROM bindings b JOIN sessions s ON b.session_id = s.id",
    `WHERE s.name = '${sqlEscape(options.requesterSession)}'`,
    "LIMIT 1;"
  ].join(" ");
  const stdout = await runText("sqlite3", [options.runtimeDb, sql], { timeoutMs: 5_000, maxBuffer: 128 * 1024 });
  const chatId = stdout.trim();
  if (!chatId) {
    throw new Error(`no bound Feishu group for session: ${options.requesterSession}`);
  }
  return chatId;
}

function sqlEscape(value) {
  return String(value).replaceAll("'", "''");
}

function runText(bin, argv, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, argv, { timeout: options.timeoutMs ?? 10_000, maxBuffer: options.maxBuffer ?? 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${err.message}\nstdout: ${stdout}\nstderr: ${stderr}`;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

async function runJson(bin, argv, options = {}) {
  const stdout = await runText(bin, argv, options);
  return JSON.parse(stdout || "{}");
}
