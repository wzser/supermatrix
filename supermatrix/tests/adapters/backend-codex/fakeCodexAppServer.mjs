#!/usr/bin/env node
// Scriptable fake `codex app-server` for transport and adapter tests, in the
// same scenario-arg style as fakeCodex.sh. Speaks newline-delimited JSON-RPC
// 2.0 over stdio using the real codex-cli 0.146.0 v2 shapes (verified against
// `codex app-server generate-json-schema` and a live thread/start probe):
//   thread/start|resume response: { thread: { id }, ... }
//   turn/start response:          { turn: { id, status } }
//   turn/steer response:          { turnId }
//   notifications: thread/started, turn/started, item/started,
//     item/completed, thread/tokenUsage/updated, error, turn/completed
// Scenarios cover the happy turn, steering (hold/mismatch/error/race),
// failures, cancellation, out-of-order responses, JSON-RPC errors,
// mid-request close, and SIGTERM-ignoring children.
import { createInterface } from "node:readline";

// The adapter's pre-run health probe runs `<command> --version`; answer it
// like the real CLI so adapter tests can use this fake as the command itself.
if (process.argv.includes("--version")) {
  process.stdout.write("fake-codex-app-server 0.146.0\n");
  process.exit(0);
}

// Env override lets adapter tests exercise the production run-plan builder
// (whose argv is the real `app-server --listen stdio://`) while still
// selecting a fake scenario.
const scenario = process.env.SM_FAKE_APP_SERVER_SCENARIO ?? process.argv[2] ?? "happy";

const THREAD_ID = "fake-thread-1";
const TURN_ID = "fake-turn-1";

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const notif = (method, params) => send({ jsonrpc: "2.0", method, params });

const threadResponse = (id, extra = {}) => ({
  thread: { id, cwd: "/tmp", status: { type: "idle" }, turns: [] },
  ...extra,
});
const turnObject = (status) => ({ id: TURN_ID, status, items: [] });
const agentMessage = (text, phase) =>
  notif("item/completed", {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: { id: `item-${text.length}`, type: "agentMessage", text, ...(phase ? { phase } : {}) },
  });
const turnStarted = () =>
  notif("turn/started", { threadId: THREAD_ID, turn: turnObject("inProgress") });
const turnCompleted = (status, error) =>
  notif("turn/completed", {
    threadId: THREAD_ID,
    turn: { ...turnObject(status), ...(error ? { error } : {}) },
  });

if (scenario === "ignore-sigterm" || scenario === "slow-ignore-interrupt") {
  process.on("SIGTERM", () => {});
  // Keep the event loop alive even after stdin closes.
  setInterval(() => {}, 1_000);
}

let held = null; // out-of-order: first request parked until the second arrives

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined || msg.id === null) {
    // Client notification (e.g. `initialized`): acknowledge via a
    // notification so tests can assert it reached the server.
    notif("fake/ack", { seen: msg.method });
    return;
  }
  route(msg);
});

rl.on("close", () => {
  // Graceful shutdown on stdin EOF, matching real app-server behavior.
  if (scenario !== "ignore-sigterm" && scenario !== "slow-ignore-interrupt") process.exit(0);
});

function route(msg) {
  switch (scenario) {
    case "out-of-order":
      return outOfOrder(msg);
    case "rpc-error":
      return rpcError(msg);
    case "close-mid-request":
      return closeMidRequest(msg);
    case "ignore-sigterm":
      return; // never respond; the test kills us
    case "hang-after-initialize":
      if (msg.method === "initialize") return reply(msg.id, { userAgent: "fake-codex-app-server" });
      return; // park every later request so kill/close tests see it pending
    case "env-proxy":
      return envProxy(msg);
    default:
      return scripted(msg);
  }
}

// All turn-lifecycle scenarios share request handling and differ only in
// what the turn does after it starts and how turn/steer behaves.
function scripted(msg) {
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, { userAgent: "fake-codex-app-server" });
    case "thread/start":
      // Notification lands BEFORE the response: correlation must not assume
      // response-first ordering. (The real server may skip this notification
      // entirely; the adapter announces from the response.)
      notif("thread/started", { thread: { id: THREAD_ID } });
      return reply(msg.id, threadResponse(THREAD_ID));
    case "thread/resume":
      notif("thread/started", { thread: { id: msg.params.threadId } });
      return reply(msg.id, threadResponse(msg.params.threadId));
    case "turn/start":
      reply(msg.id, { turn: turnObject("inProgress") });
      turnStarted();
      return runTurn(msg);
    case "turn/steer":
      return steer(msg);
    case "turn/interrupt": {
      if (scenario === "slow-ignore-interrupt") return; // park it
      reply(msg.id, {});
      return turnCompleted("interrupted");
    }
    default:
      return replyError(msg.id, -32601, `unknown method ${msg.method}`);
  }
}

