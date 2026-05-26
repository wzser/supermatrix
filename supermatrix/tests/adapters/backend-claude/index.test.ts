import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ClaudeBackend } from "../../../src/adapters/backend-claude/index.ts";
import { spawnAndStream } from "../../../src/adapters/backend-claude/process.ts";
import type { AgentEvent } from "../../../src/domain/events/agentEvent.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fakeClaude.sh");

function mkSession(): Session {
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
  };
}

describe("ClaudeBackend", () => {
  test("happy run yields events via AsyncIterable", async () => {
    const backend = new ClaudeBackend({ command: FAKE, buildArgs: () => ["happy"] });
    const events: string[] = [];
    for await (const e of backend.run({ session: mkSession(), prompt: "hi" })) {
      events.push(e.kind);
    }
    expect(events).toContain("started");
    expect(events).toContain("completed");
  });

  test("injects SM_SESSION_NAME env var from session.name", async () => {
    const backend = new ClaudeBackend({ command: FAKE, buildArgs: () => ["env"] });
    const session = mkSession();
    let finalMessage = "";
    for await (const e of backend.run({ session, prompt: "hi" })) {
      if (e.kind === "completed") finalMessage = e.finalMessage;
    }
    expect(finalMessage).toBe(`SM_SESSION_NAME=${session.name}`);
  });

  test("cancel terminates the iteration", async () => {
    const backend = new ClaudeBackend({ command: FAKE, buildArgs: () => ["slow"] });
    const collected: string[] = [];
    const iter = backend.run({ session: mkSession(), prompt: "hi" })[Symbol.asyncIterator]();
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
