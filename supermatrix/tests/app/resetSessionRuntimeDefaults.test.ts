import { describe, expect, test } from "vitest";
import { resetSessionRuntimeDefaults } from "../../src/app/resetSessionRuntimeDefaults.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";
import { RuntimeConfigConflictError } from "../../src/ports/BindingStore.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id: asSessionId(id), name: id, alias: "", avatar: "", category: "", fpManaged: null,
    scope: "user", backend: "codex", model: "gpt-5.6-sol", effort: "ultra",
    thinking: false, modelLocked: false, effortLocked: false,
    workdir: asAbsolutePath(`/tmp/${id}`), backendSessionId: null, chatName: null,
    purpose: "", status: "idle", parentId: null, depth: 0, inactivityTimeoutS: null,
    maxRuntimeS: null, childType: null, triggerKind: null, postIdentity: null,
    callerInvocation: null, continuationHook: null, capabilityPayload: null,
    createdAt: asTimestamp(1), updatedAt: asTimestamp(1), ...extra,
  };
}

describe("resetSessionRuntimeDefaults", () => {
  test("resets every main session regardless of legacy lock flags and skips busy/child sessions", async () => {
    const store = createFakeBindingStore();
    store.seedSession(session("plain"));
    store.seedSession(session("model-fixed", { modelLocked: true }));
    store.seedSession(session("effort-fixed", { effortLocked: true }));
    store.seedSession(session("busy", { status: "busy" }));
    store.seedSession(session("child", { scope: "child" }));

    const summary = await resetSessionRuntimeDefaults({ store, now: asTimestamp(100) });

    expect(await store.findSessionByName("plain")).toMatchObject({ model: null, effort: null });
    expect(await store.findSessionByName("model-fixed")).toMatchObject({ model: null, effort: null });
    expect(await store.findSessionByName("effort-fixed")).toMatchObject({ model: null, effort: null });
    expect(await store.findSessionByName("busy")).toMatchObject({ model: "gpt-5.6-sol", effort: "ultra" });
    expect(await store.findSessionByName("child")).toMatchObject({ model: "gpt-5.6-sol", effort: "ultra" });
    expect(summary).toMatchObject({ updatedSessions: 3, modelResetCount: 3, effortResetCount: 3, busySkipped: ["busy"] });
    expect(summary).not.toHaveProperty("modelFixed");
    expect(summary).not.toHaveProperty("effortFixed");
  });

  test("reports only busy sessions whose current tuple differs from their defaults", async () => {
    const store = createFakeBindingStore();
    store.seedSession(session("busy-drifted", { status: "busy" }));
    store.seedSession(session("busy-aligned", {
      status: "busy",
      model: null,
      effort: null,
    }));

    const summary = await resetSessionRuntimeDefaults({
      store,
      now: asTimestamp(100),
    });

    expect(summary).toMatchObject({
      updatedSessions: 0,
      busySkipped: ["busy-drifted"],
    });
  });

  test("uses each main session's Bitable-backed default tuple", async () => {
    const store = createFakeBindingStore();
    const first = session("first", { model: "gpt-5.6-sol", effort: "ultra" });
    const second = session("second", { model: "gpt-5.6-terra", effort: "high" });
    store.seedSession(first);
    store.seedSession(second);
    await store.updateSessionRuntimeSettings(first.id, {
      mainModelDefault: "gpt-5.5",
      mainEffortDefault: "xhigh",
    });
    await store.updateSessionRuntimeSettings(second.id, {
      mainModelDefault: "gpt-5.6-luna",
      mainEffortDefault: "ultra",
    });

    const summary = await resetSessionRuntimeDefaults({ store, now: asTimestamp(100) });

    expect(await store.findSessionByName("first")).toMatchObject({ model: "gpt-5.5", effort: "xhigh" });
    expect(await store.findSessionByName("second")).toMatchObject({ model: "gpt-5.6-luna", effort: "max" });
    expect(summary).toMatchObject({ updatedSessions: 2, modelResetCount: 2, effortResetCount: 2 });
  });

  test("resets only the main sessions whose Bitable defaults changed", async () => {
    const store = createFakeBindingStore();
    const changed = session("changed");
    const unchanged = session("unchanged");
    const busyChanged = session("busy-changed", { status: "busy" });
    store.seedSession(changed);
    store.seedSession(unchanged);
    store.seedSession(busyChanged);
    for (const target of [changed, unchanged, busyChanged]) {
      await store.updateSessionRuntimeSettings(target.id, {
        mainModelDefault: "gpt-5.6-terra",
        mainEffortDefault: "max",
      });
    }

    const summary = await resetSessionRuntimeDefaults({
      store,
      now: asTimestamp(100),
      targetSessionNames: ["changed", "busy-changed"],
    });

    expect(await store.findSessionByName("changed")).toMatchObject({
      model: "gpt-5.6-terra",
      effort: "max",
    });
    expect(await store.findSessionByName("unchanged")).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "ultra",
    });
    expect(await store.findSessionByName("busy-changed")).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "ultra",
    });
    expect(summary).toMatchObject({
      eligibleCount: 2,
      updatedSessions: 1,
      busySkipped: ["busy-changed"],
    });
  });

  test("applies valid sessions while reporting invalid Bitable-backed defaults", async () => {
    const store = createFakeBindingStore();
    const codex = session("codex");
    const kimi = session("kimi", { backend: "kimi", model: null, effort: null });
    store.seedSession(codex);
    store.seedSession(kimi);
    await store.updateSessionRuntimeSettings(codex.id, {
      mainModelDefault: "gpt-5.6-terra",
      mainEffortDefault: "max",
    });
    // K3 accepts an effort level since kimi-code 0.30.0, so the invalid
    // combo needs a fixed-on K2.7 model: an effort level there can never
    // control a run and must be reported instead of applied.
    await store.updateSessionRuntimeSettings(kimi.id, {
      mainModelDefault: "kimi-code/kimi-for-coding",
      mainEffortDefault: "high",
    });

    const summary = await resetSessionRuntimeDefaults({ store, now: asTimestamp(100) });

    expect(await store.findSessionByName("codex")).toMatchObject({
      model: "gpt-5.6-terra",
      effort: "max",
    });
    expect(await store.findSessionByName("kimi")).toMatchObject({ model: null, effort: null });
    expect(summary).toMatchObject({
      updatedSessions: 1,
      invalidDefaults: [{
        sessionName: "kimi",
        error: expect.stringMatching(/thinking 固定为 on/u),
      }],
    });
  });

  test("keeps other session resets when one per-session CAS conflicts", async () => {
    const store = createFakeBindingStore();
    store.seedSession(session("first"));
    store.seedSession(session("conflicted"));
    store.seedSession(session("last"));
    const apply = store.applySessionRuntimeConfigMutations.bind(store);
    store.applySessionRuntimeConfigMutations = async (mutations) => {
      if (mutations.some((mutation) => mutation.sessionId === asSessionId("conflicted"))) {
        throw new RuntimeConfigConflictError(asSessionId("conflicted"));
      }
      return apply(mutations);
    };

    const summary = await resetSessionRuntimeDefaults({ store, now: asTimestamp(100) });

    expect(await store.findSessionByName("first")).toMatchObject({ model: null, effort: null });
    expect(await store.findSessionByName("conflicted")).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "ultra",
    });
    expect(await store.findSessionByName("last")).toMatchObject({ model: null, effort: null });
    expect(summary).toMatchObject({
      updatedSessions: 2,
      modelResetCount: 2,
      effortResetCount: 2,
      busySkipped: ["conflicted"],
    });
  });
});