function runTurn(msg) {
  const promptText = msg.params.input?.[0]?.text ?? "";
  switch (scenario) {
    case "happy":
      agentMessage(`echo:${promptText}`);
      return turnCompleted("completed");
    case "rich-turn":
      agentMessage("planning the work", "commentary");
      notif("item/started", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { id: "cmd-1", type: "commandExecution", command: "ls /tmp", status: "inProgress", cwd: "/tmp" },
      });
      notif("item/completed", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "ls /tmp",
          status: "completed",
          cwd: "/tmp",
          aggregatedOutput: "a.txt\n",
          exitCode: 0,
        },
      });
      agentMessage("final answer", "final_answer");
      notif("thread/tokenUsage/updated", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        tokenUsage: {
          last: {
            inputTokens: 1200,
            cachedInputTokens: 200,
            outputTokens: 80,
            reasoningOutputTokens: 30,
            totalTokens: 1280,
          },
          total: {
            inputTokens: 1200,
            cachedInputTokens: 200,
            outputTokens: 80,
            reasoningOutputTokens: 30,
            totalTokens: 1280,
          },
          modelContextWindow: 272000,
        },
      });
      return turnCompleted("completed");
    case "usage":
      notif("thread/tokenUsage/updated", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        tokenUsage: {
          last: {
            inputTokens: 16006,
            cachedInputTokens: 12000,
            outputTokens: 770,
            reasoningOutputTokens: 463,
            totalTokens: 16776,
          },
          total: {
            inputTokens: 16006,
            cachedInputTokens: 12000,
            outputTokens: 770,
            reasoningOutputTokens: 463,
            totalTokens: 16776,
          },
          modelContextWindow: 272000,
        },
      });
      agentMessage("usage done");
      return turnCompleted("completed");
    case "env":
      agentMessage(`SM_SESSION_NAME=${process.env.SM_SESSION_NAME ?? ""}`);
      return turnCompleted("completed");
    case "attest":
      agentMessage(`SM_CALLER_ATTESTATION=${process.env.SM_CALLER_ATTESTATION ?? ""}`);
      return turnCompleted("completed");
    case "resume-echo":
      agentMessage(`resumed:${msg.params.threadId}`);
      return turnCompleted("completed");
    case "turn-error":
      notif("error", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        willRetry: false,
        error: { message: "The model `gpt-fake` is currently at capacity" },
      });
      return turnCompleted("failed", { message: "The model `gpt-fake` is currently at capacity" });
    case "turn-error-quiet":
      notif("error", { threadId: THREAD_ID, turnId: TURN_ID, willRetry: true, error: { message: "transient stream error" } });
      return turnCompleted("failed", { message: "stream disconnected before completion" });
    case "empty-completion":
      return turnCompleted("completed");
    case "usage-then-hang":
      // A usage snapshot lands mid-turn, then the turn never completes: the
      // parent's kill path must still account these tokens.
      notif("thread/tokenUsage/updated", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        tokenUsage: {
          last: {
            inputTokens: 900,
            cachedInputTokens: 300,
            outputTokens: 120,
            reasoningOutputTokens: 20,
            totalTokens: 1020,
          },
          total: {
            inputTokens: 900,
            cachedInputTokens: 300,
            outputTokens: 120,
            reasoningOutputTokens: 20,
            totalTokens: 1020,
          },
          modelContextWindow: 272000,
        },
      });
      return agentMessage("turn-open", "commentary");
    case "steer-hold":
    case "steer-mismatch":
    case "steer-error":
    case "steer-race":
    case "slow":
    case "slow-ignore-interrupt":
      // Leave the turn open; emit a marker the test can synchronize on.
      return agentMessage("turn-open", "commentary");
    default:
      agentMessage(`echo:${promptText}`);
      return turnCompleted("completed");
  }
}

function steer(msg) {
  switch (scenario) {
    case "steer-mismatch":
      return reply(msg.id, { turnId: "some-other-turn" });
    case "steer-error":
      return replyError(msg.id, -32602, "expectedTurnId does not match the active turn");
    case "steer-race":
      // The turn completes before the server ever answers the steer: the
      // response is dropped and the process exits on stdin EOF.
      agentMessage("raced to completion");
      return turnCompleted("completed");
    default: {
      reply(msg.id, { turnId: msg.params.expectedTurnId });
      const text = msg.params.input?.[0]?.text ?? "";
      agentMessage(`steered:${text}`);
      return turnCompleted("completed");
    }
  }
}

function outOfOrder(msg) {
  if (held === null) {
    held = msg;
    return;
  }
  const first = held;
  held = null;
  notif("fake/interleaved", { between: [first.id, msg.id] });
  reply(msg.id, { method: msg.method, order: "responded-first" });
  reply(first.id, { method: first.method, order: "responded-second" });
}

function rpcError(msg) {
  if (msg.method === "initialize") return reply(msg.id, { userAgent: "fake-codex-app-server" });
  return replyError(msg.id, -32000, `${msg.method} rejected by fake`);
}

function closeMidRequest(msg) {
  if (msg.method === "initialize") return reply(msg.id, { userAgent: "fake-codex-app-server" });
  process.stderr.write("fake app-server exploding\n");
  process.exit(3);
}

function envProxy(msg) {
  if (msg.method !== "initialize") return replyError(msg.id, -32601, "env-proxy only answers initialize");
  return reply(msg.id, {
    httpsProxy: process.env.HTTPS_PROXY ?? "",
    httpProxy: process.env.HTTP_PROXY ?? "",
    allProxy: process.env.ALL_PROXY ?? "",
  });
}
