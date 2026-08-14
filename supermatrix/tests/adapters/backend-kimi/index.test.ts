// tests/adapters/backend-kimi/index.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KimiBackend } from "../../../src/adapters/backend-kimi/index.ts";
import {
  resetConfiguredBackendRuntimeDefaultsForTests,
  setConfiguredBackendRuntimeDefaults,
} from "../../../src/ports/BackendRuntimeDefaults.ts";
import { asMessageRunId, asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import type { AttachmentRef } from "../../../src/ports/AgentBackend.ts";

const TEST_MESSAGE_RUN_ID = asMessageRunId("mr_test");

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
    setSessionModel: vi.fn().mockResolvedValue(undefined),
    setSessionConfigOption: vi.fn().mockResolvedValue(undefined),
    getSessionModel: vi.fn().mockReturnValue(undefined),
    getPid: vi.fn().mockReturnValue(12345),
    getState: vi.fn().mockReturnValue("ready"),
    probeHealth: vi.fn().mockResolvedValue({ rttMs: 0 }),
    dispose: vi.fn().mockResolvedValue(undefined),
    setCardAskRoute: vi.fn(),
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
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })) {
      events.push(e.kind);
      if (e.kind === "started") backendSid = e.backendSessionId;
      if (e.kind === "completed") final = e.finalMessage;
    }
    expect(events).toContain("started");
    expect(backendSid).toBe("acp-sid-001");
    expect(final).toBe("hi");
    expect(acp.newSession).toHaveBeenCalled();
  });

  test("recreates the shared ACP client when a prior client was disposed", async () => {
    const disposedAcp = mockAcpClient();
    disposedAcp.ensureReady.mockRejectedValueOnce(
      new Error("AcpClient has been disposed"),
    );
    const freshAcp = mockAcpClient();
    freshAcp.newSession.mockResolvedValue("acp-sid-002");

    const backend = new KimiBackend({
      acpClient: disposedAcp as any,
      acpClientFactory: () => freshAcp as any,
    });
    let backendSid: string | null = null;
    let final: string | null = null;

    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })) {
      if (e.kind === "started") backendSid = e.backendSessionId;
      if (e.kind === "completed") final = e.finalMessage;
    }

    expect(disposedAcp.dispose).toHaveBeenCalled();
    expect(freshAcp.ensureReady).toHaveBeenCalled();
    expect(freshAcp.newSession).toHaveBeenCalled();
    expect(backendSid).toBe("acp-sid-002");
    expect(final).toBe("hi");
  });

  test("resume run does NOT call newSession", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    for await (const _ of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ backendSessionId: "acp-sid-001" }),
      prompt: "again",
    })) { /* drain */ }
    expect(acp.newSession).not.toHaveBeenCalled();
    expect(acp.prompt).toHaveBeenCalled();
  });

  test("resume run still emits started each turn (claude/codex title parity)", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    const events: Array<{ kind: string }> = [];
    for await (const e of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ backendSessionId: "acp-sid-001" }),
      prompt: "again",
    })) {
      events.push(e);
    }
    expect(events[0]).toMatchObject({ kind: "started", backendSessionId: "acp-sid-001" });
  });

  test("resume run loads persisted session into the current ACP process before prompting", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    for await (const _ of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ backendSessionId: "acp-sid-001" }),
      prompt: "again",
    })) { /* drain */ }

    expect(acp.loadSession).toHaveBeenCalledWith({
      sessionId: "acp-sid-001",
      cwd: "/tmp",
      mcpServers: [],
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
    const iter = backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "long" })[Symbol.asyncIterator]();
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

  test("probes the existing shared ACP without opening a business session", async () => {
    const acp = mockAcpClient();
    acp.getState = vi.fn().mockReturnValue("ready");
    acp.probeHealth = vi.fn().mockResolvedValue({ rttMs: 7 });
    const backend = new KimiBackend({ acpClient: acp as any });

    await expect(backend.probeAcpHealth()).resolves.toEqual({
      pid: 12345,
      state: "ready",
      roundtrip: { ok: true, rttMs: 7 },
    });
    expect(acp.ensureReady).toHaveBeenCalledTimes(1);
    expect(acp.probeHealth).toHaveBeenCalledTimes(1);
    expect(acp.newSession).not.toHaveBeenCalled();
    expect(acp.loadSession).not.toHaveBeenCalled();
  });
});

