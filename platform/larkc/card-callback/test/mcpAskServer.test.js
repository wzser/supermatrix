const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const path = require("node:path");

const MCP = path.join(__dirname, "../src/mcpAskServer.js");
const VALID_CONTEXT = "方案要点：同步完整数据并保留失败重试；结论：需要用户选择执行或跳过；影响：执行会写入今日结果，跳过则保留待处理状态。";

// minimal fake broker: /ask waits for an injected answer, mimics broker result shape
function startFakeBroker({ immediateResult } = {}) {
  let pending = null;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === "/ask") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        requests.push(JSON.parse(b));
        if (immediateResult) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(immediateResult));
          return;
        }
        pending = (result) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        };
      });
    } else if (req.url === "/answer") {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        pending(JSON.parse(b)); res.writeHead(200); res.end("ok");
      });
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server,
    port: server.address().port,
    requests,
    answer: (r) => http.request({ host: "127.0.0.1", port: server.address().port, path: "/answer", method: "POST" }, () => {}).end(JSON.stringify(r)),
  })));
}

function rpc(child, obj) { child.stdin.write(JSON.stringify(obj) + "\n"); }

function startMcp(brokerUrl) {
  const child = spawn("node", [MCP], {
    env: { ...process.env, BROKER_URL: brokerUrl, CHAT_ID: "oc_x" },
  });
  const lines = [];
  child.stdout.on("data", (d) => d.toString().split("\n").filter(Boolean).forEach((l) => lines.push(JSON.parse(l))));
  return { child, lines };
}

async function waitForMessage(lines, predicate) {
  const started = Date.now();
  while (Date.now() - started < 1500) {
    const found = lines.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for MCP response");
}

async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, "exit");
  }
}

async function stopServer(server) {
  if (typeof server.closeAllConnections === "function") {
    try { server.closeAllConnections(); } catch {}
  }
  await new Promise((resolve) => server.close(resolve));
}

async function withMcp(brokerUrl, fn) {
  const { child, lines } = startMcp(brokerUrl);
  try {
    return await fn({ child, lines });
  } finally {
    await stopChild(child);
  }
}

async function withBrokerAndMcp(brokerOptions, fn) {
  const fb = await startFakeBroker(brokerOptions);
  try {
    return await withMcp(`http://127.0.0.1:${fb.port}`, async ({ child, lines }) => fn({ fb, child, lines }));
  } finally {
    await stopServer(fb.server);
  }
}

test("tools/list exposes ask_user schema with required context and decision-complete guidance", async () => {
  await withBrokerAndMcp({}, async ({ child, lines }) => {
    rpc(child, { jsonrpc: "2.0", id: 1, method: "tools/list" });

    const response = await waitForMessage(lines, (m) => m.id === 1);
    const tool = response.result.tools.find((t) => t.name === "ask_user");
    assert.ok(tool, "ask_user tool is listed");
    assert.deepStrictEqual(tool.inputSchema.required, ["question", "options", "context"]);
    assert.ok(tool.inputSchema.properties.question);
    assert.ok(tool.inputSchema.properties.options);
    assert.strictEqual(tool.inputSchema.properties.default, undefined, "deprecated default field removed from schema");
    assert.ok(tool.inputSchema.properties.context, "top-level context is declared");
    assert.match(tool.inputSchema.properties.context.description, /context 是卡片的唯一信息来源/);
    assert.match(tool.inputSchema.properties.context.description, /必须把它复制进 context/);
    const optionProps = tool.inputSchema.properties.options.items.properties;
    assert.ok(optionProps.description, "per-option description is declared");
    // Tool description tells agents about the escape button + how to react.
    assert.match(tool.description, /__none_fits__/);
    assert.match(tool.description, /escape/i);
    // Δ automation-injected runs: prefer deciding yourself unless the decision is high-risk.
    assert.match(tool.description, /AUTOMATION-INJECTED RUNS/);
    assert.match(tool.description, /优先自己决策/);
    assert.match(tool.description, /context 是卡片的唯一信息来源/);
    assert.match(tool.description, /必须把它复制进 context/);
  });
});

