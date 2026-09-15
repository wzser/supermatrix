import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSetModelHandler } from "../../../src/app/commands/setModel.ts";
import { createSetEffortHandler } from "../../../src/app/commands/setEffort.ts";
import {
  getConfiguredBackendRuntimeDefaults,
  resetConfiguredBackendRuntimeDefaultsForTests,
  setConfiguredBackendRuntimeDefaults,
  setEffectiveBackendRuntimeModel,
} from "../../../src/ports/BackendRuntimeDefaults.ts";
import {
  KIMI_DEFAULT_MODEL,
  KIMI_HIGHSPEED_MODEL,
  KIMI_K3_MODEL,
} from "../../../src/ports/KimiModelCatalog.ts";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";

const msg = {
  groupId: asLarkGroupId("oc_root"),
  messageId: "m",
  userId: "u",
  text: "",
  attachments: [],
  receivedAtMs: 0,
};

function session(): Session {
  return {
    id: asSessionId("s1"), name: "owner", alias: "", avatar: "", category: "", fpManaged: null,
    scope: "user", backend: "claude", model: null, effort: null, thinking: false,
    modelLocked: false, effortLocked: false, workdir: asAbsolutePath("/tmp/owner"),
    backendSessionId: null, chatName: null, purpose: "", status: "idle", parentId: null,
    depth: 0, inactivityTimeoutS: null, maxRuntimeS: null, childType: null, triggerKind: null,
    postIdentity: null, callerInvocation: null, continuationHook: null, capabilityPayload: null,
    createdAt: asTimestamp(1), updatedAt: asTimestamp(1),
  };
}

