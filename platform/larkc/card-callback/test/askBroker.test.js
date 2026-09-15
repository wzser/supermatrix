const test = require("node:test");
const assert = require("node:assert");
const { createAskBroker } = require("../src/askBroker");
const { PendingStore } = require("../src/pendingStore");
const VALID_CONTEXT = "方案要点：同步完整数据并保留失败重试；结论：需要用户选择执行或跳过；影响：执行会写入今日结果，跳过则保留待处理状态。";

function fakeClient() {
  const sent = [];
  const patched = [];
  let n = 0;
  return {
    sent, patched,
    sendCard: async (chatId, card) => { sent.push({ chatId, card }); return `om_${++n}`; },
    patchCard: async (messageId, card) => { patched.push({ messageId, card }); },
  };
}

test("handleAsk sends a card, resolves on deliver, patches answered card", async () => {
  const client = fakeClient();
  const store = new PendingStore({ timeoutMs: 100000 });
  const broker = createAskBroker({ larkClient: client, store, tokenFactory: () => "tok1" });

  const askPromise = broker.handleAsk({
    question: "部署到哪？",
    context: VALID_CONTEXT,
    options: [{ label: "生产", value: "prod", description: "部署到生产环境" }],
    default: "staging",
    chat_id: "oc_x",
  });

  // card sent immediately
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(client.sent.length, 1);
  assert.strictEqual(client.sent[0].chatId, "oc_x");

  // simulate click
  assert.strictEqual(broker.deliver("tok1", "prod"), true);
  const result = await askPromise;
  assert.deepStrictEqual(result, { status: "answered", value: "prod", label: "生产" });

  // answered card patched
  assert.strictEqual(client.patched.length, 1);
  assert.ok(JSON.stringify(client.patched[0].card).includes("生产"));
});

test("handleAsk on timeout returns status=escaped reason=timeout (default is ignored) and patches the timed-out escape card", async () => {
  const client = fakeClient();
  const store = new PendingStore({ timeoutMs: 10 }); // real 10ms timer
  const broker = createAskBroker({ larkClient: client, store, tokenFactory: () => "tok2" });

  const result = await broker.handleAsk({
    question: "部署到哪？",
    context: VALID_CONTEXT,
    options: [{ label: "生产", value: "prod", description: "部署到生产环境" }],
    default: "staging", // deprecated, must not surface as the returned value anymore
    chat_id: "oc_x",
  });
  assert.deepStrictEqual(result, {
    status: "escaped",
    reason: "timeout",
    value: "__none_fits__",
    label: "都不合适（停下等我输入）",
  });
  assert.strictEqual(client.patched.length, 1);
  const patchedText = JSON.stringify(client.patched[0].card);
  assert.ok(patchedText.includes("超时"));
  assert.ok(patchedText.includes("停"));
});

test("handleAsk on escape click returns status=escaped and patches the escaped card", async () => {
  const client = fakeClient();
  const store = new PendingStore({ timeoutMs: 100000 });
  const broker = createAskBroker({ larkClient: client, store, tokenFactory: () => "tokE" });

  const askPromise = broker.handleAsk({
    question: "怎么处理？",
    context: VALID_CONTEXT,
    options: [{ label: "retry", value: "retry", description: "重跑本批" }],
    default: "retry",
    chat_id: "oc_x",
  });

  await new Promise((r) => setImmediate(r));
  // sent card carries the escape button (last action, danger, value=__none_fits__)
  const sentActions = client.sent[0].card.elements.find((e) => e.tag === "action").actions;
  const lastAction = sentActions[sentActions.length - 1];
  assert.strictEqual(lastAction.type, "danger");
  assert.strictEqual(lastAction.value.value, "__none_fits__");

  assert.strictEqual(broker.deliver("tokE", "__none_fits__"), true);
  const result = await askPromise;
  assert.strictEqual(result.status, "escaped");
  assert.strictEqual(result.value, "__none_fits__");
  // patched to EscapedCard, not AnsweredCard
  assert.ok(JSON.stringify(client.patched[0].card).includes("都不合适"));
  assert.ok(JSON.stringify(client.patched[0].card).includes("停"));
});

