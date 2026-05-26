// tests/adapters/backend-kimi/acpClient.test.ts
//
// TDD tests for AcpClient. All tests use in-process cross-wired streams —
// no real kimi binary is spawned.
//
// Stream wiring:
//   clientToServer: client writes → server reads  (PassThrough)
//   serverToClient: server writes → client reads  (PassThrough)

import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { AcpClient } from "../../../src/adapters/backend-kimi/acpClient.ts";
import { runFakeAcpServer } from "./fakeAcpServer.ts";

function pairWithFake(scenario: "happy" | "tool" | "cancel" | "error") {
  // Two PassThrough streams cross-wired:
  //   clientToServer: client writes here → server reads from here
  //   serverToClient: server writes here → client reads from here
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();

  runFakeAcpServer({
    scenario,
    clientToServer,
    serverToClient,
  });

  // AcpClient receives:
  //   stdin = where it writes outgoing messages → clientToServer
  //   stdout = where it reads incoming messages ← serverToClient
  return new AcpClient({
    streams: {
      stdin: clientToServer, // client writes here (→ server reads)
      stdout: serverToClient, // client reads here (← server writes)
    },
  });
}

describe("AcpClient", () => {
  test("initialize + newSession returns sessionId", async () => {
    const client = pairWithFake("happy");
    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });
    expect(sid).toBe("fake-acp-sid-001");
    await client.dispose();
  });

  test("prompt collects session updates via onUpdate callback", async () => {
    const client = pairWithFake("happy");
    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });
    const updates: any[] = [];
    const result = await client.prompt({
      sessionId: sid,
      blocks: [{ type: "text", text: "hi" }],
      onUpdate: (u) => updates.push(u),
    });
    expect(result.stopReason).toBe("end_turn");
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[0].sessionUpdate).toBe("agent_message_chunk");
    await client.dispose();
  });

  test("cancel sends session/cancel and stopReason becomes cancelled", async () => {
    const client = pairWithFake("cancel");
    await client.ensureReady();
    const sid = await client.newSession({ cwd: "/tmp" });
    const promptP = client.prompt({
      sessionId: sid,
      blocks: [{ type: "text", text: "long task" }],
      onUpdate: () => {},
    });
    setTimeout(() => {
      client.cancel(sid).catch(() => {});
    }, 100);
    const result = await promptP;
    expect(result.stopReason).toBe("cancelled");
    await client.dispose();
  });

  test("dispose closes idempotently — second call does not throw", async () => {
    const client = pairWithFake("happy");
    await client.ensureReady();
    await client.dispose();
    await expect(client.dispose()).resolves.toBeUndefined();
  });
});