describe("KimiBackend per-run model selection", () => {
  test("session.model set → setSessionModel called before prompt", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    for await (const _ of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "kimi-code/k3" }),
      prompt: "hi",
    })) { /* drain */ }
    expect(acp.setSessionModel).toHaveBeenCalledWith({
      sessionId: "acp-sid-001",
      modelId: "kimi-code/k3",
    });
    expect(acp.setSessionModel.mock.invocationCallOrder[0]).toBeLessThan(
      acp.prompt.mock.invocationCallOrder[0],
    );
  });

  test("explicit execution tuple wins over session.model", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    for await (const _ of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "kimi-code/k3" }),
      execution: { backend: "kimi", model: "kimi-code/kimi-for-coding-highspeed", effort: null },
      prompt: "hi",
    })) { /* drain */ }
    expect(acp.setSessionModel).toHaveBeenCalledWith({
      sessionId: "acp-sid-001",
      modelId: "kimi-code/kimi-for-coding-highspeed",
    });
  });

  test("model null → setSessionModel actively resets to the Kimi default model (no K3 leak)", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    for await (const _ of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })) { /* drain */ }
    expect(acp.setSessionModel).toHaveBeenCalledWith({
      sessionId: "acp-sid-001",
      modelId: "kimi-code/kimi-for-coding",
    });
    expect(acp.setSessionModel.mock.invocationCallOrder[0]).toBeLessThan(
      acp.prompt.mock.invocationCallOrder[0],
    );
  });

  test("started event carries the execution model for the card title", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    const events: Array<{ kind: string; model?: string }> = [];
    for await (const e of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "kimi-code/k3" }),
      prompt: "hi",
    })) {
      events.push(e as { kind: string; model?: string });
    }
    expect(events.find((e) => e.kind === "started")?.model).toBe("kimi-code/k3");
  });

  test("model null → started reports the default model being applied", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    const events: Array<{ kind: string; model?: string }> = [];
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })) {
      events.push(e as { kind: string; model?: string });
    }
    expect(events.find((e) => e.kind === "started")?.model).toBe("kimi-code/kimi-for-coding");
    expect(acp.setSessionModel).toHaveBeenCalledWith({
      sessionId: "acp-sid-001",
      modelId: "kimi-code/kimi-for-coding",
    });
  });

  test("model null and no ACP observation → started still carries the default model", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    const events: Array<{ kind: string; model?: string }> = [];
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })) {
      events.push(e as { kind: string; model?: string });
    }
    const started = events.find((e) => e.kind === "started");
    expect(started?.model).toBe("kimi-code/kimi-for-coding");
  });

  test("setSessionModel failure → error event, prompt never sent", async () => {
    const acp = mockAcpClient();
    acp.setSessionModel = vi.fn().mockRejectedValue(new Error("Invalid params"));
    const backend = new KimiBackend({ acpClient: acp as any });
    const events: Array<{ kind: string; message?: string }> = [];
    for await (const e of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "kimi-code/k3" }),
      prompt: "hi",
    })) {
      events.push(e as { kind: string; message?: string });
    }
    const err = events.find((e) => e.kind === "error");
    expect(err?.message).toContain("set_model");
    expect(err?.message).toContain("kimi-code/k3");
    expect(acp.prompt).not.toHaveBeenCalled();
  });
});

describe("KimiBackend global default model (/model global kimi)", () => {
  beforeEach(() => resetConfiguredBackendRuntimeDefaultsForTests());
  afterEach(() => resetConfiguredBackendRuntimeDefaultsForTests());

  test("session.model null → the configured global kimi default is applied with its native thinking level", async () => {
    setConfiguredBackendRuntimeDefaults("kimi", { model: "kimi-code/k3" });
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    const started: Array<{ kind: string; model?: string }> = [];
    for await (const e of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession(),
      prompt: "hi",
    })) {
      started.push(e as { kind: string; model?: string });
    }
    expect(acp.setSessionModel).toHaveBeenCalledWith({
      sessionId: "acp-sid-001",
      modelId: "kimi-code/k3",
    });
    expect(acp.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "acp-sid-001",
      configId: "thinking",
      value: "high",
    });
    expect(started.find((e) => e.kind === "started")?.model).toBe("kimi-code/k3");
  });

  test("an explicit session model still wins over the configured global default", async () => {
    setConfiguredBackendRuntimeDefaults("kimi", { model: "kimi-code/k3" });
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    for await (const _ of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "kimi-code/kimi-for-coding-highspeed" }),
      prompt: "hi",
    })) { /* drain */ }
    expect(acp.setSessionModel).toHaveBeenCalledWith({
      sessionId: "acp-sid-001",
      modelId: "kimi-code/kimi-for-coding-highspeed",
    });
    expect(acp.setSessionConfigOption).not.toHaveBeenCalled();
  });

  test("clearing the global default returns a model-less session to KIMI_DEFAULT_MODEL", async () => {
    setConfiguredBackendRuntimeDefaults("kimi", { model: "kimi-code/k3" });
    setConfiguredBackendRuntimeDefaults("kimi", { model: null });
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    for await (const _ of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession(),
      prompt: "hi",
    })) { /* drain */ }
    expect(acp.setSessionModel).toHaveBeenCalledWith({
      sessionId: "acp-sid-001",
      modelId: "kimi-code/kimi-for-coding",
    });
    expect(acp.setSessionConfigOption).not.toHaveBeenCalled();
  });
});

