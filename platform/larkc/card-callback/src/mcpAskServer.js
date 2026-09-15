"use strict";

const http = require("node:http");

const BROKER_URL = process.env.BROKER_URL || "http://127.0.0.1:8787";
const CHAT_ID = process.env.CHAT_ID || "";
const HTTP_TIMEOUT_MS = 310000; // > broker 的 300s，让 broker 的超时先到

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

function postAsk(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const u = new URL("/ask", BROKER_URL);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }
    );
    req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error("broker /ask timeout")));
    req.on("error", reject);
    req.end(data);
  });
}

function normalizeOptions(options) {
  return (options || []).map((o) => {
    if (typeof o === "string") return { label: o, value: o };
    const out = { label: o.label, value: o.value ?? o.label };
    if (typeof o.description === "string" && o.description.trim()) out.description = o.description;
    return out;
  });
}

function nonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

const MIN_CONTEXT_LENGTH = 40;
const CONTEXT_GUIDANCE = "把用户做决定所需的实际材料贴进 context（方案要点/数据/结论），不接受一句话摘要";
const CONTEXT_SOURCE_RULE = "如果你已经在正文写过分析，必须把它复制进 context——context 是卡片的唯一信息来源，用户只看这张卡做决定，不会翻你的 final message";

// Schema enforcement: tools/list declares these required, but MCP host validation
// is best-effort — multiple 2026-06-04 incidents (mr_714e93a2 empty card,
// mr_31aef54f vague labels) showed cards going out with missing/abstract fields.
// We enforce here so a bad call never reaches broker /ask.
function validateAskArgs(a) {
  if (!a || typeof a !== "object") return "ask_user 参数缺失：需要 { question, options }";
  if (!nonEmptyString(a.question)) return "ask_user 参数非法：question 必须是非空字符串";
  if (!Array.isArray(a.options) || a.options.length === 0) {
    return "ask_user 参数非法：options 必须是非空数组（至少 1 个 option）";
  }
  if (!nonEmptyString(a.context)) {
    return `ask_user 参数非法：context 必须是非空字符串——${CONTEXT_GUIDANCE}`;
  }
  if (a.context.trim().length < MIN_CONTEXT_LENGTH) {
    return `ask_user 参数非法：context 至少需要 ${MIN_CONTEXT_LENGTH} 个字符——${CONTEXT_GUIDANCE}`;
  }
  for (let i = 0; i < a.options.length; i++) {
    const o = a.options[i];
    if (!o || typeof o !== "object") {
      return `ask_user 参数非法：options[${i}] 必须是 { label, description } 对象（string-form option 已不支持——要让 caller 写清后果，不能只给短词）`;
    }
    if (!nonEmptyString(o.label)) return `ask_user 参数非法：options[${i}].label 必须是非空字符串`;
    if (!nonEmptyString(o.description)) {
      return `ask_user 参数非法：options[${i}].description 必须是非空字符串——一句话说清选这个会导致什么具体后果（不能只复述 label）`;
    }
  }
  return null;
}

const ESCAPE_VALUE = "__none_fits__";
const ESCAPE_REASON_TEXT = {
  user_clicked: "触发原因：用户主动选择了「都不合适」。",
  timeout: "触发原因：5 分钟未点击（按设计判定为「选项均不合适或用户无法即时关注」，等同于主动 escape，不再回退到 `default`）。",
};
const ESCAPE_STOP_INSTRUCTION =
  "请立即停止本轮推进：不要再调用 ask_user、不要继续行动、不要做任何决策。" +
  "用一两句话简短说明你卡在哪、还有哪些不确定，然后停手等用户输入下一步指令。";
function escapeText(reason) {
  return `${ESCAPE_REASON_TEXT[reason] || ESCAPE_REASON_TEXT.user_clicked}\n${ESCAPE_STOP_INSTRUCTION}`;
}