test("answered/escaped/timeout patch cards include the full original options + context", async () => {
  const client = fakeClient();
  const store = new PendingStore({ timeoutMs: 100000 });
  const broker = createAskBroker({ larkClient: client, store, tokenFactory: () => "tokFull" });

  const askPromise = broker.handleAsk({
    question: "怎么处理？",
    context: VALID_CONTEXT,
    options: [
      { label: "retry", value: "retry", description: "重跑近 14 天数据" },
      { label: "skip", value: "skip", description: "跳过本批" },
    ],
    default: "skip",
    chat_id: "oc_x",
  });
  await new Promise((r) => setImmediate(r));
  broker.deliver("tokFull", "retry");
  await askPromise;

  // The answered patch card preserves question + context + both options + description
  const answeredPatch = JSON.stringify(client.patched[0].card);
  assert.ok(answeredPatch.includes("怎么处理"), "answered card keeps question");
  assert.ok(answeredPatch.includes(VALID_CONTEXT), "answered card keeps context");
  assert.ok(answeredPatch.includes("retry") && answeredPatch.includes("skip"),
    "answered card keeps every business option visible (not just the chosen one)");
  assert.ok(answeredPatch.includes("重跑近 14 天数据"), "answered card keeps descriptions");
  assert.ok(answeredPatch.includes("✅") && answeredPatch.includes("已选"),
    "answered card marks the chosen option");
  assert.ok(answeredPatch.includes("▫️"), "answered card marks unchosen options as ▫️");
});

test("handleAsk forwards context to buildAskCard so the sent card renders a note element", async () => {
  const client = fakeClient();
  const store = new PendingStore({ timeoutMs: 100000 });
  const broker = createAskBroker({ larkClient: client, store, tokenFactory: () => "tokCtx" });

  const askPromise = broker.handleAsk({
    question: "Q",
    context: VALID_CONTEXT,
    options: [{ label: "ok", value: "ok", description: "继续推进" }],
    default: "ok",
    chat_id: "oc_x",
  });
  await new Promise((r) => setImmediate(r));
  const noteEl = client.sent[0].card.elements.find((e) => e.tag === "note");
  assert.ok(noteEl, "card has a note element when context is provided");
  assert.ok(JSON.stringify(noteEl).includes(VALID_CONTEXT));

  broker.deliver("tokCtx", "ok");
  await askPromise;
});

test("onEvent emits asked + settled with structural flags only (no raw text)", async () => {
  const client = fakeClient();
  const store = new PendingStore({ timeoutMs: 100000 });
  const events = [];
  const broker = createAskBroker({
    larkClient: client, store,
    tokenFactory: () => "tokEv",
    onEvent: (e) => events.push(e),
  });

  const askPromise = broker.handleAsk({
    question: "怎么处理今天的补货失败批次？",
    context: VALID_CONTEXT,
    options: [
      { label: "retry", value: "retry", description: "重跑近 14 天数据" },
      { label: "skip", value: "skip", description: "跳过本批" },
    ],
    default: "skip",
    chat_id: "oc_x",
  });
  await new Promise((r) => setImmediate(r));
  broker.deliver("tokEv", "retry");
  await askPromise;

  assert.strictEqual(events.length, 2);
  const asked = events[0];
  assert.strictEqual(asked.event, "asked");
  assert.strictEqual(asked.token, "tokEv");
  assert.strictEqual(asked.chat_id, "oc_x");
  assert.strictEqual(asked.has_context, true);
  assert.strictEqual(asked.context_len, VALID_CONTEXT.length);
  assert.strictEqual(asked.options_count, 2);
  assert.strictEqual(asked.options_with_description, 2, "every option carries description (required since 2026-06-04)");
  assert.strictEqual(asked.has_default, true);
  // Crucial: structural facts only, no raw business text.
  for (const k of Object.keys(asked)) {
    assert.ok(!["question", "context", "options", "default"].includes(k),
      `asked event must not carry raw field '${k}'`);
  }

  const settled = events[1];
  assert.strictEqual(settled.event, "settled");
  assert.strictEqual(settled.token, "tokEv");
  assert.strictEqual(settled.status, "answered");
  assert.strictEqual(settled.value, "retry");
});