describe("KimiBackend per-run thinking level (kimi-code 0.30.0)", () => {
  test("K3 session with explicit effort applies thinking via session/set_config_option after model, before prompt", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    for await (const _ of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "kimi-code/k3", effort: "low" }),
      prompt: "hi",
    })) { /* drain */ }
    expect(acp.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "acp-sid-001",
      configId: "thinking",
      value: "low",
    });
    expect(acp.setSessionModel.mock.invocationCallOrder[0]).toBeLessThan(
      acp.setSessionConfigOption.mock.invocationCallOrder[0],
    );
    expect(acp.setSessionConfigOption.mock.invocationCallOrder[0]).toBeLessThan(
      acp.prompt.mock.invocationCallOrder[0],
    );
  });

  test("K3 session with default effort still applies native high so a reused ACP session cannot retain an earlier override", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    for await (const _ of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "kimi-code/k3", effort: null }),
      prompt: "hi",
    })) { /* drain */ }
    expect(acp.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "acp-sid-001",
      configId: "thinking",
      value: "high",
    });
  });

  test("K3 session maps a requested level through official compatibility at execution", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    for await (const _ of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "kimi-code/k3", effort: "xhigh" }),
      prompt: "hi",
    })) { /* drain */ }
    expect(acp.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "acp-sid-001",
      configId: "thinking",
      value: "max",
    });
  });

  test("K2.7 session never calls session/set_config_option (fixed on)", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    for await (const _ of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "kimi-code/kimi-for-coding", effort: null }),
      prompt: "hi",
    })) { /* drain */ }
    expect(acp.setSessionConfigOption).not.toHaveBeenCalled();
    expect(acp.prompt).toHaveBeenCalled();
  });

  test("model null resets a reused ACP session from K3 back to the default model (no K3/thinking leak)", async () => {
    const acp = mockAcpClient();
    // The shared ACP session previously ran K3 (configOptions observation).
    acp.getSessionModel = vi.fn().mockReturnValue("kimi-code/k3");
    const backend = new KimiBackend({ acpClient: acp as any });
    for await (const _ of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: null, effort: null }),
      prompt: "hi",
    })) { /* drain */ }
    // model=null is an explicit default: the backend must actively re-apply
    // the K2.7 default model instead of inheriting the observed K3…
    expect(acp.setSessionModel).toHaveBeenCalledWith({
      sessionId: "acp-sid-001",
      modelId: "kimi-code/kimi-for-coding",
    });
    // …and must NOT send a thinking level derived from the stale K3
    // observation (K2.7 is fixed-on and would reject it).
    expect(acp.setSessionConfigOption).not.toHaveBeenCalled();
    expect(acp.prompt).toHaveBeenCalled();
  });

  test("same ACP session K3 then default: the default run re-applies the default model and skips thinking", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    // Run 1: explicit K3 on the persisted ACP session.
    for await (const _ of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "kimi-code/k3", effort: null, backendSessionId: "acp-sid-001" }),
      prompt: "k3 run",
    })) { /* drain */ }
    // Run 2: same ACP session, model back to default.
    for await (const _ of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: null, effort: null, backendSessionId: "acp-sid-001" }),
      prompt: "default run",
    })) { /* drain */ }
    expect(acp.setSessionModel.mock.calls).toEqual([
      [{ sessionId: "acp-sid-001", modelId: "kimi-code/k3" }],
      [{ sessionId: "acp-sid-001", modelId: "kimi-code/kimi-for-coding" }],
    ]);
    // Thinking was applied exactly once — the K3 run's native default high;
    // the default-model run derives its level from the actual effective
    // model (K2.7 fixed-on) and never touches set_config_option.
    expect(acp.setSessionConfigOption.mock.calls).toEqual([
      [{ sessionId: "acp-sid-001", configId: "thinking", value: "high" }],
    ]);
    expect(acp.prompt).toHaveBeenCalledTimes(2);
  });

  test("model null with ACP-observed K2.7 skips the thinking call", async () => {
    const acp = mockAcpClient();
    acp.getSessionModel = vi.fn().mockReturnValue("kimi-code/kimi-for-coding");
    const backend = new KimiBackend({ acpClient: acp as any });
    for await (const _ of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: null, effort: null }),
      prompt: "hi",
    })) { /* drain */ }
    expect(acp.setSessionConfigOption).not.toHaveBeenCalled();
  });

  test("model null with ACP-observed K2.7 never applies a stale persisted effort (fixed on)", async () => {
    const acp = mockAcpClient();
    acp.getSessionModel = vi.fn().mockReturnValue("kimi-code/kimi-for-coding");
    const backend = new KimiBackend({ acpClient: acp as any });
    for await (const _ of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: null, effort: "high" }),
      prompt: "hi",
    })) { /* drain */ }
    expect(acp.setSessionConfigOption).not.toHaveBeenCalled();
    expect(acp.prompt).toHaveBeenCalled();
  });

  test("model null and no ACP observation skips the thinking call", async () => {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    for await (const _ of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })) { /* drain */ }
    expect(acp.setSessionConfigOption).not.toHaveBeenCalled();
  });

  test("setSessionConfigOption failure prevents the prompt and surfaces a precise error", async () => {
    const acp = mockAcpClient();
    acp.setSessionConfigOption = vi.fn().mockRejectedValue(new Error("ACP error -32602: Invalid params"));
    const backend = new KimiBackend({ acpClient: acp as any });
    const events: Array<{ kind: string; message?: string }> = [];
    for await (const e of backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "kimi-code/k3", effort: "low" }),
      prompt: "hi",
    })) {
      events.push(e as { kind: string; message?: string });
    }
    const err = events.find((e) => e.kind === "error");
    expect(err?.message).toContain("set_config_option");
    expect(err?.message).toContain("thinking=low");
    expect(err?.message).toContain("-32602");
    expect(acp.prompt).not.toHaveBeenCalled();
  });
});

