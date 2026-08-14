import { describe, expect, test, vi } from "vitest";
import { createSessionBranchService } from "../../../src/app/sessionBranches.ts";
import { createBranchHandler } from "../../../src/app/commands/branch.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asSessionId,
  asTimestamp,
} from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";
import { RuntimeConfigConflictError } from "../../../src/ports/BindingStore.ts";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: asSessionId("sess_1"),
    name: "codexroot",
    alias: "",
    avatar: "",
    category: "",
    fpManaged: null,
    scope: "user",
    backend: "claude",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/tmp/ws/codexroot"),
    backendSessionId: null,
    chatName: null,
    purpose: "test",
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
    createdAt: asTimestamp(1_000),
    updatedAt: asTimestamp(1_000),
    ...overrides,
  };
}

function msg(text: string) {
  return {
    groupId: asLarkGroupId("oc_1"),
    messageId: "m",
    userId: "ou_user",
    text,
    attachments: [],
    receivedAtMs: 0,
  };
}

describe("createBranchHandler", () => {
  test("/branch plan-a creates and switches branch in user group", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({ backendSessionId: "bks-main" });
    store.seedSession(session);
    store.seedBinding({ groupId: asLarkGroupId("oc_1"), sessionId: session.id, createdAt: asTimestamp(1) });
    const branchService = createSessionBranchService({ store });
    const handler = createBranchHandler({ store, branchService, clock: { now: () => asTimestamp(2_000) } });

    const result = await handler({
      args: { name: "plan-a" },
      scope: "user",
      msg: msg("/branch plan-a"),
    });

    expect(result).toEqual({ replyText: "✓ 已创建并切换到 branch「plan-a」（from main）" });
    expect((await store.getActiveBranch(session.id)).name).toBe("plan-a");
  });

  test("/branch lists branches and marks the active branch", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({ backendSessionId: "bks-main" });
    store.seedSession(session);
    store.seedBinding({ groupId: asLarkGroupId("oc_1"), sessionId: session.id, createdAt: asTimestamp(1) });
    const branchService = createSessionBranchService({ store });
    await branchService.createBranchFromActive({ sessionId: session.id, name: "plan-a", now: asTimestamp(2_000) });
    const handler = createBranchHandler({ store, branchService, clock: { now: () => asTimestamp(2_001) } });

    const result = await handler({ args: {}, scope: "user", msg: msg("/branch") });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("- main (ready)");
    expect(result.replyText).toContain("* plan-a (pending fork)");
  });

  test("/branch main switches back to the main branch", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({ backendSessionId: "bks-main" });
    store.seedSession(session);
    store.seedBinding({ groupId: asLarkGroupId("oc_1"), sessionId: session.id, createdAt: asTimestamp(1) });
    const branchService = createSessionBranchService({ store });
    await branchService.createBranchFromActive({ sessionId: session.id, name: "plan-a", now: asTimestamp(2_000) });
    const handler = createBranchHandler({ store, branchService, clock: { now: () => asTimestamp(2_001) } });

    const result = await handler({
      args: { name: "main" },
      scope: "user",
      msg: msg("/branch main"),
    });

    expect(result).toEqual({ replyText: "✓ 已切换到 branch「main」" });
    expect((await store.getActiveBranch(session.id)).name).toBe("main");
  });

  test("/branch existing-name switches instead of creating a duplicate branch", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({ backendSessionId: "bks-main" });
    store.seedSession(session);
    store.seedBinding({ groupId: asLarkGroupId("oc_1"), sessionId: session.id, createdAt: asTimestamp(1) });
    const branchService = createSessionBranchService({ store });
    await branchService.createBranchFromActive({ sessionId: session.id, name: "plan-a", now: asTimestamp(2_000) });
    await branchService.switchBranch({ sessionId: session.id, name: "main", now: asTimestamp(2_001) });
    const handler = createBranchHandler({ store, branchService, clock: { now: () => asTimestamp(2_002) } });

    const result = await handler({
      args: { name: "plan-a" },
      scope: "user",
      msg: msg("/branch plan-a"),
    });

    expect(result).toEqual({ replyText: "✓ 已切换到 branch「plan-a」" });
    expect((await store.getActiveBranch(session.id)).name).toBe("plan-a");
    expect(await branchService.listBranches(session.id)).toHaveLength(2);
  });

  test("/branch prepares Codex inherited fork before creating the branch row", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({
      id: asSessionId("sess_codex"),
      backend: "codex",
      backendSessionId: "codex-source",
      model: "gpt-5.5",
      effort: "max",
    });
    store.seedSession(session);
    store.seedBinding({ groupId: asLarkGroupId("oc_1"), sessionId: session.id, createdAt: asTimestamp(1) });
    const branchService = createSessionBranchService({ store });
    const initializerCalls: unknown[] = [];
    const handler = createBranchHandler({
      store,
      branchService,
      clock: { now: () => asTimestamp(2_000) },
      codexForkInitializer: async (input) => {
        initializerCalls.push(input);
        return "codex-child";
      },
    });

    const result = await handler({
      args: { name: "plan-a" },
      scope: "user",
      msg: msg("/branch plan-a"),
    });

    expect(result).toEqual({
      replyText: "✓ 已创建并切换到 branch「plan-a」（from main, codex ready）",
    });
    expect(initializerCalls).toEqual([
      expect.objectContaining({
        sourceBackendSessionId: "codex-source",
        branchName: "plan-a",
        sessionName: "codexroot",
        workdir: asAbsolutePath("/tmp/ws/codexroot"),
        model: "gpt-5.5",
        effort: "xhigh",
      }),
    ]);
    const branch = await store.findSessionBranch(session.id, "plan-a");
    expect(branch).toMatchObject({
      backendSessionId: "codex-child",
      sourceBackendSessionId: "codex-source",
      forkPending: false,
    });
  });

  test("/branch atomically repairs persisted config and forks with the committed tuple", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({
      id: asSessionId("sess_codex"),
      backend: "codex",
      backendSessionId: "codex-source",
      model: "gpt-5.5",
      effort: "ultra",
    });
    store.seedSession(session);
    store.seedBinding({ groupId: asLarkGroupId("oc_1"), sessionId: session.id, createdAt: asTimestamp(1) });
    const initializerCalls: unknown[] = [];
    const handler = createBranchHandler({
      store,
      branchService: createSessionBranchService({ store }),
      clock: { now: () => asTimestamp(2_000) },
      codexForkInitializer: async (input) => {
        initializerCalls.push(input);
        return "codex-child";
      },
    });

    await handler({ args: { name: "plan-a" }, scope: "user", msg: msg("/branch plan-a") });

    expect(await store.findSessionById(session.id)).toMatchObject({
      model: "gpt-5.5",
      effort: "xhigh",
      backendSessionId: "codex-source",
    });
    expect(initializerCalls).toEqual([
      expect.objectContaining({ model: "gpt-5.5", effort: "xhigh" }),
    ]);
  });

  test("/branch conflict performs no fork or branch side effect", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({
      id: asSessionId("sess_codex"),
      backend: "codex",
      backendSessionId: "codex-source",
      model: "gpt-5.5",
      effort: "ultra",
    });
    store.seedSession(session);
    store.seedBinding({ groupId: asLarkGroupId("oc_1"), sessionId: session.id, createdAt: asTimestamp(1) });
    store.applySessionRuntimeConfigMutations = async () => {
      throw new RuntimeConfigConflictError(session.id);
    };
    const initializer = vi.fn(async () => "codex-child");
    const handler = createBranchHandler({
      store,
      branchService: createSessionBranchService({ store }),
      clock: { now: () => asTimestamp(2_000) },
      codexForkInitializer: initializer,
    });

    await expect(
      handler({ args: { name: "plan-a" }, scope: "user", msg: msg("/branch plan-a") }),
    ).rejects.toThrow(/runtime config mutation conflict/u);

    expect(initializer).not.toHaveBeenCalled();
    expect(await store.findSessionBranch(session.id, "plan-a")).toBeNull();
    expect(await store.findSessionById(session.id)).toMatchObject({ effort: "ultra" });
  });

  test.each(["busy", "stale tuple"])("/branch no-op config rejects concurrent %s admission before fork", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({ id: asSessionId("sess_codex"), backend: "codex", backendSessionId: "codex-source", model: "gpt-5.6-sol", effort: "max" });
    store.seedSession(session);
    store.seedBinding({ groupId: asLarkGroupId("oc_1"), sessionId: session.id, createdAt: asTimestamp(1) });
    const guard = vi.fn(async () => { throw new RuntimeConfigConflictError(session.id); });
    Object.assign(store, { guardIdleSessionRuntimeConfig: guard });
    const initializer = vi.fn(async () => "codex-child");
    const handler = createBranchHandler({ store, branchService: createSessionBranchService({ store }), clock: { now: () => asTimestamp(2_000) }, codexForkInitializer: initializer });

    await expect(handler({ args: { name: "plan-a" }, scope: "user", msg: msg("/branch plan-a") })).rejects.toThrow(/runtime config mutation conflict/u);
    expect(guard).toHaveBeenCalledWith(session.id, expect.objectContaining({ model: "gpt-5.6-sol", effort: "max" }));
    expect(initializer).not.toHaveBeenCalled();
    expect(await store.findSessionBranch(session.id, "plan-a")).toBeNull();
  });

  test("/branch forks with exactly the guarded committed snapshot", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({ id: asSessionId("sess_codex"), backend: "codex", backendSessionId: "codex-source", model: "gpt-5.6-sol", effort: "max" });
    store.seedSession(session);
    store.seedBinding({ groupId: asLarkGroupId("oc_1"), sessionId: session.id, createdAt: asTimestamp(1) });
    const guarded = { backend: "codex" as const, model: "gpt-5.6-terra", effort: "ultra" as const, backendSessionId: "guarded-source" };
    Object.assign(store, { guardIdleSessionRuntimeConfig: vi.fn(async () => guarded) });
    const initializer = vi.fn(async () => "codex-child");
    const handler = createBranchHandler({ store, branchService: createSessionBranchService({ store }), clock: { now: () => asTimestamp(2_000) }, codexForkInitializer: initializer });

    await handler({ args: { name: "plan-a" }, scope: "user", msg: msg("/branch plan-a") });
    expect(initializer).toHaveBeenCalledWith(expect.objectContaining({ sourceBackendSessionId: "guarded-source", model: "gpt-5.6-terra", effort: "ultra" }));
  });

  test("/branch fails closed when the guarded Codex snapshot has no resume id", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({ id: asSessionId("sess_codex"), backend: "codex", backendSessionId: "codex-source" });
    store.seedSession(session);
    store.seedBinding({ groupId: asLarkGroupId("oc_1"), sessionId: session.id, createdAt: asTimestamp(1) });
    Object.assign(store, {
      guardIdleSessionRuntimeConfig: vi.fn(async () => ({
        backend: "codex" as const, model: session.model, effort: session.effort, backendSessionId: null,
      })),
    });
    const initializer = vi.fn(async () => "codex-child");
    const handler = createBranchHandler({
      store,
      branchService: createSessionBranchService({ store }),
      clock: { now: () => asTimestamp(2_000) },
      codexForkInitializer: initializer,
    });

    await expect(handler({ args: { name: "plan-a" }, scope: "user", msg: msg("/branch plan-a") }))
      .rejects.toThrow(/guarded Codex snapshot has no backend session id/u);
    expect(initializer).not.toHaveBeenCalled();
    expect(await store.findSessionBranch(session.id, "plan-a")).toBeNull();
  });

  test("/branch does not create a Codex branch row when fork preparation fails", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({
      id: asSessionId("sess_codex"),
      backend: "codex",
      backendSessionId: "codex-source",
    });
    store.seedSession(session);
    store.seedBinding({ groupId: asLarkGroupId("oc_1"), sessionId: session.id, createdAt: asTimestamp(1) });
    const branchService = createSessionBranchService({ store });
    const handler = createBranchHandler({
      store,
      branchService,
      clock: { now: () => asTimestamp(2_000) },
      codexForkInitializer: async () => {
        throw new Error("fork bootstrap failed");
      },
    });

    await expect(
      handler({
        args: { name: "plan-a" },
        scope: "user",
        msg: msg("/branch plan-a"),
      }),
    ).rejects.toThrow(/fork bootstrap failed/u);

    expect(await store.findSessionBranch(session.id, "plan-a")).toBeNull();
    expect((await store.getActiveBranch(session.id)).name).toBe("main");
  });

  test("/branch existing Codex branch switches without preparing a new fork", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({
      id: asSessionId("sess_codex"),
      backend: "codex",
      backendSessionId: "codex-source",
    });
    store.seedSession(session);
    store.seedBinding({ groupId: asLarkGroupId("oc_1"), sessionId: session.id, createdAt: asTimestamp(1) });
    const branchService = createSessionBranchService({ store });
    await branchService.createBranchFromActive({
      sessionId: session.id,
      name: "plan-a",
      preparedBackendSessionId: "codex-child",
      now: asTimestamp(2_000),
    });
    await branchService.switchBranch({ sessionId: session.id, name: "main", now: asTimestamp(2_001) });
    let initializerCalled = false;
    const handler = createBranchHandler({
      store,
      branchService,
      clock: { now: () => asTimestamp(2_002) },
      codexForkInitializer: async () => {
        initializerCalled = true;
        return "should-not-be-used";
      },
    });

    const result = await handler({
      args: { name: "plan-a" },
      scope: "user",
      msg: msg("/branch plan-a"),
    });

    expect(result).toEqual({ replyText: "✓ 已切换到 branch「plan-a」" });
    expect(initializerCalled).toBe(false);
    expect((await store.getActiveBranch(session.id)).name).toBe("plan-a");
  });
});
