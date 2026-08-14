import { describe, expect, it, vi } from "vitest";
import { recoverKimiResumeStream } from "../../src/app/kimiResumeRecovery.ts";
import type { AgentEvent } from "../../src/domain/events/agentEvent.ts";
import { asMessageRunId, asAbsolutePath, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";
import type { RunInput } from "../../src/ports/AgentBackend.ts";

const TEST_MESSAGE_RUN_ID = asMessageRunId("mr_test");

const PERSISTED_ID = "e55e28d9-d58d-4940-8e9b-78e0d1b7f33c";
const STALE_ERROR = `Invalid params: Unknown sessionId: ${PERSISTED_ID}`;

function makeSession(backendSessionId: string | null): Session {
  return {
    id: asSessionId("sess_kimi"),
    name: "kimi-session",
    alias: "",
    avatar: "",
    category: "",
    fpManaged: null,
    scope: "user",
    backend: "kimi",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/tmp/work"),
    backendSessionId,
    chatName: null,
    purpose: "testing",
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
    createdAt: asTimestamp(100),
    updatedAt: asTimestamp(100),
  };
}

function makeRunInput(): RunInput {
  return { messageRunId: TEST_MESSAGE_RUN_ID, session: makeSession(PERSISTED_ID), prompt: "hello" };
}

type Attempt = { kind: "events"; events: AgentEvent[] } | { kind: "throw"; error: Error };

function makeRun(attempts: Attempt[]) {
  const calls: RunInput[] = [];
  const run = (input: RunInput): AsyncIterable<AgentEvent> => {
    const attempt = attempts[calls.length] ?? { kind: "events" as const, events: [] };
    calls.push(input);
    if (attempt.kind === "throw") {
      const error = attempt.error;
      return (async function* (): AsyncGenerator<AgentEvent> {
        throw error;
      })();
    }
    const events = attempt.events;
    return (async function* (): AsyncGenerator<AgentEvent> {
      for (const event of events) yield event;
    })();
  };
  return { run, calls };
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("recoverKimiResumeStream", () => {
  it("retries once with a fresh session when the resume id is rejected before any work signal", async () => {
    const { run, calls } = makeRun([
      { kind: "events", events: [{ kind: "error", message: STALE_ERROR, recoverable: false }] },
      {
        kind: "events",
        events: [
          { kind: "started", backendSessionId: "new-id" },
          { kind: "assistant_message", text: "hi", final: false },
          { kind: "completed", finalMessage: "hi" },
        ],
      },
    ]);
    const clearPersisted = vi.fn(async () => {});

    const events = await collect(recoverKimiResumeStream({
      run,
      runInput: makeRunInput(),
      persistedBackendSessionId: PERSISTED_ID,
      clearPersisted,
    }));

    expect(calls).toHaveLength(2);
    expect(calls[0]!.session.backendSessionId).toBe(PERSISTED_ID);
    expect(calls[1]!.session.backendSessionId).toBeNull();
    expect(clearPersisted).toHaveBeenCalledTimes(1);
    // Notice is surfaced, the original error is swallowed, replay events pass through.
    expect(events[0]).toEqual({
      kind: "assistant_message",
      text: "⚠️ kimi 会话已失效（可能因账号切换），正在自动开启新会话重试…",
      final: false,
    });
    expect(events.slice(1)).toEqual([
      { kind: "started", backendSessionId: "new-id" },
      { kind: "assistant_message", text: "hi", final: false },
      { kind: "completed", finalMessage: "hi" },
    ]);
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });

  it("passes the error through when a work signal already happened", async () => {
    const { run, calls } = makeRun([
      {
        kind: "events",
        events: [
          { kind: "assistant_message", text: "partial", final: false },
          { kind: "error", message: STALE_ERROR, recoverable: false },
        ],
      },
    ]);
    const clearPersisted = vi.fn(async () => {});

    const events = await collect(recoverKimiResumeStream({
      run,
      runInput: makeRunInput(),
      persistedBackendSessionId: PERSISTED_ID,
      clearPersisted,
    }));

    expect(calls).toHaveLength(1);
    expect(clearPersisted).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: "assistant_message", text: "partial", final: false },
      { kind: "error", message: STALE_ERROR, recoverable: false },
    ]);
  });

  it("does not retry when the error names a different session id", async () => {
    const otherError = "Invalid params: Unknown sessionId: some-other-id";
    const { run, calls } = makeRun([
      { kind: "events", events: [{ kind: "error", message: otherError, recoverable: false }] },
    ]);
    const clearPersisted = vi.fn(async () => {});

    const events = await collect(recoverKimiResumeStream({
      run,
      runInput: makeRunInput(),
      persistedBackendSessionId: PERSISTED_ID,
      clearPersisted,
    }));

    expect(calls).toHaveLength(1);
    expect(clearPersisted).not.toHaveBeenCalled();
    expect(events).toEqual([{ kind: "error", message: otherError, recoverable: false }]);
  });

  it("also recovers when the iterator throws the stale-id error (loadSession path)", async () => {
    const { run, calls } = makeRun([
      { kind: "throw", error: new Error(STALE_ERROR) },
      { kind: "events", events: [{ kind: "completed", finalMessage: "ok" }] },
    ]);
    const clearPersisted = vi.fn(async () => {});

    const events = await collect(recoverKimiResumeStream({
      run,
      runInput: makeRunInput(),
      persistedBackendSessionId: PERSISTED_ID,
      clearPersisted,
    }));

    expect(calls).toHaveLength(2);
    expect(calls[1]!.session.backendSessionId).toBeNull();
    expect(clearPersisted).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      {
        kind: "assistant_message",
        text: "⚠️ kimi 会话已失效（可能因账号切换），正在自动开启新会话重试…",
        final: false,
      },
      { kind: "completed", finalMessage: "ok" },
    ]);
  });

  it("surfaces the replay's own error without a third attempt", async () => {
    const replayError = { kind: "error", message: "boom", recoverable: false } as AgentEvent;
    const { run, calls } = makeRun([
      { kind: "events", events: [{ kind: "error", message: STALE_ERROR, recoverable: false }] },
      { kind: "events", events: [replayError] },
    ]);
    const clearPersisted = vi.fn(async () => {});

    const events = await collect(recoverKimiResumeStream({
      run,
      runInput: makeRunInput(),
      persistedBackendSessionId: PERSISTED_ID,
      clearPersisted,
    }));

    expect(calls).toHaveLength(2);
    expect(events.at(-1)).toEqual(replayError);
  });

  it("propagates a non-matching thrown error untouched", async () => {
    const { run, calls } = makeRun([
      { kind: "throw", error: new Error("connection reset") },
    ]);
    const clearPersisted = vi.fn(async () => {});

    await expect(collect(recoverKimiResumeStream({
      run,
      runInput: makeRunInput(),
      persistedBackendSessionId: PERSISTED_ID,
      clearPersisted,
    }))).rejects.toThrow("connection reset");

    expect(calls).toHaveLength(1);
    expect(clearPersisted).not.toHaveBeenCalled();
  });
});