describe("KimiBackend native image attachments", () => {
  function mkAttachment(dir: string, name: string, bytes: Buffer, mimeType?: string): AttachmentRef {
    const p = join(dir, name);
    writeFileSync(p, bytes);
    return {
      kind: "image",
      localPath: asAbsolutePath(p),
      originalName: name,
      mimeType,
      uploadedAt: asTimestamp(1),
    };
  }

  async function capturedBlocks(attachments: AttachmentRef[]) {
    const acp = mockAcpClient();
    const backend = new KimiBackend({ acpClient: acp as any });
    for await (const _ of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "look", attachments })) {
      /* drain */
    }
    return (acp.prompt.mock.calls[0]![0] as unknown as {
      blocks: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }>;
    }).blocks;
  }

  test("png attachment becomes a native image block before the prompt text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-img-"));
    const bytes = Buffer.from("89504e470d0a1a0a", "hex");
    const blocks = await capturedBlocks([mkAttachment(dir, "shot.png", bytes, "image/png")]);
    expect(blocks[0]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: bytes.toString("base64"),
    });
    expect(blocks[1]?.type).toBe("text");
    expect((blocks[1] as { text: string }).text).not.toContain("[Attachments]");
  });

  test("mime inferred from extension when mimeType missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-img-"));
    const blocks = await capturedBlocks([mkAttachment(dir, "photo.jpg", Buffer.from("ff", "hex"))]);
    expect(blocks[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
  });

  test("oversized image falls back to text description", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-img-"));
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    const blocks = await capturedBlocks([mkAttachment(dir, "big.png", big, "image/png")]);
    expect(blocks.every((b) => b.type === "text")).toBe(true);
    expect((blocks[0] as { text: string }).text).toContain("[Attachments]");
    expect((blocks[0] as { text: string }).text).toContain("big.png");
  });

  test("non-image file stays a text description", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-img-"));
    const p = join(dir, "notes.txt");
    writeFileSync(p, "hello");
    const att: AttachmentRef = {
      kind: "file",
      localPath: asAbsolutePath(p),
      originalName: "notes.txt",
      uploadedAt: asTimestamp(1),
    };
    const blocks = await capturedBlocks([att]);
    expect(blocks.every((b) => b.type === "text")).toBe(true);
    expect((blocks[0] as { text: string }).text).toContain("notes.txt");
  });
});

