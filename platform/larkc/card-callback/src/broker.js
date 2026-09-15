"use strict";

const http = require("node:http");
const fs = require("node:fs");
const lark = require("@larksuiteoapi/node-sdk");
const { createAskBroker } = require("./askBroker");
const { PendingStore } = require("./pendingStore");

const PORT = Number(process.env.BROKER_PORT || 8787);
const TIMEOUT_MS = Number(process.env.ASK_TIMEOUT_MS || 300000); // 5 分钟
const FAKE = process.env.LARK_FAKE === "1";
const EVENTS_LOG = process.env.BROKER_EVENTS_LOG || "/tmp/card-ask-events.jsonl";

function makeEventsSink(path) {
  // Append-only jsonl. Each line is one structural event (asked / settled).
  // We deliberately do NOT log raw question / option text / context body —
  // only counts and flags — so the file is safe to grep and share without
  // leaking the business prompts consumer sessions pass through ask_user.
  let stream = null;
  return (obj) => {
    try {
      if (!stream) stream = fs.createWriteStream(path, { flags: "a" });
      stream.write(JSON.stringify(obj) + "\n");
    } catch (e) {
      // never let logging crash a real run
      console.error("[broker] events sink write failed", e && e.message || e);
    }
  };
}

function realLarkClient() {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) throw new Error("LARK_APP_ID / LARK_APP_SECRET required (set LARK_FAKE=1 for test mode)");
  const client = new lark.Client({ appId, appSecret, appType: lark.AppType.SelfBuild, domain: lark.Domain.Feishu });
  return {
    appId, appSecret,
    sendCard: async (chatId, card) => {
      const res = await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) },
      });
      return res.data.message_id;
    },
    patchCard: async (messageId, card) => {
      await client.im.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } });
    },
  };
}

function fakeLarkClient() {
  let n = 0;
  return {
    appId: "cli_fake", appSecret: "fake",
    sendCard: async (chatId, card) => { console.error("[FAKE sendCard]", chatId, JSON.stringify(card).slice(0, 120)); return `om_fake_${++n}`; },
    patchCard: async (messageId, card) => { console.error("[FAKE patchCard]", messageId, JSON.stringify(card).slice(0, 120)); },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

async function main() {
  const larkClient = FAKE ? fakeLarkClient() : realLarkClient();
  const store = new PendingStore({ timeoutMs: TIMEOUT_MS });
  const onEvent = makeEventsSink(EVENTS_LOG);
  const broker = createAskBroker({ larkClient, store, onEvent });

  // Single WS entry: the framework lark gateway owns the only long connection
  // on the shared app and forwards ask_user clicks here via POST /click. The
  // broker is HTTP-only — it sends/patches cards but never holds its own WSClient.

  // ---- HTTP API for MCP tools ----
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/ask") {
        const body = JSON.parse(await readBody(req));
        const result = await broker.handleAsk(body); // blocks until click or 5-min timeout
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }
      if (req.method === "POST" && req.url === "/click") {
        // Forwarded by the framework lark gateway for an ask_user click, or by
        // tests. Unknown/late tokens deliver() as a safe no-op (returns false).
        const { token, value } = JSON.parse(await readBody(req));
        const ok = broker.deliver(token, value);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok }));
        return;
      }
      if (FAKE && req.method === "GET" && req.url === "/_pending") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([...store.pending.keys()]));
        return;
      }
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200); res.end("ok"); return;
      }
      res.writeHead(404); res.end("not found");
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }
  });
  server.requestTimeout = 0; // do not cut off the long /ask wait
  server.headersTimeout = 0;
  server.listen(PORT, "127.0.0.1", () => console.error(`[broker] listening on 127.0.0.1:${PORT} fake=${FAKE} timeoutMs=${TIMEOUT_MS} events=${EVENTS_LOG}`));
}

main().catch((e) => { console.error("[broker] fatal", e); process.exit(1); });
