import { describe, expect, test, vi } from "vitest";
import { createSetBackendHandler } from "../../../src/app/commands/setBackend.ts";
import { createSetModelHandler } from "../../../src/app/commands/setModel.ts";
import { createSetEffortHandler } from "../../../src/app/commands/setEffort.ts";
import { createSpawnChildHandler } from "../../../src/app/commands/spawnChild.ts";
import type { SpawnChildInput, SpawnChildResult } from "../../../src/app/childSession.ts";
import { UserError } from "../../../src/domain/errors.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asSessionId,
  asTimestamp,
} from "../../../src/domain/ids.ts";
import type { BackendKind, Session } from "../../../src/domain/session.ts";
import type {
  ChildSessionDefaults,
  ChildSessionDefaultsPatch,
} from "../../../src/ports/ChildSessionDefaults.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";

const msg = {
  groupId: asLarkGroupId("oc_root"),
  messageId: "m",
  userId: "u",
  text: "",
  attachments: [],
  receivedAtMs: 0,
};

function childSession(
  name: string,
  backend: BackendKind = "codex",
  overrides: Partial<Session> = {},
): Session {
  return {
    id: asSessionId(`child-${name}`),
    name,
    alias: "",
    avatar: "",
    category: "",
    fpManaged: null,
    scope: "child",
    backend,
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    effortLocked: false,
    workdir: asAbsolutePath(`/tmp/${name}`),
    backendSessionId: null,
    chatName: null,
    purpose: "",
    status: "idle",
    parentId: null,
    depth: 1,
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
    ...overrides,
  };
}

function replyText(result: unknown): string {
  if (
    !result ||
    typeof result !== "object" ||
    !("replyText" in result) ||
    typeof result.replyText !== "string"
  ) {
    throw new Error("expected replyText");
  }
  return result.replyText;
}

function queuedSpawnResult(parentId: Session["id"]): SpawnChildResult {
  return {
    status: "queued",
    ref: "spawnq_child-defaults",
    commId: "comm_child-defaults",
    spawnCommId: "comm_child-defaults",
    parentId,
    queuedAt: asTimestamp(1),
    ttlSec: 86_400,
  };
}

type ChildDefaultsCasStore = {
  compareAndSetChildSessionDefaults(
    expected: ChildSessionDefaults,
    patch: ChildSessionDefaultsPatch,
  ): Promise<boolean>;
};

