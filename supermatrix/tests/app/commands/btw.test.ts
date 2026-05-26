import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createBtwHandler } from "../../../src/app/commands/btw.ts";
import { UserError } from "../../../src/domain/errors.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asMessageRunId,
  asSessionId,
  asTimestamp,
} from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import type { SpawnChildResult } from "../../../src/app/childSession.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";
import { resetCodexModelCatalogForTests } from "../../../src/ports/CodexModelCatalog.ts";

function msg(groupId: string, text: string) {
  return {
    groupId: asLarkGroupId(groupId),
    messageId: "m",
    userId: "u",
    text,
    attachments: [],
    receivedAtMs: 0,
  };
}

const PARENT_SESSION: Session = {
  id: asSessionId("sess_parent"),
  name: "parent-session",
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
  createdAt: asTimestamp(1000),
  updatedAt: asTimestamp(1000),
};

function childResult(id: string, final: string): SpawnChildResult {
  return {
    session: {
      id: asSessionId(id),
      name: `child_${id}`,
      alias: "",
      avatar: "", category: "", fpManaged: null,
      scope: "child",
      backend: "claude",
      model: null,
      effort: null,
      thinking: false,
      modelLocked: false,
      workdir: asAbsolutePath("/ws/parent"),
      backendSessionId: null,
      chatName: null,
      purpose: "",
      status: "idle",
      parentId: PARENT_SESSION.id,
      depth: 1,
      inactivityTimeoutS: null,
      maxRuntimeS: null,
      childType: null,
      triggerKind: null,
      postIdentity: null,
      callerInvocation: null,
      continuationHook: null,
      capabilityPayload: null,
      createdAt: asTimestamp(1000),
      updatedAt: asTimestamp(2000),
    },
    finalMessage: final,
    backendSessionId: null,
    messageRunId: asMessageRunId("mr_1"),
  };
}

function setup() {
  const store = createFakeBindingStore();
  store.seedSession(PARENT_SESSION);
  store.seedBinding({
    groupId: asLarkGroupId("oc_parent_group"),
    sessionId: PARENT_SESSION.id,
    createdAt: asTimestamp(1000),
  });
  return store;
}

function makeLark() {
  return { sendMessage: vi.fn(async () => {}) };
}

