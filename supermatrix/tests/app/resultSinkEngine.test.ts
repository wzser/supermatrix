import { describe, expect, test, vi } from "vitest";
import { deliverResultSinks, redeliverResultSinks } from "../../src/app/resultSinkEngine.ts";
import { asAbsolutePath, asLarkGroupId, asMessageRunId, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";
import type { ResultSink } from "../../src/domain/childCapabilities.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";
import type { ResultSinkAttemptInput } from "../../src/ports/BindingStore.ts";

function makeChild(overrides: Partial<Session> = {}): Session {
  return {
    id: asSessionId("child_x"),
    name: "child_x",
    alias: "",
    avatar: "", category: "", fpManaged: null,
    scope: "child",
    backend: "claude",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/tmp/x"),
    backendSessionId: null,
    chatName: null,
    purpose: "",
    status: "busy",
    parentId: asSessionId("parent_x"),
    depth: 1,
    inactivityTimeoutS: null,
    maxRuntimeS: null,
    childType: "one_shot_delegation",
    triggerKind: "session",
    postIdentity: "bot",
    callerInvocation: "async_kickoff",
    continuationHook: "none",
    capabilityPayload: { resultSinks: [] },
    createdAt: asTimestamp(1),
    updatedAt: asTimestamp(1),
    ...overrides,
  };
}

describe("resultSinkEngine", () => {
  test("sync_inline callerInvocation short-circuits the whole engine", async () => {
    const postToChat = vi.fn(async () => {});
    const child = makeChild({
      callerInvocation: "sync_inline",
      capabilityPayload: {
        resultSinks: [
          { kind: "chat_post", chatRef: { kind: "explicit", chatId: "oc_x" }, identity: "bot" },
        ],
      },
    });
    const summary = await deliverResultSinks(child, "hi", {
      store: createFakeBindingStore(),
      postToChat,
    });
    expect(postToChat).not.toHaveBeenCalled();
    expect(summary.delivered[0]?.note).toMatch(/sync_inline/);
  });

  test("http_response / pollable_endpoint / audit_only are no-ops by design", async () => {
    const sinks: ResultSink[] = [
      { kind: "http_response" },
      { kind: "pollable_endpoint" },
      { kind: "audit_only" },
    ];
    const child = makeChild({ capabilityPayload: { resultSinks: sinks } });
    const summary = await deliverResultSinks(child, "ignored", {
      store: createFakeBindingStore(),
    });
    expect(summary.delivered).toHaveLength(3);
    expect(summary.delivered.every((d) => d.ok && /no-op/.test(d.note ?? ""))).toBe(true);
  });

  test("chat_post with explicit chatRef posts with declared identity", async () => {
    const postToChat = vi.fn(async () => {});
    const child = makeChild({
      capabilityPayload: {
        resultSinks: [
          { kind: "chat_post", chatRef: { kind: "explicit", chatId: "oc_target" }, identity: "user" },
        ],
      },
    });
    await deliverResultSinks(child, "the final word", {
      store: createFakeBindingStore(),
      postToChat,
    });
    expect(postToChat).toHaveBeenCalledWith(asLarkGroupId("oc_target"), "the final word", "user");
  });

  test("chat_post with parent chatRef resolves through findBySession", async () => {
    const store = createFakeBindingStore();
    store.seedBinding({
      groupId: asLarkGroupId("oc_parent"),
      sessionId: asSessionId("parent_x"),
      createdAt: asTimestamp(1),
    });
    const postToChat = vi.fn(async () => {});
    const child = makeChild({
      capabilityPayload: {
        resultSinks: [
          { kind: "chat_post", chatRef: { kind: "parent" }, identity: "bot" },
        ],
      },
    });
    await deliverResultSinks(child, "hey", { store, postToChat });
    expect(postToChat).toHaveBeenCalledWith(asLarkGroupId("oc_parent"), "hey", "bot");
  });

  test("chat_post without postToChat wired reports deferred", async () => {
    const child = makeChild({
      capabilityPayload: {
        resultSinks: [
          { kind: "chat_post", chatRef: { kind: "explicit", chatId: "oc_x" }, identity: "bot" },
        ],
      },
    });
    const summary = await deliverResultSinks(child, "hi", { store: createFakeBindingStore() });
    expect(summary.delivered[0]?.ok).toBe(false);
    expect(summary.delivered[0]?.note).toMatch(/postToChat not wired/);
  });

  test("parent_continuation_inject calls injectContinuation with the right payload", async () => {
    const injectContinuation = vi.fn(async () => {});
    const child = makeChild({
      capabilityPayload: {
        resultSinks: [
          { kind: "parent_continuation_inject", parentSessionId: asSessionId("parent_x") },
        ],
      },
    });
    await deliverResultSinks(child, "child done", {
      store: createFakeBindingStore(),
      injectContinuation,
    });
    expect(injectContinuation).toHaveBeenCalledWith({
      parentSessionId: asSessionId("parent_x"),
      childSession: child,
      finalMessage: "child done",
    });
  });

  test("eventbus_publish falls back to note when topicBus is not wired", async () => {
    const child = makeChild({
      capabilityPayload: {
        resultSinks: [{ kind: "eventbus_publish", topic: "result.done" }],
      },
    });
    const summary = await deliverResultSinks(child, "whatever", {
      store: createFakeBindingStore(),
    });
    expect(summary.delivered[0]?.ok).toBe(false);
    expect(summary.delivered[0]?.note).toMatch(/topicBus not wired/);
  });

  test("eventbus_publish publishes a child_final_message payload when topicBus is wired", async () => {
    const published: Array<{ topic: string; payload: unknown }> = [];
    const topicBus = {
      async publish(topic: string, payload: unknown) {
        published.push({ topic, payload });
      },
      subscribe() {
        return () => {};
      },
      recent() {
        return [];
      },
    };
    const child = makeChild({
      capabilityPayload: {
        resultSinks: [{ kind: "eventbus_publish", topic: "result.done" }],
      },
    });
    const summary = await deliverResultSinks(child, "done done", {
      store: createFakeBindingStore(),
      topicBus,
    });
    expect(summary.delivered[0]?.ok).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0]?.topic).toBe("result.done");
    const payload = published[0]?.payload as { kind: string; childSessionId: string; finalMessage: string };
    expect(payload.kind).toBe("child_final_message");
    expect(payload.finalMessage).toBe("done done");
    expect(payload.childSessionId).toBe(child.id);
  });

  test("redeliverResultSinks replays delivery and records a delivered attempt without rerunning the child", async () => {
    const store = createFakeBindingStore();
    const attempts: ResultSinkAttemptInput[] = [];
    store.recordResultSinkAttempt = async (input) => {
      attempts.push(input);
    };
    const postToChat = vi.fn(async () => {});
    const child = makeChild({
      status: "deleted",
      capabilityPayload: {
        resultSinks: [
          { kind: "chat_post", chatRef: { kind: "explicit", chatId: "oc_target" }, identity: "bot" },
        ],
      },
    });

    const summary = await redeliverResultSinks({
      session: child,
      finalMessage: "complete result",
      messageRunId: asMessageRunId("mr_redeliver"),
      spawnCommId: "comm_redeliver",
      deps: { store, postToChat },
      now: () => asTimestamp(10),
      idFactory: () => "sink_redeliver_1",
    });

    expect(postToChat).toHaveBeenCalledTimes(1);
    expect(postToChat).toHaveBeenCalledWith(asLarkGroupId("oc_target"), "complete result", "bot");
    expect(summary.delivered).toEqual([{ sinkKind: "chat_post", ok: true }]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      id: "sink_redeliver_1",
      spawnCommId: "comm_redeliver",
      childSessionId: child.id,
      messageRunId: asMessageRunId("mr_redeliver"),
      sinkIndex: 0,
      sinkKind: "chat_post",
      status: "delivered",
      createdAt: asTimestamp(10),
    });
  });

  test("redeliverResultSinks records failed attempts for dead addresses without throwing", async () => {
    const store = createFakeBindingStore();
    const attempts: ResultSinkAttemptInput[] = [];
    store.recordResultSinkAttempt = async (input) => {
      attempts.push(input);
    };
    const postToChat = vi.fn(async () => {
      throw new Error("chat not found");
    });
    const child = makeChild({
      status: "deleted",
      capabilityPayload: {
        resultSinks: [
          { kind: "chat_post", chatRef: { kind: "explicit", chatId: "oc_dead" }, identity: "bot" },
        ],
      },
    });

    const summary = await redeliverResultSinks({
      session: child,
      finalMessage: "complete result",
      messageRunId: asMessageRunId("mr_redeliver_fail"),
      spawnCommId: "comm_redeliver_fail",
      deps: { store, postToChat },
      now: () => asTimestamp(11),
      idFactory: () => "sink_redeliver_failed",
    });

    expect(summary.delivered[0]).toMatchObject({
      sinkKind: "chat_post",
      ok: false,
      note: "delivery failed",
      errorMessage: "chat not found",
    });
    expect(attempts[0]).toMatchObject({
      id: "sink_redeliver_failed",
      status: "failed",
      sinkKind: "chat_post",
      errorMessage: "chat not found",
    });
  });
});