test("ask_user calls broker /ask and returns the delivered label", async () => {
  await withBrokerAndMcp({}, async ({ fb, child, lines }) => {
    rpc(child, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await new Promise((r) => setTimeout(r, 200));
    rpc(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask_user", arguments: { question: "Q?", context: VALID_CONTEXT, options: [{ label: "生产", value: "prod", description: "部署到生产环境" }], default: "staging" } } });
    await new Promise((r) => setTimeout(r, 200));
    fb.answer({ status: "answered", value: "prod", label: "生产" });

    const callResult = await waitForMessage(lines, (m) => m.id === 2);
    assert.deepStrictEqual(fb.requests[0], {
      question: "Q?",
      context: VALID_CONTEXT,
      options: [{ label: "生产", value: "prod", description: "部署到生产环境" }],
      chat_id: "oc_x",
    });
    assert.match(callResult.result.content[0].text, /用户选择了：生产/);
    assert.match(callResult.result.content[0].text, /value=prod/);
  });
});

test("ask_user surfaces broker timeout (status=escaped reason=timeout) as a stop-and-wait instruction with timeout reason", async () => {
  await withBrokerAndMcp({
    immediateResult: { status: "escaped", reason: "timeout", value: "__none_fits__", label: "都不合适（停下等我输入）" },
  }, async ({ child, lines }) => {
    rpc(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_user", arguments: { question: "Q?", context: VALID_CONTEXT, options: [{ label: "生产", value: "prod", description: "部署到生产环境" }], default: "staging" } } });

    const callResult = await waitForMessage(lines, (m) => m.id === 3);
    assert.strictEqual(callResult.result.isError, undefined);
    const text = callResult.result.content[0].text;
    assert.match(text, /5 分钟未点击/, "tells the agent the trigger was a timeout");
    assert.match(text, /停止本轮推进|停手|不要再调用 ask_user/, "tells the agent to stop");
    assert.doesNotMatch(text, /走默认|走 default/i, "must not say 'fell back to default' anymore");
  });
});

test("ask_user forwards top-level context and per-option description to broker /ask", async () => {
  await withBrokerAndMcp({}, async ({ fb, child, lines }) => {
    rpc(child, { jsonrpc: "2.0", id: 10, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await new Promise((r) => setTimeout(r, 100));
    rpc(child, { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "ask_user", arguments: {
      question: "怎么处理？",
      context: VALID_CONTEXT,
      options: [
        { label: "retry", value: "retry", description: "重跑近 14 天数据" },
        { label: "skip", value: "skip", description: "跳过本批" },
      ],
      default: "skip",
    } } });
    await new Promise((r) => setTimeout(r, 200));
    fb.answer({ status: "answered", value: "retry", label: "retry" });
    await waitForMessage(lines, (m) => m.id === 11);

    const req = fb.requests[0];
    assert.strictEqual(req.context, VALID_CONTEXT);
    assert.strictEqual(req.options[0].description, "重跑近 14 天数据");
    assert.strictEqual(req.options[1].description, "跳过本批", "every option carries description (now required)");
  });
});

test("ask_user surfaces user-clicked escape (status=escaped reason=user_clicked) as a stop-and-wait instruction", async () => {
  await withBrokerAndMcp({
    immediateResult: { status: "escaped", reason: "user_clicked", value: "__none_fits__", label: "都不合适（停下等我输入）" },
  }, async ({ child, lines }) => {
    rpc(child, { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "ask_user", arguments: {
      question: "Q?", context: VALID_CONTEXT, options: [{ label: "A", value: "a", description: "选 A 的后果" }], default: "a",
    } } });

    const callResult = await waitForMessage(lines, (m) => m.id === 12);
    assert.strictEqual(callResult.result.isError, undefined);
    const text = callResult.result.content[0].text;
    assert.match(text, /用户主动选择了「都不合适」/, "tells the agent the trigger was a user click");
    assert.match(text, /停止本轮推进|停手|不要再调用 ask_user/);
  });
});

test("ask_user rejects empty arguments without calling broker /ask", async () => {
  // Reproduces the 2026-06-04 footgun: an agent called the MCP tool with no
  // question / no options and the broker still happily sent an empty card to
  // the chat. inputSchema marked them required, but nothing enforced it at
  // runtime. This test pins the contract that the MCP layer rejects locally
  // BEFORE round-tripping to broker.
  await withBrokerAndMcp({}, async ({ fb, child, lines }) => {
    rpc(child, { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "ask_user", arguments: {} } });

    const callResult = await waitForMessage(lines, (m) => m.id === 20);
    assert.strictEqual(callResult.result.isError, true, "empty arguments → isError tool result");
    assert.match(callResult.result.content[0].text, /question/, "diagnostic mentions question");
    assert.strictEqual(fb.requests.length, 0, "broker /ask must NOT be called when validation fails");
  });
});

test("ask_user rejects empty options array without calling broker /ask", async () => {
  await withBrokerAndMcp({}, async ({ fb, child, lines }) => {
    rpc(child, { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "ask_user", arguments: { question: "Q?", context: VALID_CONTEXT, options: [] } } });

    const callResult = await waitForMessage(lines, (m) => m.id === 21);
    assert.strictEqual(callResult.result.isError, true);
    assert.match(callResult.result.content[0].text, /options/);
    assert.strictEqual(fb.requests.length, 0);
  });
});

test("ask_user rejects blank question without calling broker /ask", async () => {
  await withBrokerAndMcp({}, async ({ fb, child, lines }) => {
    rpc(child, { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "ask_user", arguments: { question: "   ", context: VALID_CONTEXT, options: [{ label: "A", value: "a", description: "选 A 的后果" }] } } });

    const callResult = await waitForMessage(lines, (m) => m.id === 22);
    assert.strictEqual(callResult.result.isError, true);
    assert.match(callResult.result.content[0].text, /question/);
    assert.strictEqual(fb.requests.length, 0);
  });
});

