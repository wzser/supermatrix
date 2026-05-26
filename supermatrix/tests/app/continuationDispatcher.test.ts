import { describe, expect, test, vi } from "vitest";
import {
  buildContinuationEnvelope,
  createContinuationDispatcher,
} from "../../src/app/continuationDispatcher.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asSessionId,
  asTimestamp,
} from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";
import type { ResultSinkAttemptInput } from "../../src/ports/BindingStore.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";

function makeParent(status: Session["status"] = "idle"): Session {
  return {
    id: asSessionId("parent_1"),
    name: "parent_session",
    alias: "",
    avatar: "", category: "", fpManaged: null,
    scope: "user",
    backend: "claude",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/ws/parent"),
    backendSessionId: null,
    chatName: null,
    purpose: "",
    status,
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

function makeChild(): Session {
  return {
    ...makeParent(),
    id: asSessionId("child_1"),
    name: "child_alpha",
    scope: "child",
    parentId: asSessionId("parent_1"),
    depth: 1,
    childType: "event_awaited_worker",
    continuationHook: "inject_result",
    status: "deleted",
  };
}

import type { InboundMessage } from "../../src/ports/LarkGateway.ts";

function mkDeps(handleInbound: (msg: InboundMessage) => Promise<void> = async () => {}) {
  const store = createFakeBindingStore();
  const sinkAttempts: ResultSinkAttemptInput[] = [];
  store.recordResultSinkAttempt = async (input) => {
    sinkAttempts.push({ ...input });
  };
  const handleInboundSpy = vi.fn(handleInbound);
  const dispatcher = { handleInbound: handleInboundSpy };
  const clock = { now: () => asTimestamp(1000) };
  let id = 0;
  const idFactory = () => `cont${++id}`;
  const dispatcherService = createContinuationDispatcher({
    store,
    dispatcher,
    clock,
    idFactory,
  });
  return { store, dispatcher, dispatcherService, handleInbound: handleInboundSpy, sinkAttempts };
}

describe("buildContinuationEnvelope", () => {
  test("produces XML-ish structured tag with child attributes and result", () => {
    const env = buildContinuationEnvelope({
      childSessionId: asSessionId("sess_child_abc"),
      childSessionName: "child_foo",
      childType: "event_awaited_worker",
      finalMessage: "Hello parent, I'm done.",
    });
    expect(env).toContain(`child_id="sess_child_abc"`);
    expect(env).toContain(`child_type="event_awaited_worker"`);
    expect(env).toContain(`child_name="child_foo"`);
    expect(env).toContain("<sm-child-completed");
    expect(env).toContain("</sm-child-completed>");
    expect(env).toContain("<result>");
    expect(env).toContain("Hello parent, I'm done.");
  });

  test("escapes special characters in child name attribute", () => {
    const env = buildContinuationEnvelope({
      childSessionId: asSessionId("x"),
      childSessionName: `evil"<>&name`,
      childType: null,
      finalMessage: "ok",
    });
    expect(env).toContain(`child_name="evil&quot;&lt;&gt;&amp;name"`);
    expect(env).toContain(`child_type="unknown"`);
  });
});

describe("continuationDispatcher", () => {
  test("idle parent: injects synthetic inbound and marks row completed", async () => {
    const parent = makeParent("idle");
    const child = makeChild();
    const { store, dispatcherService, handleInbound } = mkDeps(async () => {
      await store.startMessageRun({
        id: "run_parent_x" as never,
        sessionId: parent.id,
        groupId: asLarkGroupId("oc_parent"),
        prompt: "env",
        startedAt: asTimestamp(1000),
      });
      await store.finishMessageRun(
        "run_parent_x" as never,
        "completed",
        "Parent responded after continuation",
      );
    });
    store.seedSession(parent);
    store.seedSession({ ...child, status: "deleted" });
    store.seedBinding({
      groupId: asLarkGroupId("oc_parent"),
      sessionId: parent.id,
      createdAt: asTimestamp(1),
    });

    await dispatcherService.injectContinuation({
      parentSessionId: parent.id,
      childSession: child,
      finalMessage: "child's final",
    });

    expect(handleInbound).toHaveBeenCalledTimes(1);
    const calls = handleInbound.mock.calls;
    expect(calls.length).toBe(1);
    const inboundArg = calls[0]![0];
    expect(inboundArg.messageId).toMatch(/^continuation_/);
    expect(inboundArg.text).toContain("<sm-child-completed");
    expect(inboundArg.groupId).toBe("oc_parent");

    const comms = store._listCrossSessionComms();
    expect(comms).toHaveLength(1);
    expect(comms[0]?.kind).toBe("continuation");
    expect(comms[0]?.status).toBe("completed");
    expect(comms[0]?.fromSessionId).toBe(child.id);
    expect(comms[0]?.toSessionId).toBe(parent.id);
    expect(comms[0]?.childSessionId).toBe(child.id);
    expect(comms[0]?.finalMessage).toBe("Parent responded after continuation");
  });

  test("busy parent: skips injection, records failed row and watcher follow-up item", async () => {
    const parent = makeParent("busy");
    const child = makeChild();
    const handleInbound = vi.fn(async () => {});
    const { store, dispatcherService, sinkAttempts } = mkDeps(handleInbound);
    store.seedSession(parent);

    await dispatcherService.injectContinuation({
      parentSessionId: parent.id,
      childSession: child,
      finalMessage: "child's final",
    });

    expect(handleInbound).not.toHaveBeenCalled();
    const comms = store._listCrossSessionComms();
    expect(comms[0]?.status).toBe("failed");
    expect(comms[0]?.errorMessage).toMatch(/busy/);
    expect(comms[0]?.finalMessage).toBe("child's final");
    expect(sinkAttempts).toHaveLength(1);
    expect(sinkAttempts[0]).toMatchObject({
      spawnCommId: comms[0]?.id,
      childSessionId: child.id,
      sinkIndex: 0,
      sinkKind: "parent_continuation_inject",
      status: "failed",
      note: "parent busy; continuation deferred to watcher delivery",
    });
    expect(store._listSpawnAsyncItems()[0]).toMatchObject({
      commId: comms[0]?.id,
      callerSession: "parent_session",
      targetSession: "parent_session",
      failedPhase: "delivery",
      failureKind: "late_result",
      status: "waiting_child",
    });
  });

  test("deleted parent: skips, records failed row", async () => {
    const parent = makeParent("deleted");
    const child = makeChild();
    const handleInbound = vi.fn(async () => {});
    const { store, dispatcherService } = mkDeps(handleInbound);
    store.seedSession(parent);

    await dispatcherService.injectContinuation({
      parentSessionId: parent.id,
      childSession: child,
      finalMessage: "child's final",
    });

    expect(handleInbound).not.toHaveBeenCalled();
    const comms = store._listCrossSessionComms();
    expect(comms[0]?.status).toBe("failed");
    expect(comms[0]?.errorMessage).toMatch(/deleted|terminal/);
    expect(store._listSpawnAsyncItems()).toHaveLength(0);
  });

  test("missing parent: skips, records failed row", async () => {
    const child = makeChild();
    const handleInbound = vi.fn(async () => {});
    const { store, dispatcherService, sinkAttempts } = mkDeps(handleInbound);
    // don't seed parent

    await dispatcherService.injectContinuation({
      parentSessionId: asSessionId("ghost"),
      childSession: child,
      finalMessage: "x",
    });

    expect(handleInbound).not.toHaveBeenCalled();
    const comms = store._listCrossSessionComms();
    expect(comms[0]?.status).toBe("failed");
    expect(comms[0]?.errorMessage).toMatch(/not found/);
    expect(sinkAttempts).toHaveLength(1);
    expect(sinkAttempts[0]).toMatchObject({
      spawnCommId: comms[0]?.id,
      childSessionId: child.id,
      sinkIndex: 0,
      sinkKind: "parent_continuation_inject",
      status: "failed",
      note: "parent session not found: ghost",
    });
  });

  test("handleInbound throws: row goes to failed with error_message", async () => {
    const parent = makeParent("idle");
    const child = makeChild();
    const handleInbound = vi.fn(async () => {
      throw new Error("boom");
    });
    const { store, dispatcherService, sinkAttempts } = mkDeps(handleInbound);
    store.seedSession(parent);

    await dispatcherService.injectContinuation({
      parentSessionId: parent.id,
      childSession: child,
      finalMessage: "x",
    });

    const comms = store._listCrossSessionComms();
    expect(comms[0]?.status).toBe("failed");
    expect(comms[0]?.errorMessage).toBe("boom");
    expect(sinkAttempts).toHaveLength(1);
    expect(sinkAttempts[0]).toMatchObject({
      spawnCommId: comms[0]?.id,
      childSessionId: child.id,
      sinkIndex: 0,
      sinkKind: "parent_continuation_inject",
      status: "failed",
      note: "handleInbound threw",
      errorMessage: "boom",
    });
  });
});
