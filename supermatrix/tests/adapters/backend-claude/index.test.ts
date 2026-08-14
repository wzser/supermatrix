import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ClaudeBackend } from "../../../src/adapters/backend-claude/index.ts";
import { spawnAndStream } from "../../../src/adapters/backend-claude/process.ts";
import type { AgentEvent } from "../../../src/domain/events/agentEvent.ts";
import { createCallerAttestationRegistry } from "../../../src/domain/callerAttestation.ts";
import { asMessageRunId, asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import type { RunInput } from "../../../src/ports/AgentBackend.ts";

const TEST_MESSAGE_RUN_ID = asMessageRunId("mr_test");

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fakeClaude.sh");
const NODE = process.execPath;

function userEnvelope(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  }) + "\n";
}

// Fake claude in --replay-user-messages mode: echoes every stdin user envelope
// back as {"type":"user"}. FINISH ends the turn; the result reports how many
// stdin lines were received so tests can prove what was (not) written.
const ECHO_REPLAY_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "system", session_id: "bks-echo" }) + "\\n");
const rl = require("node:readline").createInterface({ input: process.stdin });
let n = 0;
rl.on("line", (line) => {
  n += 1;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  process.stdout.write(JSON.stringify({ type: "user", message: msg.message, session_id: "bks-echo" }) + "\\n");
  const text = (Array.isArray(msg.message.content) ? msg.message.content : [])
    .filter((b) => b && b.type === "text").map((b) => b.text).join("");
  if (text.includes("FINISH")) {
    process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "done:" + n }) + "\\n");
    process.exit(0);
  }
});
`;

// Resume attempt that dies with a thinking-block poisoning error as soon as an
// injected message (line 2) arrives, without ever replaying it.
const RESUME_FAIL_ON_STEER_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "system", session_id: "bks-poisoned" }) + "\\n");
const rl = require("node:readline").createInterface({ input: process.stdin });
let n = 0;
rl.on("line", () => {
  n += 1;
  if (n === 2) {
    process.stderr.write("API Error: 400 messages.1.content.0: Invalid \`signature\` in \`thinking\` block");
    process.exit(1);
  }
});
`;