describe("global backend runtime defaults", () => {
  beforeEach(() => resetConfiguredBackendRuntimeDefaultsForTests());
  afterEach(() => vi.unstubAllEnvs());

  test("/model global codex persists and applies the configured default", async () => {
    const store = createFakeBindingStore();
    const handler = createSetModelHandler({ store });
    const result = await handler({
      args: { name: "global", model: "codex", value: "gpt5.6-terra" }, scope: "root", msg,
    });
    expect(result).toMatchObject({ replyText: expect.stringContaining("gpt-5.6-terra") });
    expect(await store.getBackendRuntimeDefaults("codex")).toMatchObject({ model: "gpt-5.6-terra" });
    expect(getConfiguredBackendRuntimeDefaults("codex").model).toBe("gpt-5.6-terra");
  });

  for (const value of ["默认", "ＤＥＦＡＵＬＴ"]) {
    test(`/model global codex ${value} resets to the runtime default without probing the alias`, async () => {
      const store = createFakeBindingStore();
      const probe = vi.fn(async () => ({ kind: "available" as const, checkedAt: 1 }));
      const handler = createSetModelHandler({ store, availability: { probe } });
      const result = await handler({
        args: { name: "global", model: "codex", value }, scope: "root", msg,
      });
      expect(result).toMatchObject({ replyText: expect.stringContaining("codex 全局默认 model 已设置为 default") });
      expect(await store.getBackendRuntimeDefaults("codex")).toMatchObject({ model: null });
      expect(getConfiguredBackendRuntimeDefaults("codex").model).toBeNull();
      expect(probe).not.toHaveBeenCalled();
    });
  }

  test("/effort global claude persists and applies the configured default", async () => {
    const store = createFakeBindingStore();
    const handler = createSetEffortHandler({ store });
    const result = await handler({
      args: { name: "global", level: "claude", value: "high" }, scope: "root", msg,
    });
    expect(result).toMatchObject({ replyText: expect.stringContaining("high") });
    expect(await store.getBackendRuntimeDefaults("claude")).toMatchObject({ effort: "high" });
    expect(getConfiguredBackendRuntimeDefaults("claude").effort).toBe("high");
  });

  test("/model global reports configured and verified effective Codex defaults separately", async () => {
    const store = createFakeBindingStore();
    setConfiguredBackendRuntimeDefaults("codex", { model: "gpt-5.6-sol" });
    setEffectiveBackendRuntimeModel("codex", "gpt-5.4");
    const result = await createSetModelHandler({ store })({
      args: { name: "global" }, scope: "root", msg,
    });
    expect(result).toMatchObject({
      replyText: expect.stringContaining("configured=gpt-5.6-sol, effective=gpt-5.4"),
    });
  });

  test("/model without positional args reports read-only defaults for all three backends", async () => {
    const store = createFakeBindingStore();
    setConfiguredBackendRuntimeDefaults("claude", { model: "claude-sonnet-5" });
    setConfiguredBackendRuntimeDefaults("codex", { model: "gpt-5.6-sol" });
    setEffectiveBackendRuntimeModel("codex", "gpt-5.5");
    const apply = vi.spyOn(store, "applySessionRuntimeConfigMutations");
    const updateDefaults = vi.spyOn(store, "updateBackendRuntimeDefaults");
    const syncSessionTable = vi.fn();

    const result = await createSetModelHandler({ store, syncSessionTable })({
      args: {}, scope: "root", msg,
    });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("claude: configured=claude-sonnet-5, effective=claude-sonnet-5");
    expect(result.replyText).toContain("codex: configured=gpt-5.6-sol, effective=gpt-5.5");
    expect(result.replyText).toContain(`kimi: configured=default, effective=${KIMI_DEFAULT_MODEL}`);
    expect(result.replyText).toContain("/model global <claude|codex|kimi> <model-id|default>");
    expect(apply).not.toHaveBeenCalled();
    expect(updateDefaults).not.toHaveBeenCalled();
    expect(syncSessionTable).not.toHaveBeenCalled();
    expect(getConfiguredBackendRuntimeDefaults("claude").model).toBe("claude-sonnet-5");
  });

  test("/model without positional args falls back to SM_CLAUDE_DEFAULT_MODEL then the runtime default", async () => {
    const store = createFakeBindingStore();
    const handler = createSetModelHandler({ store });
    const claudeLine = async () => {
      const result = await handler({ args: {}, scope: "root", msg });
      if (!("replyText" in result)) throw new Error("expected replyText");
      return result.replyText.split("\n").find((line) => line.startsWith("claude: "));
    };

    vi.stubEnv("SM_CLAUDE_DEFAULT_MODEL", "claude-haiku-4-5-20251001");
    expect(await claudeLine()).toBe("claude: configured=default, effective=claude-haiku-4-5-20251001");

    vi.stubEnv("SM_CLAUDE_DEFAULT_MODEL", undefined);
    expect(await claudeLine()).toBe("claude: configured=default, effective=claude-opus-4-8");
  });

  test("/model global reports all three configurable backend defaults", async () => {
    const store = createFakeBindingStore();
    setConfiguredBackendRuntimeDefaults("kimi", { model: KIMI_K3_MODEL });
    const result = await createSetModelHandler({ store })({
      args: { name: "global" }, scope: "root", msg,
    });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("全局默认 model：");
    expect(result.replyText).toContain("claude: configured=");
    expect(result.replyText).toContain("codex: configured=");
    expect(result.replyText).toContain(`kimi: configured=${KIMI_K3_MODEL}, effective=${KIMI_K3_MODEL}`);
  });

  test("/model global kimi k3 persists the canonical id and applies it to the runtime", async () => {
    const store = createFakeBindingStore();
    const syncSessionTable = vi.fn();
    const result = await createSetModelHandler({ store, syncSessionTable })({
      args: { name: "global", model: "kimi", value: "k3" }, scope: "root", msg,
    });

    expect(result).toMatchObject({
      replyText: `✓ kimi 全局默认 model 已设置为 ${KIMI_K3_MODEL}`,
    });
    expect(await store.getBackendRuntimeDefaults("kimi")).toMatchObject({ model: KIMI_K3_MODEL });
    expect(getConfiguredBackendRuntimeDefaults("kimi").model).toBe(KIMI_K3_MODEL);
    expect(syncSessionTable).toHaveBeenCalledWith("current");
  });

  test.each([["k3", KIMI_K3_MODEL], ["highspeed", KIMI_HIGHSPEED_MODEL], [KIMI_K3_MODEL, KIMI_K3_MODEL]])(
    "/model global kimi %s resolves against the kimi catalog",
    async (input, expected) => {
      const store = createFakeBindingStore();
      await createSetModelHandler({ store })({
        args: { name: "global", model: "kimi", value: input }, scope: "root", msg,
      });
      expect(getConfiguredBackendRuntimeDefaults("kimi").model).toBe(expected);
    },
  );

  test("/model global kimi rejects a model outside the kimi catalog without writing", async () => {
    const store = createFakeBindingStore();
    const updateDefaults = vi.spyOn(store, "updateBackendRuntimeDefaults");
    await expect(createSetModelHandler({ store })({
      args: { name: "global", model: "kimi", value: "kimi-code/k9" }, scope: "root", msg,
    })).rejects.toThrow(/未知 kimi 模型/u);
    expect(updateDefaults).not.toHaveBeenCalled();
    expect(getConfiguredBackendRuntimeDefaults("kimi").model).toBeNull();
  });

  test("/model global kimi rejects another backend's model", async () => {
    const store = createFakeBindingStore();
    await expect(createSetModelHandler({ store })({
      args: { name: "global", model: "kimi", value: "gpt-5.5" }, scope: "root", msg,
    })).rejects.toThrow(/codex 模型/u);
  });

  test("/model global kimi default clears the override so the catalog fallback applies again", async () => {
    const store = createFakeBindingStore();
    const handler = createSetModelHandler({ store });
    await handler({ args: { name: "global", model: "kimi", value: "k3" }, scope: "root", msg });

    const result = await handler({
      args: { name: "global", model: "kimi", value: "default" }, scope: "root", msg,
    });

    expect(result).toMatchObject({ replyText: "✓ kimi 全局默认 model 已设置为 default" });
    expect(await store.getBackendRuntimeDefaults("kimi")).toMatchObject({ model: null });
    expect(getConfiguredBackendRuntimeDefaults("kimi").model).toBeNull();

    const overview = await handler({ args: { name: "global" }, scope: "root", msg });
    if (!("replyText" in overview)) throw new Error("expected replyText");
    expect(overview.replyText).toContain(`kimi: configured=default, effective=${KIMI_DEFAULT_MODEL}`);
  });

  test("/model global rejects a backend outside claude / codex / kimi", async () => {
    const store = createFakeBindingStore();
    await expect(createSetModelHandler({ store })({
      args: { name: "global", model: "gemini", value: "k3" }, scope: "root", msg,
    })).rejects.toThrow("global model 当前支持 backend：claude / codex / kimi");
  });

  test("/model global kimi without a value reports the three-backend usage", async () => {
    const store = createFakeBindingStore();
    await expect(createSetModelHandler({ store })({
      args: { name: "global", model: "kimi" }, scope: "root", msg,
    })).rejects.toThrow("用法：/model global <claude|codex|kimi> <model-id|default>");
  });

  test.each([
    ["low", "low"],
    ["medium", "high"],
    ["high", "high"],
    ["xhigh", "max"],
    ["max", "max"],
    ["ultra", "max"],
  ] as const)("/effort global kimi %s persists K3 native %s", async (requested, expected) => {
    const store = createFakeBindingStore();
    const model = createSetModelHandler({ store });
    const effort = createSetEffortHandler({ store });
    await model({ args: { name: "global", model: "kimi", value: "k3" }, scope: "root", msg });

    const result = await effort({
      args: { name: "global", level: "kimi", value: requested }, scope: "root", msg,
    });

    expect(result).toMatchObject({ replyText: expect.stringContaining(`已设置为 ${expected}`) });
    expect(await store.getBackendRuntimeDefaults("kimi")).toMatchObject({ effort: expected });
    expect(getConfiguredBackendRuntimeDefaults("kimi").effort).toBe(expected);
  });

  test("/effort global kimi rejects a concrete level for effective K2.7 without writing", async () => {
    const store = createFakeBindingStore();
    const persist = vi.spyOn(store, "updateBackendRuntimeDefaults");
    await expect(createSetEffortHandler({ store })({
      args: { name: "global", level: "kimi", value: "high" }, scope: "root", msg,
    })).rejects.toThrow(/thinking 固定为 on/);
    expect(persist).not.toHaveBeenCalled();
    expect(await store.getBackendRuntimeDefaults("kimi")).toBeNull();
  });

  test("/effort global kimi default clears a configured K3 effort", async () => {
    const store = createFakeBindingStore();
    const model = createSetModelHandler({ store });
    const effort = createSetEffortHandler({ store });
    await model({ args: { name: "global", model: "kimi", value: "k3" }, scope: "root", msg });
    await effort({ args: { name: "global", level: "kimi", value: "high" }, scope: "root", msg });

    const result = await effort({
      args: { name: "global", level: "kimi", value: "default" }, scope: "root", msg,
    });

    expect(result).toMatchObject({ replyText: expect.stringContaining("kimi 全局默认 effort 已设置为 default") });
    expect(await store.getBackendRuntimeDefaults("kimi")).toMatchObject({ effort: null });
    expect(getConfiguredBackendRuntimeDefaults("kimi").effort).toBeNull();
  });

  test("/effort global readback distinguishes configured and effective values for all three backends", async () => {
    const store = createFakeBindingStore();
    const handler = createSetEffortHandler({ store });
    setConfiguredBackendRuntimeDefaults("claude", { effort: "high" });
    setConfiguredBackendRuntimeDefaults("codex", { effort: "ultra" });
    setConfiguredBackendRuntimeDefaults("kimi", { model: KIMI_K3_MODEL, effort: "medium" });

    const result = await handler({ args: { name: "global" }, scope: "root", msg });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("claude: configured=high, effective=high");
    expect(result.replyText).toContain("codex: configured=ultra, effective=ultra");
    expect(result.replyText).toContain(`kimi: model=${KIMI_K3_MODEL}, configured=medium, effective=high`);
  });

  test.each([
    ["highspeed", KIMI_HIGHSPEED_MODEL],
    ["default", null],
  ] as const)("/model global kimi %s clears stale K3 global effort atomically", async (value, expectedModel) => {
    const store = createFakeBindingStore();
    const model = createSetModelHandler({ store });
    const effort = createSetEffortHandler({ store });
    await model({ args: { name: "global", model: "kimi", value: "k3" }, scope: "root", msg });
    await effort({ args: { name: "global", level: "kimi", value: "max" }, scope: "root", msg });
    const update = vi.spyOn(store, "updateBackendRuntimeDefaults");

    await model({ args: { name: "global", model: "kimi", value }, scope: "root", msg });

    expect(update).toHaveBeenLastCalledWith("kimi", { model: expectedModel, effort: null });
    expect(await store.getBackendRuntimeDefaults("kimi")).toMatchObject({ model: expectedModel, effort: null });
    expect(getConfiguredBackendRuntimeDefaults("kimi")).toMatchObject({ model: expectedModel, effort: null });
    const readback = await effort({ args: { name: "global" }, scope: "root", msg });
    if (!("replyText" in readback)) throw new Error("expected replyText");
    expect(readback.replyText).toContain("configured=default, effective=fixed-on (thinking on)");
  });

  test.each(["Fixed", "Unfixed", "lock", "解锁"])("/effort %s rejects the retired main fixed feature", async (level) => {
    const store = createFakeBindingStore();
    store.seedSession(session());
    const handler = createSetEffortHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "owner", id: asSessionId("s1") }),
    });
    const userMsg = { ...msg, groupId: asLarkGroupId("oc_user") };
    await expect(handler({ args: { level }, scope: "user", msg: userMsg })).rejects.toThrow(/Fixed\/Unfixed 已退役/u);
    expect((await store.findSessionByName("owner"))?.effortLocked).toBe(false);
  });

  test("bulk effort ignores retired main effort lock flags", async () => {
    const store = createFakeBindingStore();
    store.seedSession({ ...session(), effort: "high", effortLocked: true });
    const handler = createSetEffortHandler({ store });
    const result = await handler({
      args: { name: "all-claude", level: "default" }, scope: "root", msg,
    });
    expect(result).toMatchObject({ replyText: expect.not.stringContaining("锁定 session") });
    expect((await store.findSessionByName("owner"))?.effort).toBeNull();
  });
});
