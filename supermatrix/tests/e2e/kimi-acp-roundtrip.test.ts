// tests/e2e/kimi-acp-roundtrip.test.ts
//
// In-process e2e roundtrip tests for the KimiBackend via cross-wired
// PassThrough streams + fakeAcpServer. No real kimi binary is spawned.

import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { KimiBackend } from "../../src/adapters/backend-kimi/index.ts";
import { AcpClient } from "../../src/adapters/backend-kimi/acpClient.ts";
import { runFakeAcpServer } from "../adapters/backend-kimi/fakeAcpServer.ts";
import { asMessageRunId, asAbsolutePath, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";

const TEST_MESSAGE_RUN_ID = asMessageRunId("mr_test");

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: asSessionId("s1"),
    name: "foo",
    alias: "",
    avatar: "",
    category: "", fpManaged: null,
    scope: "user",
    backend: "kimi",
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

function backendWithFake(scenario: "happy") {
  // Cross-wire two PassThroughs so client and server talk to each other:
  //   c2s: client writes here → server reads from it (clientToServer)
  //   s2c: server writes here → client reads from it (serverToClient)
  const c2s = new PassThrough();
  const s2c = new PassThrough();

  // fakeAcpServer uses { clientToServer, serverToClient } (not stdin/stdout)
  runFakeAcpServer({ scenario, clientToServer: c2s, serverToClient: s2c });

  // AcpClient uses { stdin, stdout } from the CLIENT's perspective:
  //   stdin  = where client writes outgoing messages → c2s (server reads)
  //   stdout = where client reads incoming messages  ← s2c (server writes)
  return new KimiBackend({
    acpClient: new AcpClient({ streams: { stdin: c2s, stdout: s2c } }),
  });
}

describe("kimi ACP roundtrip e2e", () => {
  test("first turn: started + assistant_message + completed", async () => {
    const backend = backendWithFake("happy");
    const events: string[] = [];
    let sid: string | null = null;
    let final: string | null = null;

    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })) {
      events.push(e.kind);
      if (e.kind === "started") sid = e.backendSessionId;
      if (e.kind === "completed") final = e.finalMessage;
    }

    expect(sid).toBe("fake-acp-sid-001");
    expect(final).toMatch(/.+/);
    expect(events).toEqual(
      expect.arrayContaining(["started", "assistant_message", "completed"]),
    );

    await backend.dispose();
  });

  test("second turn (resume): started re-announced each turn, prompt reuses sessionId", async () => {
    const backend = backendWithFake("happy");
    const startedIds: string[] = [];

    for await (const e of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ backendSessionId: "fake-acp-sid-001" }),
      prompt: "again",
    })) {
      if (e.kind === "started") startedIds.push(e.backendSessionId);
    }

    // Claude/codex re-announce the session every CLI invocation, which is what
    // feeds the Lark card title its model; kimi mirrors that per-turn contract.
    expect(startedIds).toEqual(["fake-acp-sid-001"]);

    await backend.dispose();
  });
});