// Fresh-session replacement: replays the initial envelope and completes.
const FRESH_AFTER_RESUME_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "system", session_id: "bks-fresh" }) + "\\n");
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: "user", message: msg.message, session_id: "bks-fresh" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "fresh-done" }) + "\\n");
  process.exit(0);
});
`;

// Retries only while the backend has not yet registered the in-flight handle
// (run() sets it up asynchronously); every other failure propagates.
async function steerWhenReady(
  backend: ClaudeBackend,
  input: Parameters<ClaudeBackend["steer"]>[0],
  timeoutMs = 3000,
): Promise<Awaited<ReturnType<ClaudeBackend["steer"]>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await backend.steer(input);
    } catch (err) {
      if (!/no active/u.test(String(err)) || Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: asSessionId("s1"),
    name: "foo",
    alias: "",
    avatar: "", category: "", fpManaged: null,
    scope: "user",
    backend: "claude",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/tmp"),
    backendSessionId: null,
    chatName: null,
    purpose: "",
    status: "idle",
    parentId: null,
    depth: 0,
    inactivityTimeoutS: null,
    maxRuntimeS: null,
    childType: null,
    triggerKind: null,
    postIdentity: null,
    callerInvocation: null,
    continuationHook: null,
    capabilityPayload: null,
    createdAt: asTimestamp(1),
    updatedAt: asTimestamp(1),
    ...overrides,
  };
}

describe("ClaudeBackend", () => {
  test("happy run yields events via AsyncIterable", async () => {
    const backend = new ClaudeBackend({ command: FAKE, buildArgs: () => ["happy"] });
    const events: string[] = [];
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })) {
      events.push(e.kind);
    }
    expect(events).toContain("started");
    expect(events).toContain("completed");
  });

  test("injects SM_SESSION_NAME env var from session.name", async () => {
    const backend = new ClaudeBackend({ command: FAKE, buildArgs: () => ["env"] });
    const session = mkSession();
    let finalMessage = "";
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" })) {
      if (e.kind === "completed") finalMessage = e.finalMessage;
    }
    expect(finalMessage).toBe(`SM_SESSION_NAME=${session.name}`);
  });

  test("injects a caller attestation the runtime can resolve back to this session", async () => {
    const registry = createCallerAttestationRegistry();
    const backend = new ClaudeBackend({
      command: FAKE,
      buildArgs: () => ["attest"],
      callerAttestations: registry,
    });
    const session = mkSession();
    let token = "";
    let resolvedDuringRun: unknown = null;

    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" })) {
      if (e.kind === "completed") {
        token = e.finalMessage.replace("SM_CALLER_ATTESTATION=", "");
        resolvedDuringRun = registry.resolve(token);
      }
    }

    expect(token).not.toBe("");
    expect(token).not.toContain(session.name);
    expect(resolvedDuringRun).toEqual({
      sessionId: session.id,
      sessionName: session.name,
      backend: "claude",
      issuedAt: expect.any(Number),
    });
  });

  test("revokes the attestation when the run ends, bounding the leak window", async () => {
    const registry = createCallerAttestationRegistry();
    const backend = new ClaudeBackend({
      command: FAKE,
      buildArgs: () => ["attest"],
      callerAttestations: registry,
    });
    let token = "";
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })) {
      if (e.kind === "completed") token = e.finalMessage.replace("SM_CALLER_ATTESTATION=", "");
    }
    expect(registry.resolve(token)).toBeNull();
    expect(registry.size()).toBe(0);
  });

  test("disables card ask before spawn when broker health check fails", async () => {
    const captured: RunInput[] = [];
    const backend = new ClaudeBackend({
      command: FAKE,
      buildArgs: (input) => {
        captured.push(input);
        return ["happy"];
      },
      cardAskHealthCheck: async () => false,
    });

    for await (const _e of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession(),
      prompt: "hi",
      cardAskEnabled: true,
      cardAskChatId: "oc_card_ask",
    })) {
      // drain
    }

    expect(captured).toHaveLength(1);
    expect(captured[0].cardAskEnabled).toBeUndefined();
    expect(captured[0].cardAskChatId).toBeUndefined();
  });

  test("recovers from invalid thinking signature by starting a fresh session", async () => {
    const invocations: string[][] = [];
    const backend = new ClaudeBackend({
      command: FAKE,
      buildArgs: (input) => {
        const args = ["invalid-signature-then-happy"];
        if (input.session.backendSessionId) {
          args.push("--resume", input.session.backendSessionId);
        }
        invocations.push(args);
        return args;
      },
    });
    const events: AgentEvent[] = [];
    for await (const e of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ backendSessionId: "bks-poisoned" }),
      prompt: "hi",
    })) {
      events.push(e);
    }

    expect(invocations).toEqual([
      ["invalid-signature-then-happy", "--resume", "bks-poisoned"],
      ["invalid-signature-then-happy"],
    ]);
    expect(events).not.toContainEqual(expect.objectContaining({
      kind: "started",
      backendSessionId: "bks-poisoned",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "started",
      backendSessionId: "bks-fresh",
    }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "completed" }));
  });

  test("recovers from model-switch thinking-block poisoning by starting a fresh session", async () => {
    const invocations: string[][] = [];
    const backend = new ClaudeBackend({
      command: FAKE,
      buildArgs: (input) => {
        const args = ["cannot-modify-then-happy"];
        if (input.session.backendSessionId) {
          args.push("--resume", input.session.backendSessionId);
        }
        invocations.push(args);
        return args;
      },
    });
    const events: AgentEvent[] = [];
    for await (const e of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ backendSessionId: "bks-poisoned" }),
      prompt: "hi",
    })) {
      events.push(e);
    }

    expect(invocations).toEqual([
      ["cannot-modify-then-happy", "--resume", "bks-poisoned"],
      ["cannot-modify-then-happy"],
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "started",
      backendSessionId: "bks-fresh",
    }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "completed" }));
  });

  test("steer routes to the in-flight handle bound to the messageRunId and resolves on replay", async () => {
    const backend = new ClaudeBackend({
      command: NODE,
      buildCommand: (input) => ({ args: ["-e", ECHO_REPLAY_SCRIPT], stdin: userEnvelope(input.prompt) }),
      cardAskHealthCheck: async () => true,
    });
    const events: AgentEvent[] = [];
    const runP = (async () => {
      for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })) {
        events.push(e);
      }
    })();

    const result = await steerWhenReady(backend, {
      sessionId: asSessionId("s1"),
      expectedMessageRunId: TEST_MESSAGE_RUN_ID,
      text: "note",
    });
    expect(result).toEqual({ accepted: true });

    await backend.steer({
      sessionId: asSessionId("s1"),
      expectedMessageRunId: TEST_MESSAGE_RUN_ID,
      text: "FINISH",
    });
    await runP;
    // initial prompt + note + FINISH = 3 stdin lines
    expect(events).toContainEqual(expect.objectContaining({ kind: "completed", finalMessage: "done:3" }));
  }, 10_000);

  test("steer with a stale expectedMessageRunId rejects without writing to the child", async () => {
    const backend = new ClaudeBackend({
      command: NODE,
      buildCommand: (input) => ({ args: ["-e", ECHO_REPLAY_SCRIPT], stdin: userEnvelope(input.prompt) }),
      cardAskHealthCheck: async () => true,
    });
    const events: AgentEvent[] = [];
    const runP = (async () => {
      for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })) {
        events.push(e);
      }
    })();

    await steerWhenReady(backend, {
      sessionId: asSessionId("s1"),
      expectedMessageRunId: TEST_MESSAGE_RUN_ID,
      text: "warmup",
    });
    await expect(backend.steer({
      sessionId: asSessionId("s1"),
      expectedMessageRunId: asMessageRunId("mr_other"),
      text: "stale text",
    })).rejects.toThrow(/stale/u);

    await backend.steer({
      sessionId: asSessionId("s1"),
      expectedMessageRunId: TEST_MESSAGE_RUN_ID,
      text: "FINISH",
    });
    await runP;
    // initial + warmup + FINISH = 3; the stale text never reached the child.
    expect(events).toContainEqual(expect.objectContaining({ kind: "completed", finalMessage: "done:3" }));
  }, 10_000);

  test("steer without an in-flight run rejects", async () => {
    const backend = new ClaudeBackend({ command: FAKE, buildArgs: () => ["happy"] });
    await expect(backend.steer({
      sessionId: asSessionId("s1"),
      expectedMessageRunId: TEST_MESSAGE_RUN_ID,
      text: "x",
    })).rejects.toThrow(/no active/u);
  });

  test("resume-handle replacement rejects the old pending steer exactly once and completes on the fresh handle", async () => {
    const backend = new ClaudeBackend({
      command: NODE,
      buildCommand: (input) => (
        input.session.backendSessionId
          ? { args: ["-e", RESUME_FAIL_ON_STEER_SCRIPT], stdin: userEnvelope(input.prompt) }
          : { args: ["-e", FRESH_AFTER_RESUME_SCRIPT], stdin: userEnvelope(input.prompt) }
      ),
      cardAskHealthCheck: async () => true,
    });
    const events: AgentEvent[] = [];
    const runP = (async () => {
      for await (const e of backend.run({
        messageRunId: TEST_MESSAGE_RUN_ID,
        session: mkSession({ backendSessionId: "bks-poisoned" }),
        prompt: "hi",
      })) {
        events.push(e);
      }
    })();

    const settle = { resolved: 0, rejected: 0 };
    await steerWhenReady(backend, {
      sessionId: asSessionId("s1"),
      expectedMessageRunId: TEST_MESSAGE_RUN_ID,
      text: "doomed",
    }).then(
      () => { settle.resolved += 1; },
      () => { settle.rejected += 1; },
    );

    await runP;
    expect(settle).toEqual({ resolved: 0, rejected: 1 });
    expect(events).not.toContainEqual(expect.objectContaining({
      kind: "started",
      backendSessionId: "bks-poisoned",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "started",
      backendSessionId: "bks-fresh",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "completed",
      finalMessage: "fresh-done",
    }));
  }, 10_000);

  test("cancel terminates the iteration", async () => {
    const backend = new ClaudeBackend({ command: FAKE, buildArgs: () => ["slow"] });
    const collected: string[] = [];
    const iter = backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })[Symbol.asyncIterator]();
    const firstP = iter.next();
    await new Promise((r) => setTimeout(r, 100));
    await backend.cancel(asSessionId("s1"));
    while (true) {
      const { value, done } = await (collected.length === 0 ? firstP : iter.next());
      if (done) break;
      collected.push(value.kind);
      if (collected.length > 10) break;
    }
    expect(collected.length).toBeGreaterThan(0);
  }, 10_000);
});

describe("spawnAndStream timeouts", () => {
  test("inactivity timeout fires when no stdout", async () => {
    const handle = spawnAndStream({
      command: "sleep",
      args: ["999"],
      cwd: "/tmp",
      inactivityTimeoutMs: 300,
    });
    const events: AgentEvent[] = [];
    for await (const e of handle.iterable) {
      events.push(e);
    }
    const err = events.find((e) => e.kind === "error");
    expect(err).toBeDefined();
    expect(err!.kind === "error" && err!.message).toContain("[TIMEOUT] inactivity");
  }, 10_000);

  test("max runtime timeout fires", async () => {
    const handle = spawnAndStream({
      command: "/bin/sh",
      args: ["-c", "while true; do echo ping; sleep 0.05; done"],
      cwd: "/tmp",
      maxRuntimeMs: 500,
    });
    const events: AgentEvent[] = [];
    for await (const e of handle.iterable) {
      events.push(e);
    }
    const err = events.find((e) => e.kind === "error");
    expect(err).toBeDefined();
    expect(err!.kind === "error" && err!.message).toContain("[TIMEOUT] max runtime");
  }, 10_000);

  test("active stdout resets inactivity timer", async () => {
    const handle = spawnAndStream({
      command: "/bin/sh",
      args: ["-c", "for i in 1 2 3; do echo line$i; sleep 0.15; done"],
      cwd: "/tmp",
      inactivityTimeoutMs: 300,
    });
    const events: AgentEvent[] = [];
    for await (const e of handle.iterable) {
      events.push(e);
    }
    const hasTimeout = events.some((e) => e.kind === "error" && e.message.includes("[TIMEOUT]"));
    expect(hasTimeout).toBe(false);
  }, 10_000);

  test("cancel clears inactivity timer", async () => {
    const handle = spawnAndStream({
      command: "sleep",
      args: ["999"],
      cwd: "/tmp",
      inactivityTimeoutMs: 5000,
    });
    setTimeout(() => handle.cancel(), 100);
    const events: AgentEvent[] = [];
    for await (const e of handle.iterable) {
      events.push(e);
    }
    const err = events.find((e) => e.kind === "error");
    expect(err!.kind === "error" && err!.message).toBe("cancelled by user");
  }, 10_000);
});
