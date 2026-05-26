// tests/adapters/backend-kimi/index.test.ts
import { describe, expect, test, vi } from "vitest";
import { KimiBackend } from "../../../src/adapters/backend-kimi/index.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: asSessionId("s1"), name: "foo", alias: "", avatar: "", category: "", fpManaged: null,
    scope: "user", backend: "kimi", model: null, effort: null, thinking: false, modelLocked: false,
    workdir: asAbsolutePath("/tmp"), backendSessionId: null, chatName: null,
    purpose: "", status: "idle", parentId: null, depth: 0,
    inactivityTimeoutS: null, maxRuntimeS: null, childType: null,
    triggerKind: null, postIdentity: null, callerInvocation: null,
    continuationHook: null, capabilityPayload: null,
    createdAt: asTimestamp(1), updatedAt: asTimestamp(1), ...overrides,
  };
}

function mockAcpClient() {
  return {
    ensureReady: vi.fn().mockResolvedValue(undefined),
    newSession: vi.fn().mockResolvedValue("acp-sid-001"),
    prompt: vi.fn(async ({ onUpdate }: { onUpdate: (u: unknown) => void }) => {
      onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
      return { stopReason: "end_turn" };
    }),
    cancel: vi.fn().mockResolvedValue(undefined),
    loadSession: vi.fn().mockResolvedValue(undefined),
    getPid: vi.fn().mockReturnValue(12345),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

describe("KimiBackend", () => {
  test("kind is 'kimi'", () => {
    const backend = new KimiBackend({ acpClient: mockAcpClient() as any });
    expect(backend.kind).toBe("kimi");
  });

  test("first-turn run emits started + assistant_message + completed", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    const events: string[] = [];
    let backendSid: string | null = null;
    let final: string | null = null;
    for await (const e of backend.run({ session: mkSession(), prompt: "hi" })) {
      events.push(e.kind);
      if (e.kind === "started") backendSid = e.backendSessionId;
      if (e.kind === "completed") final = e.finalMessage;
    }
    expect(events).toContain("started");
    expect(backendSid).toBe("acp-sid-001");
    expect(final).toBe("hi");
    expect(acp.newSession).toHaveBeenCalled();
  });

  test("resume run does NOT call newSession", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    for await (const _ of backend.run({
      session: mkSession({ backendSessionId: "acp-sid-001" }),
      prompt: "again",
    })) { /* drain */ }
    expect(acp.newSession).not.toHaveBeenCalled();
    expect(acp.prompt).toHaveBeenCalled();
  });

  test("resume run loads persisted session into the current ACP process before prompting", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    for await (const _ of backend.run({
      session: mkSession({ backendSessionId: "acp-sid-001" }),
      prompt: "again",
    })) { /* drain */ }

    expect(acp.loadSession).toHaveBeenCalledWith({
      sessionId: "acp-sid-001",
      cwd: "/tmp",
    });
    expect(acp.loadSession.mock.invocationCallOrder[0]).toBeLessThan(
      acp.prompt.mock.invocationCallOrder[0],
    );
  });

  test("cancel forwards to AcpClient.cancel with the session's backendSessionId", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    await backend.cancel(asSessionId("s1")); // no inflight, no-op
    expect(acp.cancel).not.toHaveBeenCalled();

    // Now cancel during a prompt:
    let cancelMid = false;
    acp.prompt = vi.fn(async ({ sessionId: _sid, onUpdate: _ }: { sessionId: string; onUpdate: (u: unknown) => void }) => {
      // Simulate long task: wait for cancel via the inflight registry
      await new Promise<void>((r) => setTimeout(r, 200));
      return { stopReason: cancelMid ? "cancelled" : "end_turn" };
    });
    // hack: trigger cancel after run starts
    const session = mkSession({ id: asSessionId("s2"), backendSessionId: "acp-sid-002" });
    const iter = backend.run({ session, prompt: "long" })[Symbol.asyncIterator]();
    setTimeout(() => { cancelMid = true; backend.cancel(session.id).catch(() => {}); }, 50);
    while (true) { const { done } = await iter.next(); if (done) break; }
    expect(acp.cancel).toHaveBeenCalledWith("acp-sid-002");
  });

  test("dispose forwards to AcpClient.dispose", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    await backend.dispose();
    expect(acp.dispose).toHaveBeenCalled();
  });

  test("getAcpPid forwards to AcpClient.getPid", () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    expect(backend.getAcpPid()).toBe(12345);
  });
});