describe("KimiBackend timeout handling", () => {
  // Prompt that never emits updates and only finishes once the ACP turn is
  // cancelled — stands in for a stuck / very long turn.
  function mockHangingAcp() {
    const acp = mockAcpClient();
    let cancelled = false;
    acp.cancel = vi.fn(async () => {
      cancelled = true;
    });
    acp.prompt = vi.fn(async () => {
      for (let i = 0; i < 200 && !cancelled; i++) {
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      return { stopReason: cancelled ? "cancelled" : "end_turn" };
    });
    return acp;
  }

  async function drainEvents(
    iter: AsyncIterator<{ kind: string; message?: string }>,
  ): Promise<Array<{ kind: string; message?: string }>> {
    const events: Array<{ kind: string; message?: string }> = [];
    while (true) {
      const { value, done } = await iter.next();
      if (done) break;
      events.push(value);
    }
    return events;
  }

  test("maxRuntimeS reached → '[TIMEOUT] max runtime' error, not a cancel label", async () => {
    const acp = mockHangingAcp();
    const backend = new KimiBackend({ acpClient: acp as any });
    const events = await drainEvents(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession({ maxRuntimeS: 1 }), prompt: "long" })[
        Symbol.asyncIterator
      ](),
    );
    expect(acp.cancel).toHaveBeenCalled();
    const err = events.find((e) => e.kind === "error");
    expect(err?.message).toBe("[TIMEOUT] max runtime: exceeded 1s");
    expect(events.some((e) => e.message === "cancelled by user")).toBe(false);
    // completed still emitted so dispatcher/replier can finalise the run
    expect(events.some((e) => e.kind === "completed")).toBe(true);
  }, 15000);

  test("confirmed idle process tree → inactivity cancellation still fires", async () => {
    const acp = mockHangingAcp();
    const backend = new KimiBackend({
      acpClient: acp as any,
      activityProbe: async () => false, // process tree idle → legacy kill
    });
    const events = await drainEvents(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession({ inactivityTimeoutS: 1 }), prompt: "long" })[
        Symbol.asyncIterator
      ](),
    );
    expect(acp.cancel).toHaveBeenCalled();
    const err = events.find((e) => e.kind === "error");
    expect(err?.message).toBe("[TIMEOUT] inactivity: no output for 1s");
    expect(events.some((e) => e.message === "cancelled by user")).toBe(false);
  }, 15000);

  test("maxRuntimeS null + inactivity disabled → no wall-clock kill (was a hidden 600s default)", async () => {
    const acp = mockAcpClient();
    acp.prompt = vi.fn(
      async ({ onUpdate }: { onUpdate: (u: unknown) => void }) => {
        onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
        // Outlives both the old 600s hidden default and the 900s inactivity default.
        await new Promise<void>((r) => setTimeout(r, 901_000));
        return { stopReason: "end_turn" };
      },
    );
    const backend = new KimiBackend({ acpClient: acp as any });
    const iter = backend.run({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ maxRuntimeS: null, inactivityTimeoutS: 0 }),
      prompt: "long",
    })[Symbol.asyncIterator]();
    const first = await iter.next(); // started event, real timers still active
    expect(first.done).toBe(false);
    vi.useFakeTimers();
    try {
      const drained = drainEvents(iter);
      await vi.advanceTimersByTimeAsync(950_000);
      const events = await drained;
      expect(acp.cancel).not.toHaveBeenCalled();
      expect(events.some((e) => e.kind === "completed")).toBe(true);
      expect(events.some((e) => e.kind === "error")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  }, 15000);

  test("user cancel surfaces canonical 'cancelled by user'", async () => {
    const acp = mockHangingAcp();
    const backend = new KimiBackend({ acpClient: acp as any });
    const session = mkSession({ id: asSessionId("s9"), backendSessionId: "acp-sid-009" });
    const iter = backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "long" })[Symbol.asyncIterator]();
    setTimeout(() => {
      backend.cancel(session.id).catch(() => {});
    }, 100);
    const events = await drainEvents(iter);
    expect(acp.cancel).toHaveBeenCalledWith("acp-sid-009");
    const err = events.find((e) => e.kind === "error");
    expect(err?.message).toBe("cancelled by user");
    expect(events.some((e) => e.kind === "completed")).toBe(true);
  }, 15000);

  test("user cancel before maxRuntime fires keeps the cancel label and fires acp.cancel only once", async () => {
    const acp = mockHangingAcp();
    const backend = new KimiBackend({ acpClient: acp as any });
    const session = mkSession({ id: asSessionId("s10"), backendSessionId: "acp-sid-010", maxRuntimeS: 1 });
    const iter = backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "long" })[Symbol.asyncIterator]();
    setTimeout(() => {
      backend.cancel(session.id).catch(() => {});
    }, 100); // user cancel at ~0.1s, maxRuntime would fire at 1s
    const events = await drainEvents(iter);
    expect(acp.cancel).toHaveBeenCalledTimes(1);
    const err = events.find((e) => e.kind === "error");
    expect(err?.message).toBe("cancelled by user");
  }, 15000);

  test("maxRuntime vs inactivity race: first timeout wins, acp.cancel called exactly once", async () => {
    const acp = mockHangingAcp();
    const backend = new KimiBackend({ acpClient: acp as any });
    const events = await drainEvents(
      backend.run({
        messageRunId: TEST_MESSAGE_RUN_ID,
        session: mkSession({ maxRuntimeS: 1, inactivityTimeoutS: 2 }),
        prompt: "long",
      })[Symbol.asyncIterator](),
    );
    expect(acp.cancel).toHaveBeenCalledTimes(1);
    const err = events.find((e) => e.kind === "error");
    expect(err?.message).toBe("[TIMEOUT] max runtime: exceeded 1s");
  }, 15000);

  test("after an inactivity kill, late ACP updates do not re-arm the timer (no second cancel)", async () => {
    const acp = mockAcpClient();
    let cancelled = false;
    acp.cancel = vi.fn(async () => {
      cancelled = true;
    });
    acp.prompt = vi.fn(async ({ onUpdate }: { onUpdate: (u: unknown) => void }) => {
      // Silent until the 1s inactivity kill fires, then emit a late update
      // (would re-arm the timer if the guard were missing), then linger long
      // enough that a re-armed 1s timer would fire a second cancel.
      for (let i = 0; i < 30 && !cancelled; i++) {
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } });
      await new Promise<void>((r) => setTimeout(r, 1500));
      return { stopReason: "cancelled" };
    });
    const backend = new KimiBackend({
      acpClient: acp as any,
      activityProbe: async () => false, // process tree idle → legacy kill
    });
    const events = await drainEvents(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession({ inactivityTimeoutS: 1 }), prompt: "long" })[
        Symbol.asyncIterator
      ](),
    );
    expect(acp.cancel).toHaveBeenCalledTimes(1);
    const err = events.find((e) => e.kind === "error");
    expect(err?.message).toBe("[TIMEOUT] inactivity: no output for 1s");
  }, 15000);

  test("silent turn with an active process tree → watchdog re-arms instead of killing", async () => {
    const acp = mockAcpClient();
    acp.prompt = vi.fn(async ({ onUpdate }: { onUpdate: (u: unknown) => void }) => {
      // Silent across two 1s inactivity windows (a working subagent), then finish.
      await new Promise<void>((r) => setTimeout(r, 2300));
      onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
      return { stopReason: "end_turn" };
    });
    const probe = vi.fn(async (_pid: number) => true);
    const backend = new KimiBackend({ acpClient: acp as any, activityProbe: probe });
    const events = await drainEvents(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession({ inactivityTimeoutS: 1 }), prompt: "long" })[
        Symbol.asyncIterator
      ](),
    );
    expect(probe).toHaveBeenCalledWith(12345);
    expect(acp.cancel).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === "error")).toBe(false);
    expect(events.some((e) => e.kind === "completed")).toBe(true);
  }, 15000);

  test.each([
    ["rejection", "ps exited with ENOENT"],
    ["timeout rejection", "activity probe timed out after 5000ms"],
  ])("active ACP turn: %s activity probe re-arms instead of cancelling", async (_kind, reason) => {
    const acp = mockAcpClient();
    acp.prompt = vi.fn(async ({ onUpdate }: { onUpdate: (u: unknown) => void }) => {
      // Cross two inactivity windows while the active ACP turn remains silent.
      // A probe failure must re-arm both windows rather than cancel this turn.
      await new Promise<void>((r) => setTimeout(r, 2300));
      onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
      return { stopReason: "end_turn" };
    });
    const probe = vi.fn(async () => {
      throw new Error(reason);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const backend = new KimiBackend({ acpClient: acp as any, activityProbe: probe });
      const events = await drainEvents(
        backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession({ inactivityTimeoutS: 1 }), prompt: "long" })[
          Symbol.asyncIterator
        ](),
      );

      expect(probe).toHaveBeenCalledTimes(2);
      expect(acp.cancel).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "[kimi-acp inactivity probe unknown; re-arming]",
        expect.objectContaining({ pid: 12345, reason }),
      );
      expect(events.some((e) => e.kind === "error")).toBe(false);
      expect(events.some((e) => e.kind === "completed")).toBe(true);
    } finally {
      warn.mockRestore();
    }
  }, 15000);

  test("watchdog re-arm is not permanent: kills once the process tree goes idle", async () => {
    const acp = mockHangingAcp();
    let probeCalls = 0;
    const probe = vi.fn(async () => ++probeCalls === 1); // busy once, idle afterwards
    const backend = new KimiBackend({ acpClient: acp as any, activityProbe: probe });
    const events = await drainEvents(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession({ inactivityTimeoutS: 1 }), prompt: "long" })[
        Symbol.asyncIterator
      ](),
    );
    expect(probe).toHaveBeenCalledTimes(2);
    expect(acp.cancel).toHaveBeenCalledTimes(1);
    const err = events.find((e) => e.kind === "error");
    expect(err?.message).toBe("[TIMEOUT] inactivity: no output for 1s");
  }, 15000);

  test("an ACP update arriving during the activity probe keeps the turn alive (no stale kill)", async () => {
    const acp = mockAcpClient();
    acp.prompt = vi.fn(async ({ onUpdate }: { onUpdate: (u: unknown) => void }) => {
      // Crosses the 1s fire point, then produces output while the probe is
      // still running — the update re-arms the timer and must win over the
      // probe's idle verdict.
      await new Promise<void>((r) => setTimeout(r, 1200));
      onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
      return { stopReason: "end_turn" };
    });
    const probe = vi.fn(async () => {
      await new Promise<void>((r) => setTimeout(r, 400));
      return false;
    });
    const backend = new KimiBackend({ acpClient: acp as any, activityProbe: probe });
    const events = await drainEvents(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession({ inactivityTimeoutS: 1 }), prompt: "long" })[
        Symbol.asyncIterator
      ](),
    );
    expect(acp.cancel).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === "error")).toBe(false);
    expect(events.some((e) => e.kind === "completed")).toBe(true);
  }, 15000);

  test("timeout fired first keeps [TIMEOUT] label when the user cancels afterwards", async () => {
    const acp = mockHangingAcp();
    const backend = new KimiBackend({ acpClient: acp as any });
    const session = mkSession({ id: asSessionId("s11"), backendSessionId: "acp-sid-011", maxRuntimeS: 1 });
    const iter = backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "long" })[Symbol.asyncIterator]();
    setTimeout(() => {
      backend.cancel(session.id).catch(() => {});
    }, 1300); // after the 1s maxRuntime kill
    const events = await drainEvents(iter);
    const err = events.find((e) => e.kind === "error");
    expect(err?.message).toBe("[TIMEOUT] max runtime: exceeded 1s");
  }, 15000);

  test("timeout fired but ACP settles with end_turn → still labelled [TIMEOUT], not success", async () => {
    const acp = mockAcpClient();
    let cancelled = false;
    acp.cancel = vi.fn(async () => {
      cancelled = true;
    });
    acp.prompt = vi.fn(async () => {
      for (let i = 0; i < 200 && !cancelled; i++) {
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      return { stopReason: "end_turn" }; // kimi may settle normally after the kill
    });
    const backend = new KimiBackend({ acpClient: acp as any });
    const events = await drainEvents(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession({ maxRuntimeS: 1 }), prompt: "long" })[
        Symbol.asyncIterator
      ](),
    );
    const err = events.find((e) => e.kind === "error");
    expect(err?.message).toBe("[TIMEOUT] max runtime: exceeded 1s");
    expect(events.some((e) => e.kind === "assistant_message" && e.message !== "")).toBe(false);
  }, 15000);

  test("user cancel with ACP settling as end_turn → still labelled 'cancelled by user', not success", async () => {
    const acp = mockAcpClient();
    let cancelled = false;
    acp.cancel = vi.fn(async () => {
      cancelled = true;
    });
    acp.prompt = vi.fn(async () => {
      for (let i = 0; i < 200 && !cancelled; i++) {
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      return { stopReason: "end_turn" };
    });
    const backend = new KimiBackend({ acpClient: acp as any });
    const session = mkSession({ id: asSessionId("s13"), backendSessionId: "acp-sid-013" });
    const iter = backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "long" })[Symbol.asyncIterator]();
    setTimeout(() => {
      backend.cancel(session.id).catch(() => {});
    }, 100);
    const events = await drainEvents(iter);
    const err = events.find((e) => e.kind === "error");
    expect(err?.message).toBe("cancelled by user");
  }, 15000);

  test("timeout fired but prompt rejects → [TIMEOUT] wins over the rejection error", async () => {
    const acp = mockAcpClient();
    let cancelled = false;
    acp.cancel = vi.fn(async () => {
      cancelled = true;
    });
    acp.prompt = vi.fn(async () => {
      for (let i = 0; i < 200 && !cancelled; i++) {
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      throw new Error("synthetic prompt rejection");
    });
    const backend = new KimiBackend({ acpClient: acp as any });
    const events = await drainEvents(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession({ maxRuntimeS: 1 }), prompt: "long" })[
        Symbol.asyncIterator
      ](),
    );
    const err = events.find((e) => e.kind === "error");
    expect(err?.message).toBe("[TIMEOUT] max runtime: exceeded 1s");
  }, 15000);

  test("user cancel landing between timeout fire and prompt settle does not double-cancel", async () => {
    const acp = mockAcpClient();
    let cancelled = false;
    acp.cancel = vi.fn(async () => {
      cancelled = true;
    });
    acp.prompt = vi.fn(async () => {
      for (let i = 0; i < 200 && !cancelled; i++) {
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      // Stay in-flight a bit longer so the user cancel lands while inflight
      // is still registered (T800's 20/40/100ms probe window).
      await new Promise<void>((r) => setTimeout(r, 500));
      return { stopReason: "cancelled" };
    });
    const backend = new KimiBackend({ acpClient: acp as any });
    const session = mkSession({ id: asSessionId("s14"), backendSessionId: "acp-sid-014", maxRuntimeS: 1 });
    const iter = backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "long" })[Symbol.asyncIterator]();
    setTimeout(() => {
      backend.cancel(session.id).catch(() => {});
    }, 1100); // after the 1s maxRuntime fire, before the ~1.5s prompt settle
    const events = await drainEvents(iter);
    expect(acp.cancel).toHaveBeenCalledTimes(1);
    const err = events.find((e) => e.kind === "error");
    expect(err?.message).toBe("[TIMEOUT] max runtime: exceeded 1s");
  }, 15000);

  test("timeout kill still flushes pending thinking and pending tool calls", async () => {
    const acp = mockAcpClient();
    let cancelled = false;
    acp.cancel = vi.fn(async () => {
      cancelled = true;
    });
    acp.prompt = vi.fn(async ({ onUpdate }: { onUpdate: (u: unknown) => void }) => {
      onUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking about it" } });
      onUpdate({ sessionUpdate: "tool_call", toolCallId: "tc1", title: "Shell", status: "in_progress", content: [] });
      onUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: '{"command": "ls' } }],
      });
      for (let i = 0; i < 200 && !cancelled; i++) {
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      return { stopReason: "cancelled" };
    });
    const backend = new KimiBackend({ acpClient: acp as any });
    const events = await drainEvents(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession({ maxRuntimeS: 1 }), prompt: "long" })[
        Symbol.asyncIterator
      ](),
    );
    const kinds = events.map((e) => e.kind);
    const thinkingIdx = kinds.indexOf("thinking");
    const toolCallIdx = kinds.indexOf("tool_call");
    const errorIdx = kinds.indexOf("error");
    expect(thinkingIdx).toBeGreaterThanOrEqual(0);
    expect(toolCallIdx).toBeGreaterThan(thinkingIdx);
    expect(errorIdx).toBeGreaterThan(toolCallIdx);
    expect(events[errorIdx]?.message).toBe("[TIMEOUT] max runtime: exceeded 1s");
    expect((events[toolCallIdx] as { name?: string }).name).toBe("Shell");
  }, 15000);
});