test("onEvent emits settled status=escaped when user picks the escape button", async () => {
  const client = fakeClient();
  const store = new PendingStore({ timeoutMs: 100000 });
  const events = [];
  const broker = createAskBroker({
    larkClient: client, store, tokenFactory: () => "tokEsc", onEvent: (e) => events.push(e),
  });
  const askPromise = broker.handleAsk({
    question: "Q", context: VALID_CONTEXT, options: [{ label: "a", value: "a", description: "选 a 的后果" }], default: "a", chat_id: "oc_x",
  });
  await new Promise((r) => setImmediate(r));
  broker.deliver("tokEsc", "__none_fits__");
  await askPromise;
  const settled = events.find((e) => e.event === "settled");
  assert.strictEqual(settled.status, "escaped");
  assert.strictEqual(settled.reason, "user_clicked");
  assert.strictEqual(settled.value, "__none_fits__");
});

test("onEvent emits settled status=escaped reason=timeout on timeout (default ignored)", async () => {
  const client = fakeClient();
  const store = new PendingStore({ timeoutMs: 10 });
  const events = [];
  const broker = createAskBroker({
    larkClient: client, store, tokenFactory: () => "tokT", onEvent: (e) => events.push(e),
  });
  await broker.handleAsk({
    question: "Q", context: VALID_CONTEXT, options: [{ label: "a", value: "a", description: "选 a 的后果" }], default: "fallback", chat_id: "oc_x",
  });
  const settled = events.find((e) => e.event === "settled");
  assert.strictEqual(settled.status, "escaped");
  assert.strictEqual(settled.reason, "timeout");
  // The deprecated `default` ("fallback") must NOT surface as the settled value.
  assert.strictEqual(settled.value, "__none_fits__");
});

test("onEvent emits settled status=send_failed when sendCard throws", async () => {
  const client = {
    sendCard: async () => { throw new Error("feishu down"); },
    patchCard: async () => {},
  };
  const store = new PendingStore({ timeoutMs: 100000 });
  const events = [];
  const broker = createAskBroker({
    larkClient: client, store, tokenFactory: () => "tokF", onEvent: (e) => events.push(e),
  });
  await assert.rejects(
    broker.handleAsk({ question: "Q", context: VALID_CONTEXT, options: [{ label: "a", value: "a", description: "选 a 的后果" }], default: "a", chat_id: "oc_x" }),
    /feishu down/,
  );
  const settled = events.find((e) => e.event === "settled");
  assert.strictEqual(settled.status, "send_failed");
  assert.match(settled.error, /feishu down/);
});

test("a thrown onEvent must not crash a run (sink failure is non-fatal)", async () => {
  const client = fakeClient();
  const store = new PendingStore({ timeoutMs: 100000 });
  const broker = createAskBroker({
    larkClient: client, store, tokenFactory: () => "tokTh",
    onEvent: () => { throw new Error("disk full"); },
  });
  const askPromise = broker.handleAsk({
    question: "Q", context: VALID_CONTEXT, options: [{ label: "a", value: "a", description: "选 a 的后果" }], default: "a", chat_id: "oc_x",
  });
  await new Promise((r) => setImmediate(r));
  broker.deliver("tokTh", "a");
  const result = await askPromise;
  assert.strictEqual(result.status, "answered");
});

test("deliver with unknown token returns false", () => {
  const client = fakeClient();
  const store = new PendingStore({ timeoutMs: 100000 });
  const broker = createAskBroker({ larkClient: client, store, tokenFactory: () => "tokX" });
  assert.strictEqual(broker.deliver("ghost", "v"), false);
});

test("click during in-flight sendCard is not dropped (register before send)", async () => {
  let resolveSend;
  const client = {
    sendCard: () => new Promise((res) => { resolveSend = () => res("om_slow"); }),
    patchCard: async () => {},
  };
  const store = new PendingStore({ timeoutMs: 100000 });
  const broker = createAskBroker({ larkClient: client, store, tokenFactory: () => "tokRace" });

  const askPromise = broker.handleAsk({
    question: "Q", context: VALID_CONTEXT, options: [{ label: "生产", value: "prod", description: "部署到生产环境" }], default: "staging", chat_id: "oc_x",
  });

  // sendCard is still in-flight (unresolved); a click arriving now must still land.
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(broker.deliver("tokRace", "prod"), true, "token registered before send completes");

  resolveSend(); // now let the card send finish
  assert.deepStrictEqual(await askPromise, { status: "answered", value: "prod", label: "生产" });
});