test("ask_user rejects option without a usable label without calling broker /ask", async () => {
  await withBrokerAndMcp({}, async ({ fb, child, lines }) => {
    rpc(child, { jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "ask_user", arguments: { question: "Q?", context: VALID_CONTEXT, options: [{ label: "A", value: "a", description: "选 A 的后果" }, { value: "b", description: "选 B 的后果" }] } } });

    const callResult = await waitForMessage(lines, (m) => m.id === 23);
    assert.strictEqual(callResult.result.isError, true);
    assert.match(callResult.result.content[0].text, /label/);
    assert.strictEqual(fb.requests.length, 0);
  });
});

test("ask_user rejects option without a description without calling broker /ask", async () => {
  // Pins the 2026-06-04 upgrade: option.description is REQUIRED (was only
  // STRONGLY RECOMMENDED before mr_31aef54f showed cards with abstract labels
  // and per-option descriptions that didn't actually state the consequence).
  await withBrokerAndMcp({}, async ({ fb, child, lines }) => {
    rpc(child, { jsonrpc: "2.0", id: 24, method: "tools/call", params: { name: "ask_user", arguments: { question: "Q?", context: VALID_CONTEXT, options: [{ label: "A", value: "a" }] } } });

    const callResult = await waitForMessage(lines, (m) => m.id === 24);
    assert.strictEqual(callResult.result.isError, true);
    assert.match(callResult.result.content[0].text, /description/);
    assert.strictEqual(fb.requests.length, 0);
  });
});

test("ask_user returns an error result when broker is unreachable", async () => {
  const closedServer = http.createServer();
  const port = await new Promise((resolve) => closedServer.listen(0, "127.0.0.1", () => {
    const p = closedServer.address().port;
    closedServer.close(() => resolve(p));
  }));
  await withMcp(`http://127.0.0.1:${port}`, async ({ child, lines }) => {
    rpc(child, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ask_user", arguments: { question: "Q?", context: VALID_CONTEXT, options: [{ label: "继续", value: "继续", description: "继续上一轮动作" }], default: "继续" } } });

    const callResult = await waitForMessage(lines, (m) => m.id === 4);
    assert.strictEqual(callResult.result.isError, true);
    assert.match(callResult.result.content[0].text, /ask_user 失败/);
  });
});

test("ask_user rejects missing or blank context with actionable material guidance", async () => {
  for (const context of [undefined, "   "]) {
    await withBrokerAndMcp({}, async ({ fb, child, lines }) => {
      rpc(child, { jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "ask_user", arguments: {
        question: "Q?", ...(context === undefined ? {} : { context }),
        options: [{ label: "A", value: "a", description: "选 A 的后果" }],
      } } });
      const callResult = await waitForMessage(lines, (m) => m.id === 30);
      assert.strictEqual(callResult.result.isError, true);
      assert.match(callResult.result.content[0].text, /把用户做决定所需的实际材料贴进 context（方案要点\/数据\/结论），不接受一句话摘要/);
      assert.strictEqual(fb.requests.length, 0);
    });
  }
});

test("ask_user rejects context shorter than 40 trimmed characters", async () => {
  await withBrokerAndMcp({}, async ({ fb, child, lines }) => {
    rpc(child, { jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "ask_user", arguments: {
      question: "Q?", context: "   这是一行摘要   ",
      options: [{ label: "A", value: "a", description: "选 A 的后果" }],
    } } });
    const callResult = await waitForMessage(lines, (m) => m.id === 31);
    assert.strictEqual(callResult.result.isError, true);
    assert.match(callResult.result.content[0].text, /至少需要 40/);
    assert.match(callResult.result.content[0].text, /把用户做决定所需的实际材料贴进 context（方案要点\/数据\/结论），不接受一句话摘要/);
    assert.strictEqual(fb.requests.length, 0);
  });
});