describe("KimiBackend token usage", () => {
  function mockUsageTracker(usage: {
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    recordCount: number;
  } | null) {
    return {
      beginTurn: vi.fn(async (_sessionId: string) => {}),
      collectTurnUsage: vi.fn(async (_sessionId: string) => usage),
    };
  }

  test("a turn emits one aggregated usage event from the wire tracker", async () => {
    const acp = mockAcpClient();
    const tracker = mockUsageTracker({
      model: "kimi-code/k3",
      inputTokens: 500,
      outputTokens: 50,
      cacheReadTokens: 3000,
      cacheWriteTokens: 0,
      recordCount: 2,
    });
    const backend = new KimiBackend({ acpClient: acp as any, usageTracker: tracker });
    const events: Array<{ kind: string } & Record<string, unknown>> = [];
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })) {
      events.push(e as { kind: string } & Record<string, unknown>);
    }
    expect(tracker.beginTurn).toHaveBeenCalledWith("acp-sid-001");
    expect(tracker.collectTurnUsage).toHaveBeenCalledWith("acp-sid-001");
    const usage = events.find((e) => e.kind === "usage");
    expect(usage).toMatchObject({
      model: "kimi-code/k3",
      inputTokens: 500,
      outputTokens: 50,
      cacheReadTokens: 3000,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
    // usage rides along even on a normal completion
    expect(events.some((e) => e.kind === "completed")).toBe(true);
  });

  test("no wire records → no usage event, run unaffected", async () => {
    const acp = mockAcpClient();
    const tracker = mockUsageTracker(null);
    const backend = new KimiBackend({ acpClient: acp as any, usageTracker: tracker });
    const events: Array<{ kind: string }> = [];
    for await (const e of backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })) {
      events.push(e);
    }
    expect(events.some((e) => e.kind === "usage")).toBe(false);
    expect(events.some((e) => e.kind === "completed")).toBe(true);
  });

  test("usage is still collected when the turn is cancelled", async () => {
    const acp = mockAcpClient();
    let cancelled = false;
    acp.cancel = vi.fn(async () => {
      cancelled = true;
    });
    acp.prompt = vi.fn(async () => {
      for (let i = 0; i < 200 && !cancelled; i++) {
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      return { stopReason: cancelled ? "cancelled" : "end_turn" };
    });
    const tracker = mockUsageTracker({
      model: "kimi-code/k3",
      inputTokens: 42,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      recordCount: 1,
    });
    const backend = new KimiBackend({ acpClient: acp as any, usageTracker: tracker });
    const session = mkSession({ id: asSessionId("s12"), backendSessionId: "acp-sid-012" });
    const iter = backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "long" })[Symbol.asyncIterator]();
    setTimeout(() => {
      backend.cancel(session.id).catch(() => {});
    }, 100);
    const events: Array<{ kind: string }> = [];
    while (true) {
      const { value, done } = await iter.next();
      if (done) break;
      events.push(value);
    }
    expect(events.some((e) => e.kind === "usage")).toBe(true);
  }, 15000);
});