test("a failing patchCard does not fail an already-answered run", async () => {
  const client = {
    sendCard: async () => "om_1",
    patchCard: async () => { throw new Error("feishu down"); },
  };
  const store = new PendingStore({ timeoutMs: 100000 });
  const broker = createAskBroker({ larkClient: client, store, tokenFactory: () => "tokP" });

  const askPromise = broker.handleAsk({
    question: "Q", context: VALID_CONTEXT, options: [{ label: "生产", value: "prod", description: "部署到生产环境" }], default: "staging", chat_id: "oc_x",
  });
  await new Promise((r) => setImmediate(r));
  broker.deliver("tokP", "prod");
  assert.deepStrictEqual(await askPromise, { status: "answered", value: "prod", label: "生产" });
});

// ---- 2026-06-04 schema enforcement: mirror the MCP-layer rejects in the
// broker layer so direct HTTP callers (curl, alt MCP bridge) can't bypass the
// shape rules and put an empty / vague card in front of the user.
test("handleAsk rejects blank question without sending a card", async () => {
  const client = fakeClient();
  const store = new PendingStore({ timeoutMs: 100000 });
  const events = [];
  const broker = createAskBroker({ larkClient: client, store, tokenFactory: () => "tokRJQ", onEvent: (e) => events.push(e) });
  await assert.rejects(
    broker.handleAsk({ question: "", context: VALID_CONTEXT, options: [{ label: "A", value: "a", description: "c" }], chat_id: "oc_x" }),
    /question/,
  );
  assert.strictEqual(client.sent.length, 0, "no card sent");
  assert.strictEqual(events.length, 0, "no events emitted for a rejected call");
});

test("handleAsk rejects empty options without sending a card", async () => {
  const client = fakeClient();
  const store = new PendingStore({ timeoutMs: 100000 });
  const broker = createAskBroker({ larkClient: client, store, tokenFactory: () => "tokRJO" });
  await assert.rejects(
    broker.handleAsk({ question: "Q?", context: VALID_CONTEXT, options: [], chat_id: "oc_x" }),
    /options/,
  );
  assert.strictEqual(client.sent.length, 0);
});

test("handleAsk rejects option missing description without sending a card", async () => {
  const client = fakeClient();
  const store = new PendingStore({ timeoutMs: 100000 });
  const broker = createAskBroker({ larkClient: client, store, tokenFactory: () => "tokRJD" });
  await assert.rejects(
    broker.handleAsk({ question: "Q?", context: VALID_CONTEXT, options: [{ label: "A", value: "a" }], chat_id: "oc_x" }),
    /description/,
  );
  assert.strictEqual(client.sent.length, 0);
});

test("handleAsk rejects option missing label without sending a card", async () => {
  const client = fakeClient();
  const store = new PendingStore({ timeoutMs: 100000 });
  const broker = createAskBroker({ larkClient: client, store, tokenFactory: () => "tokRJL" });
  await assert.rejects(
    broker.handleAsk({ question: "Q?", context: VALID_CONTEXT, options: [{ value: "a", description: "c" }], chat_id: "oc_x" }),
    /label/,
  );
  assert.strictEqual(client.sent.length, 0);
});

test("handleAsk rejects missing or blank context before sending a card", async () => {
  for (const context of [undefined, "   "]) {
    const client = fakeClient();
    const store = new PendingStore({ timeoutMs: 100000 });
    const broker = createAskBroker({ larkClient: client, store, tokenFactory: () => "tokRJC" });
    await assert.rejects(
      broker.handleAsk({
        question: "Q?",
        ...(context === undefined ? {} : { context }),
        options: [{ label: "A", value: "a", description: "选 A 的后果" }],
        chat_id: "oc_x",
      }),
      /把用户做决定所需的实际材料贴进 context（方案要点\/数据\/结论），不接受一句话摘要/,
    );
    assert.strictEqual(client.sent.length, 0);
  }
});

test("handleAsk rejects context shorter than 40 trimmed characters before sending a card", async () => {
  const client = fakeClient();
  const store = new PendingStore({ timeoutMs: 100000 });
  const broker = createAskBroker({ larkClient: client, store, tokenFactory: () => "tokRCS" });
  await assert.rejects(
    broker.handleAsk({
      question: "Q?",
      context: "   这是一行摘要   ",
      options: [{ label: "A", value: "a", description: "选 A 的后果" }],
      chat_id: "oc_x",
    }),
    /至少需要 40.*把用户做决定所需的实际材料贴进 context（方案要点\/数据\/结论），不接受一句话摘要/,
  );
  assert.strictEqual(client.sent.length, 0);
});