describe("/btw handler", () => {
  beforeEach(() => {
    resetCodexModelCatalogForTests([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.2",
    ]);
  });

  afterEach(() => {
    resetCodexModelCatalogForTests();
  });

  test("first call spawns child with keepAlive=true and replies final message", async () => {
    const store = setup();
    const spawnChild = vi.fn(async () => childResult("sess_child_1", "hello from btw"));
    const resumeChild = vi.fn(async () => childResult("sess_child_1", "unused"));
    const cancel = vi.fn(async () => {});

    const btw = createBtwHandler({
      store,
      childSession: { spawnChild, resumeChild },
      backend: { cancel },
      lark: makeLark(),
      clock: { now: () => asTimestamp(5000) },
    });

    const result = await btw.handler({
      args: { text: "quick side question" },
      scope: "user",
      msg: msg("oc_parent_group", "/btw quick side question"),
    });

    expect(spawnChild).toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: PARENT_SESSION.id,
        backend: PARENT_SESSION.backend,
        workdir: PARENT_SESSION.workdir,
        prompt: "quick side question",
        type: "ephemeral_conversation",
      }),
    );
    expect(resumeChild).not.toHaveBeenCalled();
    expect(result).toEqual({ replyText: "hello from btw" });
    expect(btw._mapSize()).toBe(1);
    btw.shutdown();
  });

  test("empty finalMessage returns fallback replyText (codex null-final guard)", async () => {
    const store = setup();
    const spawnChild = vi.fn(async () => childResult("sess_child_1", ""));
    const btw = createBtwHandler({
      store,
      childSession: {
        spawnChild,
        resumeChild: vi.fn(async () => childResult("sess_child_1", "unused")),
      },
      backend: { cancel: vi.fn(async () => {}) },
      lark: makeLark(),
      clock: { now: () => asTimestamp(5000) },
    });

    const result = await btw.handler({
      args: { text: "你的工作范围" },
      scope: "user",
      msg: msg("oc_parent_group", "/btw 你的工作范围"),
    });

    expect(result).toEqual({
      replyText:
        "（后台已完成，但模型没有产出回复内容；请换个说法或补充上下文后重试）",
    });
    btw.shutdown();
  });

  test("whitespace-only finalMessage also returns fallback", async () => {
    const store = setup();
    const spawnChild = vi.fn(async () => childResult("sess_child_1", "   \n  "));
    const btw = createBtwHandler({
      store,
      childSession: {
        spawnChild,
        resumeChild: vi.fn(async () => childResult("sess_child_1", "unused")),
      },
      backend: { cancel: vi.fn(async () => {}) },
      lark: makeLark(),
      clock: { now: () => asTimestamp(5000) },
    });

    const result = await btw.handler({
      args: { text: "x" },
      scope: "user",
      msg: msg("oc_parent_group", "/btw x"),
    });

    expect((result as { replyText: string }).replyText).toContain(
      "模型没有产出回复内容",
    );
    btw.shutdown();
  });

  test("first claude btw child uses sonnet by default instead of parent model", async () => {
    const store = setup();
    store.seedSession({ ...PARENT_SESSION, model: "claude-opus-4-7" });
    const spawnChild = vi.fn(async () => childResult("sess_child_1", "hello from btw"));

    const btw = createBtwHandler({
      store,
      childSession: {
        spawnChild,
        resumeChild: vi.fn(async () => childResult("sess_child_1", "unused")),
      },
      backend: { cancel: vi.fn(async () => {}) },
      lark: makeLark(),
      clock: { now: () => asTimestamp(5000) },
    });

    await btw.handler({
      args: { text: "quick side question" },
      scope: "user",
      msg: msg("oc_parent_group", "/btw quick side question"),
    });

    expect(spawnChild).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-6" }),
    );
    btw.shutdown();
  });

  test("first codex btw child uses first catalog model by default instead of parent model", async () => {
    const store = setup();
    store.seedSession({ ...PARENT_SESSION, backend: "codex", model: "gpt-5.5" });
    const spawnChild = vi.fn(async () => childResult("sess_child_1", "hello from btw"));

    const btw = createBtwHandler({
      store,
      childSession: {
        spawnChild,
        resumeChild: vi.fn(async () => childResult("sess_child_1", "unused")),
      },
      backend: { cancel: vi.fn(async () => {}) },
      lark: makeLark(),
      clock: { now: () => asTimestamp(5000) },
    });

    await btw.handler({
      args: { text: "quick side question" },
      scope: "user",
      msg: msg("oc_parent_group", "/btw quick side question"),
    });

    expect(spawnChild).toHaveBeenCalledWith(
      expect.objectContaining({ backend: "codex", model: "gpt-5.5" }),
    );
    btw.shutdown();
  });

  test("second call reuses same child via resumeChild", async () => {
    const store = setup();
    // Pre-seed the child session so the handler sees it as idle on hit
    store.seedSession({
      ...PARENT_SESSION,
      id: asSessionId("sess_child_1"),
      name: "child_sess_child_1",
      scope: "child",
      parentId: PARENT_SESSION.id,
      depth: 1,
      status: "idle",
    });

    const spawnChild = vi.fn(async () => childResult("sess_child_1", "first"));
    const resumeChild = vi.fn(async () => childResult("sess_child_1", "second"));

    const btw = createBtwHandler({
      store,
      childSession: { spawnChild, resumeChild },
      backend: { cancel: vi.fn(async () => {}) },
      lark: makeLark(),
      clock: { now: () => asTimestamp(5000) },
    });

    await btw.handler({
      args: { text: "first" },
      scope: "user",
      msg: msg("oc_parent_group", "/btw first"),
    });
    const res = await btw.handler({
      args: { text: "second" },
      scope: "user",
      msg: msg("oc_parent_group", "/btw second"),
    });

    expect(spawnChild).toHaveBeenCalledTimes(1);
    expect(resumeChild).toHaveBeenCalledTimes(1);
    expect(resumeChild).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: asSessionId("sess_child_1"),
        prompt: "second",
      }),
    );
    expect(res).toEqual({ replyText: "second" });
    btw.shutdown();
  });

  test("idle timeout cancels backend and marks child deleted", async () => {
    vi.useFakeTimers();
    try {
      const store = setup();
      store.seedSession({
        ...PARENT_SESSION,
        id: asSessionId("sess_child_1"),
        name: "child_sess_child_1",
        scope: "child",
        parentId: PARENT_SESSION.id,
        depth: 1,
        status: "idle",
      });
      const spawnChild = vi.fn(async () => childResult("sess_child_1", "first"));
      const resumeChild = vi.fn(async () => childResult("sess_child_1", "noop"));
      const cancel = vi.fn(async () => {});

      const btw = createBtwHandler({
        store,
        childSession: { spawnChild, resumeChild },
        backend: { cancel },
        lark: makeLark(),
        clock: { now: () => asTimestamp(9999) },
        idleTimeoutMs: 1000,
      });

      await btw.handler({
        args: { text: "hi" },
        scope: "user",
        msg: msg("oc_parent_group", "/btw hi"),
      });

      expect(btw._mapSize()).toBe(1);
      await vi.advanceTimersByTimeAsync(1100);
      // Let cleanup promises settle
      await Promise.resolve();
      await Promise.resolve();

      expect(cancel).toHaveBeenCalledWith(asSessionId("sess_child_1"));
      const child = await store.findSessionById(asSessionId("sess_child_1"));
      expect(child?.status).toBe("deleted");
      expect(btw._mapSize()).toBe(0);
      btw.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  test("stale entry (child deleted externally) falls through to new spawn", async () => {
    const store = setup();
    store.seedSession({
      ...PARENT_SESSION,
      id: asSessionId("sess_child_1"),
      name: "child_sess_child_1",
      scope: "child",
      parentId: PARENT_SESSION.id,
      depth: 1,
      status: "idle",
    });
    const spawnChild = vi
      .fn()
      .mockResolvedValueOnce(childResult("sess_child_1", "first"))
      .mockResolvedValueOnce(childResult("sess_child_2", "second"));
    const resumeChild = vi.fn();

    const btw = createBtwHandler({
      store,
      childSession: { spawnChild, resumeChild },
      backend: { cancel: vi.fn(async () => {}) },
      lark: makeLark(),
      clock: { now: () => asTimestamp(5000) },
    });

    await btw.handler({
      args: { text: "first" },
      scope: "user",
      msg: msg("oc_parent_group", "/btw first"),
    });

    // Externally flip the child to deleted (simulating /delete or background cleanup)
    await store.updateSessionStatus(asSessionId("sess_child_1"), "deleted", asTimestamp(6000));

    const res = await btw.handler({
      args: { text: "second" },
      scope: "user",
      msg: msg("oc_parent_group", "/btw second"),
    });

    expect(spawnChild).toHaveBeenCalledTimes(2);
    expect(resumeChild).not.toHaveBeenCalled();
    expect(res).toEqual({ replyText: "second" });
    btw.shutdown();
  });

  test("rejects when scope is root", async () => {
    const store = setup();
    const btw = createBtwHandler({
      store,
      childSession: { spawnChild: vi.fn(), resumeChild: vi.fn() },
      backend: { cancel: vi.fn(async () => {}) },
      lark: makeLark(),
      clock: { now: () => asTimestamp(5000) },
    });
    await expect(
      btw.handler({
        args: { text: "x" },
        scope: "root",
        msg: msg("oc_console", "/btw x"),
      }),
    ).rejects.toThrow(UserError);
    btw.shutdown();
  });

  test("rejects when group has no binding", async () => {
    const store = createFakeBindingStore();
    const btw = createBtwHandler({
      store,
      childSession: { spawnChild: vi.fn(), resumeChild: vi.fn() },
      backend: { cancel: vi.fn(async () => {}) },
      lark: makeLark(),
      clock: { now: () => asTimestamp(5000) },
    });
    await expect(
      btw.handler({
        args: { text: "x" },
        scope: "user",
        msg: msg("oc_unbound", "/btw x"),
      }),
    ).rejects.toThrow(UserError);
    btw.shutdown();
  });

  test("rejects empty prompt", async () => {
    const store = setup();
    const btw = createBtwHandler({
      store,
      childSession: { spawnChild: vi.fn(), resumeChild: vi.fn() },
      backend: { cancel: vi.fn(async () => {}) },
      lark: makeLark(),
      clock: { now: () => asTimestamp(5000) },
    });
    await expect(
      btw.handler({
        args: { text: "   " },
        scope: "user",
        msg: msg("oc_parent_group", "/btw   "),
      }),
    ).rejects.toThrow(UserError);
    btw.shutdown();
  });

  test("ack sent to parent group before spawnChild runs", async () => {
    const store = setup();
    const calls: string[] = [];
    const sendMessage = vi.fn(async (groupId: unknown, text: unknown) => {
      calls.push(`lark:${String(groupId)}:${String(text)}`);
    });
    const spawnChild = vi.fn(async () => {
      calls.push("spawn");
      return childResult("sess_child_1", "final");
    });
    const resumeChild = vi.fn(async () => {
      calls.push("resume");
      return childResult("sess_child_1", "unused");
    });

    const btw = createBtwHandler({
      store,
      childSession: { spawnChild, resumeChild },
      backend: { cancel: vi.fn(async () => {}) },
      lark: { sendMessage },
      clock: { now: () => asTimestamp(5000) },
    });

    const res = await btw.handler({
      args: { text: "hi" },
      scope: "user",
      msg: msg("oc_parent_group", "/btw hi"),
    });

    expect(sendMessage).toHaveBeenCalledWith(
      asLarkGroupId("oc_parent_group"),
      "已收到，正在后台处理",
    );
    expect(calls).toEqual(["lark:oc_parent_group:已收到，正在后台处理", "spawn"]);
    expect(res).toEqual({ replyText: "final" });
    btw.shutdown();
  });

  test("does not ack when validation rejects (empty prompt)", async () => {
    const store = setup();
    const sendMessage = vi.fn(async () => {});
    const btw = createBtwHandler({
      store,
      childSession: { spawnChild: vi.fn(), resumeChild: vi.fn() },
      backend: { cancel: vi.fn(async () => {}) },
      lark: { sendMessage },
      clock: { now: () => asTimestamp(5000) },
    });
    await expect(
      btw.handler({
        args: { text: "   " },
        scope: "user",
        msg: msg("oc_parent_group", "/btw   "),
      }),
    ).rejects.toThrow(UserError);
    expect(sendMessage).not.toHaveBeenCalled();
    btw.shutdown();
  });
});