describe("global child defaults", () => {
  test("/backend global child configures a future-only backend and clears its tuple", async () => {
    const store = createFakeBindingStore();
    store.seedSession(childSession("child-model-locked", "claude", { modelLocked: true }));
    store.seedSession(childSession("child-effort-locked", "claude", { effortLocked: true }));
    await store.updateChildSessionDefaults({
      model: { configured: true, value: "claude-opus-4-8" },
      effort: { configured: true, value: "high" },
    });
    const backend = createSetBackendHandler({ store });

    const text = replyText(await backend({
      scope: "root",
      args: { name: "global", backend: "child", value: "codex" },
      msg,
    }));

    expect(await store.getChildSessionDefaults()).toMatchObject({
      backend: { configured: true, value: "codex" },
      model: { configured: false, value: null },
      effort: { configured: false, value: null },
    });
    expect(text).toContain("仅影响后续新建 child");
    expect(text).toContain("model: child-model-locked");
    expect(text).toContain("effort: child-effort-locked");
    expect(text).toContain("未调整");
  });

  test("/backend global child mirrors a changed system default to the session table", async () => {
    const store = createFakeBindingStore();
    const syncSessionTable = vi.fn();
    const backend = createSetBackendHandler({ store, syncSessionTable });

    await backend({
      scope: "root",
      args: { name: "global", backend: "child", value: "codex" },
      msg,
    });

    expect(syncSessionTable).toHaveBeenCalledOnce();
    expect(syncSessionTable).toHaveBeenCalledWith("current");
  });

  test("/backend global child inherit clears every configured child default", async () => {
    const store = createFakeBindingStore();
    await store.updateChildSessionDefaults({
      backend: { configured: true, value: "codex" },
      model: { configured: true, value: "gpt-5.5" },
      effort: { configured: true, value: "high" },
    });
    const backend = createSetBackendHandler({ store });

    await backend({
      scope: "root",
      args: { name: "global", backend: "child", value: "inherit" },
      msg,
    });

    expect(await store.getChildSessionDefaults()).toMatchObject({
      backend: { configured: false, value: null },
      model: { configured: false, value: null },
      effort: { configured: false, value: null },
    });
  });

  test("/model global child uses the configured backend and default remains an explicit null", async () => {
    const store = createFakeBindingStore();
    const backend = createSetBackendHandler({ store });
    const model = createSetModelHandler({ store });
    await backend({
      scope: "root",
      args: { name: "global", backend: "child", value: "codex" },
      msg,
    });

    await model({
      scope: "root",
      args: { name: "global", model: "child", value: "gpt-5.5" },
      msg,
    });
    expect((await store.getChildSessionDefaults()).model).toEqual({
      configured: true,
      value: "gpt-5.5",
    });

    await model({
      scope: "root",
      args: { name: "global", model: "child", value: "default" },
      msg,
    });
    expect((await store.getChildSessionDefaults()).model).toEqual({
      configured: true,
      value: null,
    });
  });

  test("/model global child mirrors a changed system default to the session table", async () => {
    const store = createFakeBindingStore();
    await store.updateChildSessionDefaults({
      backend: { configured: true, value: "codex" },
    });
    const syncSessionTable = vi.fn();
    const model = createSetModelHandler({ store, syncSessionTable });

    await model({
      scope: "root",
      args: { name: "global", model: "child", value: "gpt-5.5" },
      msg,
    });

    expect(syncSessionTable).toHaveBeenCalledOnce();
    expect(syncSessionTable).toHaveBeenCalledWith("current");
  });

  test("/model global child inherit clears the child model and effort overrides", async () => {
    const store = createFakeBindingStore();
    await store.updateChildSessionDefaults({
      backend: { configured: true, value: "codex" },
      model: { configured: true, value: "gpt-5.5" },
      effort: { configured: true, value: "high" },
    });
    const model = createSetModelHandler({ store });

    await model({
      scope: "root",
      args: { name: "global", model: "child", value: "inherit" },
      msg,
    });

    expect(await store.getChildSessionDefaults()).toMatchObject({
      backend: { configured: true, value: "codex" },
      model: { configured: false, value: null },
      effort: { configured: false, value: null },
    });
  });

  async function expectFableEffortIsClearedForFutureSpawn(
    value: string,
    expectedDefaultModel: { configured: boolean; value: string | null },
    expectedSpawnModel: string | null,
  ): Promise<void> {
    const store = createFakeBindingStore();
    const target = childSession("spawn-parent", "claude", {
      scope: "user",
      depth: 0,
      model: "claude-opus-4-8",
    });
    store.seedSession(target);
    await store.updateChildSessionDefaults({
      backend: { configured: true, value: "claude" },
      model: { configured: true, value: "claude-fable-5" },
      effort: { configured: true, value: "ultracode" },
    });

    const model = createSetModelHandler({ store });
    const mutation = replyText(await model({
      scope: "root",
      args: { name: "global", model: "child", value },
      msg,
    }));

    expect(mutation).toContain("effort 已重置为 inherit");
    expect(await store.getChildSessionDefaults()).toMatchObject({
      backend: { configured: true, value: "claude" },
      model: expectedDefaultModel,
      effort: { configured: false, value: null },
    });

    let spawnedInput: SpawnChildInput | undefined;
    const spawnChild = vi.fn(async (input: SpawnChildInput): Promise<SpawnChildResult> => {
      spawnedInput = input;
      return queuedSpawnResult(target.id);
    });
    const spawn = createSpawnChildHandler({
      store,
      childSession: { spawnChild },
      lark: { sendMessage: vi.fn(async () => {}) },
    });
    await spawn({
      scope: "root",
      args: { name: target.name, prompt: "do work" },
      msg,
    });

    expect(spawnChild).toHaveBeenCalledWith(expect.objectContaining({
      backend: "claude",
      model: expectedSpawnModel,
    }));
    expect(spawnedInput).not.toHaveProperty("effort");
  }

  test("concrete child model clears a Fable-only effort before future spawn", async () => {
    await expectFableEffortIsClearedForFutureSpawn(
      "sonnet",
      { configured: true, value: "claude-sonnet-5" },
      "claude-sonnet-5",
    );
  });

  test("default child model clears a Fable-only effort before future spawn", async () => {
    await expectFableEffortIsClearedForFutureSpawn(
      "default",
      { configured: true, value: null },
      null,
    );
  });

  test("inherit child model clears a Fable-only effort before future spawn", async () => {
    await expectFableEffortIsClearedForFutureSpawn(
      "inherit",
      { configured: false, value: null },
      "claude-opus-4-8",
    );
  });

  test("concrete child model and effort need a configured child backend", async () => {
    const store = createFakeBindingStore();
    const model = createSetModelHandler({ store });
    const effort = createSetEffortHandler({ store });

    await expect(model({
      scope: "root",
      args: { name: "global", model: "child", value: "gpt-5.5" },
      msg,
    })).rejects.toThrow(UserError);
    await expect(effort({
      scope: "root",
      args: { name: "global", level: "child", value: "high" },
      msg,
    })).rejects.toThrow(UserError);
    expect(await store.getChildSessionDefaults()).toMatchObject({
      model: { configured: false, value: null },
      effort: { configured: false, value: null },
    });
  });

  test("/effort global child normalizes Codex effort and rejects concrete Kimi effort", async () => {
    const store = createFakeBindingStore();
    const backend = createSetBackendHandler({ store });
    const model = createSetModelHandler({ store });
    const effort = createSetEffortHandler({ store });
    await backend({
      scope: "root",
      args: { name: "global", backend: "child", value: "codex" },
      msg,
    });
    await model({
      scope: "root",
      args: { name: "global", model: "child", value: "gpt-5.5" },
      msg,
    });
    await effort({
      scope: "root",
      args: { name: "global", level: "child", value: "ultra" },
      msg,
    });
    expect((await store.getChildSessionDefaults()).effort).toEqual({
      configured: true,
      value: "xhigh",
    });

    await backend({
      scope: "root",
      args: { name: "global", backend: "child", value: "kimi" },
      msg,
    });
    await expect(effort({
      scope: "root",
      args: { name: "global", level: "child", value: "high" },
      msg,
    })).rejects.toThrow(/thinking 固定为 on/);
  });

  test("/effort global child persists the K3-native level instead of the raw request alias", async () => {
    const store = createFakeBindingStore();
    const effort = createSetEffortHandler({ store });
    await store.updateChildSessionDefaults({
      backend: { configured: true, value: "kimi" },
      model: { configured: true, value: "kimi-code/k3" },
    });

    // Aliases must be stored as the native level execution actually applies
    // (medium→high, xhigh/ultra→max) — never as the raw request token.
    for (const [requested, stored] of [
      ["medium", "high"],
      ["xhigh", "max"],
      ["ultra", "max"],
      ["low", "low"],
      ["high", "high"],
    ] as const) {
      await effort({
        scope: "root",
        args: { name: "global", level: "child", value: requested },
        msg,
      });
      expect((await store.getChildSessionDefaults()).effort).toEqual({
        configured: true,
        value: stored,
      });
    }
  });

  test("/effort global child default is configured null and inherit removes it", async () => {
    const store = createFakeBindingStore();
    const effort = createSetEffortHandler({ store });

    await effort({
      scope: "root",
      args: { name: "global", level: "child", value: "default" },
      msg,
    });
    expect((await store.getChildSessionDefaults()).effort).toEqual({
      configured: true,
      value: null,
    });

    await effort({
      scope: "root",
      args: { name: "global", level: "child", value: "inherit" },
      msg,
    });
    expect((await store.getChildSessionDefaults()).effort).toEqual({
      configured: false,
      value: null,
    });
  });

  test("/effort global child mirrors a changed system default to the session table", async () => {
    const store = createFakeBindingStore();
    await store.updateChildSessionDefaults({
      backend: { configured: true, value: "codex" },
      model: { configured: true, value: "gpt-5.5" },
    });
    const syncSessionTable = vi.fn();
    const effort = createSetEffortHandler({ store, syncSessionTable });

    await effort({
      scope: "root",
      args: { name: "global", level: "child", value: "high" },
      msg,
    });

    expect(syncSessionTable).toHaveBeenCalledOnce();
    expect(syncSessionTable).toHaveBeenCalledWith("current");
  });

  test("/backend global child queries without writing", async () => {
    const store = createFakeBindingStore();
    await store.updateChildSessionDefaults({ backend: { configured: true, value: "claude" } });
    const update = vi.spyOn(store, "updateChildSessionDefaults");
    const syncSessionTable = vi.fn();
    const backend = createSetBackendHandler({ store, syncSessionTable });

    const text = replyText(await backend({
      scope: "root",
      args: { name: "global", backend: "child" },
      msg,
    }));

    expect(update).not.toHaveBeenCalled();
    expect(syncSessionTable).not.toHaveBeenCalled();
    expect(text).toContain("claude");
  });

  test("revalidates a child model after a concurrent backend switch clears its tuple", async () => {
    const store = createFakeBindingStore();
    const originalUpdate = store.updateChildSessionDefaults.bind(store);
    await originalUpdate({ backend: { configured: true, value: "codex" } });
    const racingStore = store as typeof store & Partial<ChildDefaultsCasStore>;
    let interleaved = false;
    vi.spyOn(store, "updateChildSessionDefaults").mockImplementation(async (patch) => {
      if (!interleaved && Object.hasOwn(patch, "model")) {
        interleaved = true;
        await originalUpdate({
          backend: { configured: true, value: "kimi" },
          model: { configured: false, value: null },
          effort: { configured: false, value: null },
        });
      }
      await originalUpdate(patch);
    });
    racingStore.compareAndSetChildSessionDefaults = async () => {
      if (!interleaved) {
        interleaved = true;
        await originalUpdate({
          backend: { configured: true, value: "kimi" },
          model: { configured: false, value: null },
          effort: { configured: false, value: null },
        });
      }
      return false;
    };

    await expect(createSetModelHandler({ store })({
      scope: "root",
      args: { name: "global", model: "child", value: "gpt-5.5" },
      msg,
    })).rejects.toThrow(/codex 模型/);
    expect(await store.getChildSessionDefaults()).toMatchObject({
      backend: { configured: true, value: "kimi" },
      model: { configured: false, value: null },
      effort: { configured: false, value: null },
    });
  });

  test("revalidates child effort after a concurrent backend switch clears its tuple", async () => {
    const store = createFakeBindingStore();
    const originalUpdate = store.updateChildSessionDefaults.bind(store);
    await originalUpdate({ backend: { configured: true, value: "codex" } });
    const racingStore = store as typeof store & Partial<ChildDefaultsCasStore>;
    let interleaved = false;
    vi.spyOn(store, "updateChildSessionDefaults").mockImplementation(async (patch) => {
      if (!interleaved && Object.hasOwn(patch, "effort")) {
        interleaved = true;
        await originalUpdate({
          backend: { configured: true, value: "kimi" },
          model: { configured: false, value: null },
          effort: { configured: false, value: null },
        });
      }
      await originalUpdate(patch);
    });
    racingStore.compareAndSetChildSessionDefaults = async () => {
      if (!interleaved) {
        interleaved = true;
        await originalUpdate({
          backend: { configured: true, value: "kimi" },
          model: { configured: false, value: null },
          effort: { configured: false, value: null },
        });
      }
      return false;
    };

    await expect(createSetEffortHandler({ store })({
      scope: "root",
      args: { name: "global", level: "child", value: "high" },
      msg,
    })).rejects.toThrow(/thinking 固定为 on/);
    expect(await store.getChildSessionDefaults()).toMatchObject({
      backend: { configured: true, value: "kimi" },
      model: { configured: false, value: null },
      effort: { configured: false, value: null },
    });
  });

  test("returns a retry error after two child-default CAS conflicts", async () => {
    const store = createFakeBindingStore();
    await store.updateChildSessionDefaults({ backend: { configured: true, value: "codex" } });
    const racingStore = store as typeof store & Partial<ChildDefaultsCasStore>;
    const compare = vi.fn(async () => false);
    racingStore.compareAndSetChildSessionDefaults = compare;

    await expect(createSetModelHandler({ store })({
      scope: "root",
      args: { name: "global", model: "child", value: "gpt-5.5" },
      msg,
    })).rejects.toThrow(/并发.*请重试/);
    expect(compare).toHaveBeenCalledTimes(2);
    expect((await store.getChildSessionDefaults()).model).toEqual({
      configured: false,
      value: null,
    });
  });
});