describe("KimiBackend turn-active retry", () => {
  const TURN_ACTIVE_ERR = new Error(
    "Invalid request: Cannot launch a new turn while another turn (ID 2) is active",
  );

  async function drainAll(
    iter: AsyncIterator<{ kind: string; message?: string }>,
  ): Promise<Array<{ kind: string; message?: string }>> {
    const events: Array<{ kind: string; message?: string }> = [];
    while (true) {
      const { value, done } = await iter.next();
      if (done) break;
      events.push(value);
    }
    return events;
  }

  test("prompt rejected once by an autonomous turn → waits, retries, completes", async () => {
    const acp = mockAcpClient();
    let calls = 0;
    acp.prompt = vi.fn(async ({ onUpdate }: { onUpdate: (u: unknown) => void }) => {
      calls++;
      if (calls === 1) throw TURN_ACTIVE_ERR;
      onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
      return { stopReason: "end_turn" };
    });
    const backend = new KimiBackend({ acpClient: acp as any, turnActiveRetryDelayMs: 10 });
    const events = await drainAll(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })[Symbol.asyncIterator](),
    );
    expect(calls).toBe(2);
    expect(events.some((e) => e.kind === "completed")).toBe(true);
    expect(events.some((e) => e.kind === "error")).toBe(false);
  }, 15000);

  test("session permanently busy → original turn-active error surfaces after bounded retries", async () => {
    const acp = mockAcpClient();
    let calls = 0;
    acp.prompt = vi.fn(async () => {
      calls++;
      throw TURN_ACTIVE_ERR;
    });
    const backend = new KimiBackend({ acpClient: acp as any, turnActiveRetryDelayMs: 10 });
    const events = await drainAll(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })[Symbol.asyncIterator](),
    );
    expect(calls).toBe(31); // 1 initial + 30 bounded retries
    const err = events.find((e) => e.kind === "error");
    expect(err?.message).toContain("Cannot launch a new turn while another turn");
  }, 15000);

  test("kimi 0.33 driver-busy error text (\"another turn is already in progress\") is retried", async () => {
    const acp = mockAcpClient();
    let calls = 0;
    acp.prompt = vi.fn(async ({ onUpdate }: { onUpdate: (u: unknown) => void }) => {
      calls++;
      // kimi-code 0.33.0's second busy-rejection path (driver not settled);
      // 2026-08-07 aftersale-web runs failed in 2s when this text was unmatched.
      if (calls === 1) throw new Error("Invalid request: another turn is already in progress");
      onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
      return { stopReason: "end_turn" };
    });
    const backend = new KimiBackend({ acpClient: acp as any, turnActiveRetryDelayMs: 10 });
    const events = await drainAll(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })[Symbol.asyncIterator](),
    );
    expect(calls).toBe(2);
    expect(events.some((e) => e.kind === "completed")).toBe(true);
    expect(events.some((e) => e.kind === "error")).toBe(false);
  }, 15000);

  test("non-turn-active prompt errors are not retried", async () => {
    const acp = mockAcpClient();
    let calls = 0;
    acp.prompt = vi.fn(async () => {
      calls++;
      throw new Error("some other ACP failure");
    });
    const backend = new KimiBackend({ acpClient: acp as any, turnActiveRetryDelayMs: 10 });
    const events = await drainAll(
      backend.run({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" })[Symbol.asyncIterator](),
    );
    expect(calls).toBe(1);
    expect(events.find((e) => e.kind === "error")?.message).toContain("some other ACP failure");
  }, 15000);
});
