import { describe, expect, test, vi } from "vitest";
import { recoverRepeatedCodexResume } from "../../src/app/codexResumeRecovery.ts";
import { asAbsolutePath, asLarkGroupId, asMessageRunId, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";

const SESSION_ID = asSessionId("sess_codex_poison_recovery");
const GROUP_ID = asLarkGroupId("group_codex_poison_recovery");
const ERROR = "400 [ArrayParam] [input[115].content] [array_above_max_length]";

function session(): Session {
  return {
    id: SESSION_ID,
    name: "codex-poison-recovery",
    alias: "",
    avatar: "",
    category: "",
    fpManaged: null,
    scope: "user",
    backend: "codex",
    model: "gpt-5.5",
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/tmp/codex-poison-recovery"),
    backendSessionId: "poisoned-thread",
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
    createdAt: asTimestamp(1),
    updatedAt: asTimestamp(1),
  };
}

async function seedRepeatedFailures() {
  const store = createFakeBindingStore();
  store.seedSession(session());
  store.seedBinding({ groupId: GROUP_ID, sessionId: SESSION_ID, createdAt: asTimestamp(1) });
  for (const [id, startedAt] of [["mr_old_poison", 10], ["mr_new_poison", 20]] as const) {
    await store.startMessageRun({
      id: asMessageRunId(id),
      sessionId: SESSION_ID,
      groupId: GROUP_ID,
      prompt: "short",
      startedAt: asTimestamp(startedAt),
      branchName: "main",
    });
    await store.finishMessageRun(asMessageRunId(id), "failed", undefined, ERROR);
  }
  return store;
}

describe("recoverRepeatedCodexResume", () => {
  test("does not clear after one matching error", async () => {
    const store = createFakeBindingStore();
    store.seedSession(session());
    store.seedBinding({ groupId: GROUP_ID, sessionId: SESSION_ID, createdAt: asTimestamp(1) });
    await store.startMessageRun({
      id: asMessageRunId("mr_only_poison"),
      sessionId: SESSION_ID,
      groupId: GROUP_ID,
      prompt: "short",
      startedAt: asTimestamp(10),
      branchName: "main",
    });
    await store.finishMessageRun(asMessageRunId("mr_only_poison"), "failed", undefined, ERROR);

    const backup = vi.fn();
    const result = await recoverRepeatedCodexResume({
      store,
      sessionId: SESSION_ID,
      branchName: "main",
      backend: "codex",
      persistedBackendSessionId: "poisoned-thread",
      failedRunId: "mr_only_poison",
      error: ERROR,
      now: asTimestamp(30),
      backup,
    });

    expect(result.status).toBe("not_repeated");
    expect(backup).not.toHaveBeenCalled();
    expect((await store.findSessionById(SESSION_ID))?.backendSessionId).toBe("poisoned-thread");
  });

  test("preserves the pointer when the recoverable backup fails", async () => {
    const store = await seedRepeatedFailures();
    const backup = vi.fn(async () => { throw new Error("backup unavailable"); });

    const result = await recoverRepeatedCodexResume({
      store,
      sessionId: SESSION_ID,
      branchName: "main",
      backend: "codex",
      persistedBackendSessionId: "poisoned-thread",
      failedRunId: "mr_new_poison",
      error: ERROR,
      now: asTimestamp(30),
      backup,
    });

    expect(result.status).toBe("backup_failed");
    expect((await store.findSessionById(SESSION_ID))?.backendSessionId).toBe("poisoned-thread");
  });
});
