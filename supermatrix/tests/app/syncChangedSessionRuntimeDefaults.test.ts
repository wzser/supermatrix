import { describe, expect, test } from "vitest";
import { syncChangedSessionRuntimeDefaults } from "../../src/app/resetSessionRuntimeDefaults.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";
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

describe("syncChangedSessionRuntimeDefaults", () => {
  test("pulls Bitable settings and applies only defaults that changed", async () => {
    const store = createFakeBindingStore();
    const changed = session("changed");
    const unchanged = session("unchanged");
    store.seedSession(changed);
    store.seedSession(unchanged);
    for (const target of [changed, unchanged]) {
      await store.updateSessionRuntimeSettings(target.id, {
        mainModelDefault: "gpt-5.6-sol",
        mainEffortDefault: "ultra",
      });
    }
    let pushes = 0;

    const summary = await syncChangedSessionRuntimeDefaults({
      store,
      now: asTimestamp(100),
      pull: async () => {
        await store.updateSessionRuntimeSettings(changed.id, {
          mainModelDefault: "gpt-5.6-terra",
          mainEffortDefault: "max",
        });
        await store.updateChildSessionDefaults({
          backend: { configured: true, value: "codex" },
        });
      },
      pushCurrent: async () => { pushes += 1; },
    });

    expect(await store.findSessionByName("changed")).toMatchObject({
      model: "gpt-5.6-terra",
      effort: "max",
    });
    expect(await store.findSessionByName("unchanged")).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "ultra",
    });
    expect(summary).toMatchObject({
      changedMainDefaultSessions: ["changed"],
      childDefaultsChanged: true,
      updatedSessions: 1,
      busySkipped: [],
      currentValuesPushedAfterReset: true,
      diffs: [
        {
          session: "changed",
          field: "主model默认值",
          from: "gpt-5.6-sol",
          to: "gpt-5.6-terra",
        },
        {
          session: "changed",
          field: "主effort默认值",
          from: "ultra",
          to: "max",
        },
        {
          session: "全局子session默认值",
          field: "子backend",
          from: "default",
          to: "codex",
        },
      ],
      truncated: 0,
    });
    expect(pushes).toBe(1);
    expect(store._listSessionRuntimeConfigAudit()).toEqual([
      expect.objectContaining({
        sessionId: changed.id,
        trigger: "bitable-runtime-settings-change",
      }),
    ]);
  });

  test("does not push when a workflow event contains no effective setting change", async () => {
    const store = createFakeBindingStore();
    const unchanged = session("unchanged");
    store.seedSession(unchanged);
    await store.updateSessionRuntimeSettings(unchanged.id, {
      mainModelDefault: "gpt-5.6-sol",
      mainEffortDefault: "ultra",
    });
    let pushes = 0;

    const summary = await syncChangedSessionRuntimeDefaults({
      store,
      now: asTimestamp(100),
      pull: async () => undefined,
      pushCurrent: async () => { pushes += 1; },
    });

    expect(summary).toMatchObject({
      changedMainDefaultSessions: [],
      childDefaultsChanged: false,
      updatedSessions: 0,
      currentValuesPushedAfterReset: false,
      diffs: [],
      truncated: 0,
    });
    expect(pushes).toBe(0);
  });

  test("syncs changed child defaults without waiting for busy main sessions", async () => {
    const store = createFakeBindingStore();
    const busy = session("busy", { status: "busy" });
    store.seedSession(busy);
    await store.updateSessionRuntimeSettings(busy.id, {
      mainModelDefault: "gpt-5.6-sol",
      mainEffortDefault: "ultra",
    });
    let pushes = 0;

    const summary = await syncChangedSessionRuntimeDefaults({
      store,
      now: asTimestamp(100),
      pull: async () => {
        await store.updateChildSessionDefaults({
          backend: { configured: true, value: "codex" },
        });
      },
      pushCurrent: async () => { pushes += 1; },
    });

    expect(await store.getChildSessionDefaults()).toMatchObject({
      backend: { configured: true, value: "codex" },
    });
    expect(summary).toMatchObject({
      changedMainDefaultSessions: [],
      childDefaultsChanged: true,
      busySkipped: [],
      currentValuesPushedAfterReset: true,
      diffs: [{
        session: "全局子session默认值",
        field: "子backend",
        from: "default",
        to: "codex",
      }],
      truncated: 0,
    });
    expect(pushes).toBe(1);
  });

  test("renders cleared settings as card-readable values instead of null", async () => {
    const store = createFakeBindingStore();
    const cleared = session("cleared");
    store.seedSession(cleared);
    await store.updateSessionRuntimeSettings(cleared.id, {
      mainModelDefault: "gpt-5.6-terra",
      mainEffortDefault: "max",
    });
    await store.updateChildSessionDefaults({
      model: { configured: true, value: "gpt-5.6-terra" },
      effort: { configured: true, value: "max" },
    });

    const summary = await syncChangedSessionRuntimeDefaults({
      store,
      now: asTimestamp(100),
      pull: async () => {
        await store.updateSessionRuntimeSettings(cleared.id, {
          mainModelDefault: null,
          mainEffortDefault: null,
        });
        await store.updateChildSessionDefaults({
          model: { configured: false, value: null },
          effort: { configured: false, value: null },
        });
      },
      pushCurrent: async () => undefined,
    });

    expect(summary.diffs).toEqual([
      {
        session: "cleared",
        field: "主model默认值",
        from: "gpt-5.6-terra",
        to: "空",
      },
      {
        session: "cleared",
        field: "主effort默认值",
        from: "max",
        to: "空",
      },
      {
        session: "全局子session默认值",
        field: "子model",
        from: "gpt-5.6-terra",
        to: "default",
      },
      {
        session: "全局子session默认值",
        field: "子effort",
        from: "max",
        to: "default",
      },
    ]);
    expect(JSON.stringify(summary.diffs)).not.toContain("null");
    expect(summary.truncated).toBe(0);
  });

  test("caps field diffs at 50 and reports how many were truncated", async () => {
    const store = createFakeBindingStore();
    const sessions = Array.from({ length: 26 }, (_, index) => session(
      `session-${String(index).padStart(2, "0")}`,
    ));
    for (const target of sessions) {
      store.seedSession(target);
      await store.updateSessionRuntimeSettings(target.id, {
        mainModelDefault: "gpt-5.6-sol",
        mainEffortDefault: "ultra",
      });
    }

    const summary = await syncChangedSessionRuntimeDefaults({
      store,
      now: asTimestamp(100),
      pull: async () => {
        for (const target of sessions) {
          await store.updateSessionRuntimeSettings(target.id, {
            mainModelDefault: "gpt-5.6-terra",
            mainEffortDefault: "max",
          });
        }
      },
      pushCurrent: async () => undefined,
    });

    expect(summary.diffs).toHaveLength(50);
    expect(summary.truncated).toBe(2);
    expect(summary.diffs[49]).toEqual({
      session: "session-24",
      field: "主effort默认值",
      from: "ultra",
      to: "max",
    });
  });
});