function addContextSourceRule(tool) {
  tool.description = tool.description
    .replace("`context` (top-level, REQUIRED whenever the decision references concrete material", "`context` (top-level, REQUIRED for every call")
    .replace("${CONTEXT_SOURCE_RULE}", CONTEXT_SOURCE_RULE);
  return tool;
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "askserver", version: "0.1.0" } } });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [addContextSourceRule({
      name: "ask_user",
      description: "Present the user a pick-one question as a clickable Feishu card and BLOCK until they click an option, click the auto-appended escape button, or 5-minute timeout. Returns the chosen option's value, OR a stop-the-run instruction (see below). Call this tool ONLY when ALL of these hold: (1) you are genuinely blocked — the run cannot proceed without the user's decision; (2) the choice is finite (2-5 options) with materially different consequences; (3) you have already done the investigation and analysis you can do yourself — never ask before analyzing. When all three hold, prefer this tool over writing the question as plain text: a plain-text question in your reply does NOT reliably reach the user and will stall you; this tool puts real buttons in front of them and resumes you with their choice. Do NOT call this tool when the user already gave a clear directive — execute it instead of manufacturing a decision point the user didn't ask for — or when you can resolve the uncertainty yourself by reading files, checking data, or running a command. AUTOMATION-INJECTED RUNS: if this run's prompt starts with 'Δ' (framework-injected async spawn result / batch-todo processing), the user is most likely not watching the chat and a card will just time out — 若无重大风险（不可逆动作 / 对外发送 / 数据破坏 / 花真钱），优先自己决策：选一个合理选项，在回复里写明你的决定和理由，然后继续推进；Δ run 里只有真正高风险的决策才值得弹卡。Provide one concise question and 1-5 options (each option must be a `{ label, description }` object; string-form / bare-label options are rejected at runtime).\n\nDECISION-COMPLETE THRESHOLD (the #1 cause of cards the user can't act on): the user must be able to choose from this card ALONE, without re-opening other docs. So:\n- `context` (top-level, REQUIRED whenever the decision references concrete material — a plan, table schema, data row, file path, config diff, error stack): paste the actual material the user needs to see. ❌ 'feedback on the new occupancy plan' / 'check the schema' → ✅ paste the plan's bullet list / the proposed table columns / the diff itself.\n- ${CONTEXT_SOURCE_RULE}\n- per-option `description` (REQUIRED, runtime-enforced): one short sentence stating the concrete consequence of picking it — what will happen / what will change / what the user is committing to — NOT a restated label, NOT a noun phrase, NOT an evaluative phrase like 'looks good'. ❌ 'approve the plan' / 'still tweaking' / '方案方向基本可以' → ✅ 'create tables foo_x/foo_y with columns A,B,C and run the daily ETL nightly' / 'keep the plan but switch the ETL trigger from cron to event-driven'.\n- BUSINESS IMPACT FIRST (the #2 cause of unactionable cards, after vague labels): WHEN OPTIONS DIFFER IN BUSINESS OUTCOME (data accuracy / user perception / false-positive or false-negative rate / recall / coverage / irreversible actions / cost / SLA), the description MUST lead with the business impact (what changes for the end result the user cares about) and put technical details (diff size / risk / type-check / idempotency / which modules touched) afterward. Pure-technical descriptions are insufficient — the user is not your code reviewer, they cannot judge a tech-only blurb against business goals. ❌ tech-only (user cannot tell what this means for recognition / aggregation quality): '增量解析+全量快照(推荐) — 只解析 archive 里没见过的新 .eml(按 archive_path 去重,秒级),但 jsonl 仍写全量快照;classify/ingest/render 完全不动,幂等不变,风险最低' → ✅ business-first (same option, business consequence stated upfront): '通过读取完整记录,对邮件内容识别更准确,对issue的聚合也会更准确,但是可能会增加少量误判。增量解析+全量快照(推荐) — 只解析 archive 里没见过的新 .eml(按 archive_path 去重,秒级),但 jsonl 仍写全量快照;classify/ingest/render 完全不动,幂等不变,风险最低'. Escape hatch: purely-technical microadjustments that genuinely don't affect business outcome (UI tweaks / color / variable naming / formatting) don't need the business layer — but the burden of proof is on you to be sure there's no business consequence; default to including business impact.\n- If you only have abstract nouns or evaluative phrases to paste, you do NOT have material to ask the user yet — go produce the concrete content (the actual plan / schema / diff) first, THEN call this tool. Calling with vague labels wastes the user's 5-minute decision window and forces them to escape.\n\nThe card automatically appends an escape button labeled '都不合适（停下等我输入）' (value=__none_fits__). BOTH the user clicking that escape button AND a 5-minute timeout produce the SAME result: the tool returns a stop-the-run instruction — you MUST stop, do not re-ask, do not keep acting, just summarize where you're stuck and wait for free-form user input. There is no `default` fallback — a timeout never auto-picks an option. Do NOT use this tool for open-ended input, free-form information gathering, or progress updates.",
      inputSchema: { type: "object", required: ["question", "options", "context"], properties: {
        question: { type: "string", description: "One concise question for the user." },
        context: { type: "string", description: `Required: paste the actual material the user needs to decide from (plan points, data, conclusions), not a one-line summary. ${CONTEXT_SOURCE_RULE}` },
        options: { type: "array", items: { type: "object", properties: {
          label: { type: "string", description: "Short button text shown on the card." },
          value: { type: "string", description: "Value returned to the agent when this option is clicked." },
          description: { type: "string", description: "Required: one short sentence stating the concrete consequence of picking this option (not a restatement of the label). When the options differ in business outcome (accuracy / recall / coverage / irreversible actions / cost / user perception), lead with the business impact and put technical details (diff size / risk / idempotency) afterward — pure-technical blurbs are insufficient because the user can't judge them against business goals. The runtime rejects calls with a missing or blank description." },
        }, required: ["label", "description"] } },
      } },
    })] } });
    return;
  }
  if (method === "tools/call") {
    if (params?.name !== "ask_user") { send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool: ${params?.name}` } }); return; }
    const a = params.arguments || {};
    const validationError = validateAskArgs(a);
    if (validationError) {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: validationError }], isError: true } });
      return;
    }
    const options = normalizeOptions(a.options);
    try {
      const result = await postAsk({
        question: a.question,
        options,
        chat_id: CHAT_ID,
        context: a.context,
      });
      let text;
      if (result.status === "escaped" || result.value === ESCAPE_VALUE) {
        // result.reason: "user_clicked" | "timeout" — both result in the same stop-the-run instruction;
        // we just include the trigger reason so the agent's stop-and-summarize message is accurate.
        text = escapeText(result.reason);
      } else if (result.status === "answered") {
        text = `用户选择了：${result.label ?? result.value}（value=${result.value}）`;
      } else {
        // Legacy fallback — should not reach here after 2026-06-03 broker upgrade
        // (timeout is now returned as status=escaped reason=timeout). Keep a safe text just in case.
        text = escapeText("timeout");
      }
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    } catch (e) {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `ask_user 失败：${String(e && e.message || e)}` }], isError: true } });
    }
    return;
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

let buf = "";
process.stdin.on("data", async (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (line) { try { await handle(JSON.parse(line)); } catch {} }
  }
});
