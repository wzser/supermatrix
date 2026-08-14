import { describe, expect, test } from "vitest";
import { createSessionBranchService } from "../../src/app/sessionBranches.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";

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

describe("createSessionBranchService", () => {
  test("createBranchFromActive stores source backend id and switches active branch", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({ backendSessionId: "bks-main" });
    store.seedSession(session);
    const service = createSessionBranchService({ store });

    const branch = await service.createBranchFromActive({
      sessionId: session.id,
      name: "plan-a",
      now: asTimestamp(2_000),
    });

    expect(branch.name).toBe("plan-a");
    expect(branch.backendSessionId).toBeNull();
    expect(branch.sourceBranchName).toBe("main");
    expect(branch.sourceBackendSessionId).toBe("bks-main");
    expect(branch.forkPending).toBe(true);
    expect((await store.getActiveBranch(session.id)).name).toBe("plan-a");
  });

  test("createBranchFromActive can create a ready prepared fork branch", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({ backendSessionId: "codex-source" });
    store.seedSession(session);
    const service = createSessionBranchService({ store });

    const branch = await service.createBranchFromActive({
      sessionId: session.id,
      name: "codex-plan",
      preparedBackendSessionId: "codex-child",
      now: asTimestamp(2_000),
    });

    expect(branch).toMatchObject({
      name: "codex-plan",
      sourceBranchName: "main",
      sourceBackendSessionId: "codex-source",
      backendSessionId: "codex-child",
      forkPending: false,
    });
    expect((await store.getActiveBranch(session.id)).name).toBe("codex-plan");
  });

  test("createBranchFromActive from fresh main creates non-pending fresh branch", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({ backendSessionId: null });
    store.seedSession(session);
    const service = createSessionBranchService({ store });

    const branch = await service.createBranchFromActive({
      sessionId: session.id,
      name: "empty",
      now: asTimestamp(2_000),
    });

    expect(branch.forkPending).toBe(false);
    expect(branch.sourceBackendSessionId).toBeNull();
  });

  test("createBranchFromActive from pending inherited branch keeps the inherited source", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({ backendSessionId: "bks-main" });
    store.seedSession(session);
    const service = createSessionBranchService({ store });
    await service.createBranchFromActive({
      sessionId: session.id,
      name: "plan-a",
      now: asTimestamp(2_000),
    });

    const branch = await service.createBranchFromActive({
      sessionId: session.id,
      name: "plan-b",
      now: asTimestamp(2_001),
    });

    expect(branch.sourceBranchName).toBe("plan-a");
    expect(branch.sourceBackendSessionId).toBe("bks-main");
    expect(branch.forkPending).toBe(true);
  });
});
