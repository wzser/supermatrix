"use strict";

const crypto = require("node:crypto");
const { buildAskCard, buildAnsweredCard, buildEscapedCard, buildTimedOutEscapedCard, ESCAPE_VALUE, ESCAPE_LABEL } = require("./card");

function hasNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

const MIN_CONTEXT_LENGTH = 40;
const CONTEXT_GUIDANCE = "把用户做决定所需的实际材料贴进 context（方案要点/数据/结论），不接受一句话摘要";

// Second-line defense: MCP layer already validates, but broker /ask is plain
// HTTP — any caller (curl, alt tool, future bridge) can hit it. Mirror the same
// shape rules so a card never goes out with missing/blank fields.
function validateAskRequest({ question, options, context }) {
  if (!hasNonEmptyString(question)) return "question 必须是非空字符串";
  if (!Array.isArray(options) || options.length === 0) {
    return "options 必须是非空数组";
  }
  if (!hasNonEmptyString(context)) {
    return `context 必须是非空字符串——${CONTEXT_GUIDANCE}`;
  }
  if (context.trim().length < MIN_CONTEXT_LENGTH) {
    return `context 至少需要 ${MIN_CONTEXT_LENGTH} 个字符——${CONTEXT_GUIDANCE}`;
  }
  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    if (!o || typeof o !== "object") return `options[${i}] 必须是对象`;
    if (!hasNonEmptyString(o.label)) return `options[${i}].label 必须是非空字符串`;
    if (!hasNonEmptyString(o.description)) {
      return `options[${i}].description 必须是非空字符串（一句话说清选这个的具体后果）`;
    }
  }
  return null;
}

function createAskBroker({ larkClient, store, tokenFactory = () => crypto.randomBytes(12).toString("hex"), onEvent }) {
  // Events let an outer layer (broker.js) persist structural facts about each
  // ask without leaking business text. We never emit raw question / option
  // labels / option descriptions / default value — only counts and boolean
  // flags so the operator can verify "did the consumer pass context? did
  // every option carry a description?" by grepping the events log.
  const emit = (event, data) => {
    if (!onEvent) return;
    try { onEvent({ ts: new Date().toISOString(), event, ...data }); } catch { /* never let logging crash the run */ }
  };

  async function handleAsk({ question, options, default: defaultValue, chat_id, context }) {
    const validationError = validateAskRequest({ question, options, context });
    if (validationError) {
      // Throw synchronously — broker.js wraps /ask in try/catch and returns 500
      // with the message. We deliberately do NOT emit asked/settled events for
      // rejected calls (nothing was actually asked).
      throw new Error(`ask_user 拒绝：${validationError}`);
    }
    const token = tokenFactory();
    const labelByValue = new Map(options.map((o) => [o.value, o.label]));
    const card = buildAskCard({ question, options, token, context });

    emit("asked", {
      token,
      chat_id: chat_id ?? null,
      question_len: typeof question === "string" ? question.length : 0,
      has_context: hasNonEmptyString(context),
      context_len: hasNonEmptyString(context) ? context.length : 0,
      options_count: options.length,
      options_with_description: options.filter((o) => o && hasNonEmptyString(o.description)).length,
      has_default: defaultValue !== undefined && defaultValue !== null && String(defaultValue).length > 0,
    });

    // Register the pending entry BEFORE sending the card. Otherwise a click that
    // arrives during the sendCard round-trip finds no pending token and is dropped,
    // stranding the run until the 5-minute timeout.
    const settledP = store.register(token, defaultValue);

    let messageId;
    try {
      messageId = await larkClient.sendCard(chat_id, card);
    } catch (e) {
      store.deliver(token, defaultValue); // clear the pending entry + its timer
      await settledP;
      emit("settled", { token, status: "send_failed", value: null, error: String(e && e.message || e) });
      throw e;
    }

    const settled = await settledP;

    // A failed card patch is cosmetic — never fail an already-settled run over it.
    const patch = async (c) => {
      try { await larkClient.patchCard(messageId, c); } catch {}
    };

    if (settled.status === "answered") {
      if (settled.value === ESCAPE_VALUE) {
        emit("settled", { token, status: "escaped", reason: "user_clicked", value: ESCAPE_VALUE });
        await patch(buildEscapedCard({ question, context, options }));
        return { status: "escaped", reason: "user_clicked", value: ESCAPE_VALUE, label: ESCAPE_LABEL };
      }
      const label = labelByValue.get(settled.value) ?? null;
      emit("settled", { token, status: "answered", value: settled.value });
      await patch(buildAnsweredCard({ question, context, options, selectedValue: settled.value }));
      return { status: "answered", value: settled.value, label };
    }
    // Timeout = "user didn't decide in time", which by design counts as 'no option fits / pause and wait'.
    // We deliberately ignore the `default` value at this layer (kept in the request for backward-compat
    // but not used as a silent fallback choice anymore — see commit 2026-06-03).
    emit("settled", { token, status: "escaped", reason: "timeout", value: ESCAPE_VALUE });
    await patch(buildTimedOutEscapedCard({ question, context, options }));
    return { status: "escaped", reason: "timeout", value: ESCAPE_VALUE, label: ESCAPE_LABEL };
  }

  function deliver(token, value) {
    return store.deliver(token, value);
  }

  return { handleAsk, deliver, store };
}

module.exports = { createAskBroker };
