import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  CODEX_MODEL_ALIASES,
  createSetModelHandler,
  resolveModelAlias,
} from "../../../src/app/commands/setModel.ts";
import { createSetEffortHandler } from "../../../src/app/commands/setEffort.ts";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";
import {
  getCodexBundledModels,
  resetCodexModelCatalogForTests,
} from "../../../src/ports/CodexModelCatalog.ts";

const TEST_CODEX_CATALOG = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.2",
];

function makeMsg(groupId: string, text: string) {
  return {
    groupId: asLarkGroupId(groupId),
    messageId: "m",
    userId: "u",
    text,
    attachments: [],
    receivedAtMs: 0,
  };
}

function seed(
  store: ReturnType<typeof createFakeBindingStore>,
  id: string,
  name: string,
  backend: "claude" | "codex",
  extra: Partial<Session> = {},
) {
  store.seedSession({
    id: asSessionId(id),
    name,
    alias: "",
    avatar: "", category: "", fpManaged: null,
    scope: "user",
    backend,
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath(`/ws/${name}`),
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
    createdAt: asTimestamp(1),
    updatedAt: asTimestamp(1),
    ...extra,
  });
}

describe("/model batch mode", () => {
  beforeEach(() => {
    resetCodexModelCatalogForTests(TEST_CODEX_CATALOG);
  });

  test("all-claude updates only claude sessions", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "a", "claude");
    seed(store, "s2", "b", "codex");
    seed(store, "s3", "c", "claude");
    const handler = createSetModelHandler({ store });
    const result = await handler({
      args: { name: "all-claude", model: "opus" },
      scope: "root",
      msg: makeMsg("oc_root", "/model all-claude opus"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("已更新 2 个 session");
    expect(result.replyText).toContain("backend=claude");
    expect(result.replyText).toContain("opus");
    expect((await store.findSessionByName("a"))?.model).toBe("claude-opus-5");
    expect((await store.findSessionByName("b"))?.model).toBeNull();
    expect((await store.findSessionByName("c"))?.model).toBe("claude-opus-5");
  });

  test("all updates every user scope session regardless of backend", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "a", "claude");
    seed(store, "s2", "b", "codex");
    const handler = createSetModelHandler({ store });
    const result = await handler({
      args: { name: "all", model: "default" },
      scope: "root",
      msg: makeMsg("oc_root", "/model all default"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("已更新 2 个 session");
    expect(result.replyText).toContain("default");
  });

  test("/model all-claude ignores retired main lock flags", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "claude-a", "claude");
    seed(store, "s2", "claude-b", "claude", { modelLocked: true });
    seed(store, "s3", "claude-c", "claude");

    const handler = createSetModelHandler({ store });
    const result = await handler({
      args: { name: "all-claude", model: "sonnet" },
      scope: "root",
      msg: makeMsg("oc_root", "/model all-claude sonnet"),
    });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("已更新 3 个");
    expect(result.replyText).not.toContain("跳过");
    expect((await store.findSessionByName("claude-a"))?.model).toBe("claude-sonnet-5");
    expect((await store.findSessionByName("claude-b"))?.model).toBe("claude-sonnet-5");
    expect((await store.findSessionByName("claude-c"))?.model).toBe("claude-sonnet-5");
  });

  test("skips deleted sessions", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "a", "claude");
    seed(store, "s2", "b", "claude", { status: "deleted" });
    const handler = createSetModelHandler({ store });
    const result = await handler({
      args: { name: "all-claude", model: "sonnet" },
      scope: "root",
      msg: makeMsg("oc_root", "/model all-claude sonnet"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("已更新 1 个 session");
  });

  test("batch keyword in user scope still resolves via group binding (not treated as batch)", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "all-claude", "claude");
    const handler = createSetModelHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "all-claude", id: asSessionId("s1") }),
    });
    const result = await handler({
      args: { model: "opus" },
      scope: "user",
      msg: makeMsg("oc_foo", "/model opus"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("session「all-claude」");
  });

  test("codex session stores full catalog codex model ID (no claude alias translation)", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "a", "codex");
    const handler = createSetModelHandler({ store });
    const result = await handler({
      args: { name: "a", model: "gpt-5.5" },
      scope: "root",
      msg: makeMsg("oc_root", "/model a gpt-5.5"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect((await store.findSessionByName("a"))?.model).toBe("gpt-5.5");
  });

  test("codex session rejects model outside current catalog and lists available models", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "a", "codex");
    const handler = createSetModelHandler({ store });
    await expect(
      handler({
        args: { name: "a", model: "gpt-5.3" },
        scope: "root",
        msg: makeMsg("oc_root", "/model a gpt-5.3"),
      }),
    ).rejects.toThrow(
      '未知 codex 模型 "gpt-5.3"。当前可用：gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna / gpt-5.5 / gpt-5.4 / gpt-5.4-mini',
    );
  });

  test("codex session rejects claude alias (prevents storing claude ID on codex)", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "a", "codex");
    const handler = createSetModelHandler({ store });
    await expect(
      handler({
        args: { name: "a", model: "sonnet" },
        scope: "root",
        msg: makeMsg("oc_root", "/model a sonnet"),
      }),
    ).rejects.toThrow(/claude 模型.*不能用于 codex/);
  });

  test("claude session rejects codex alias", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "a", "claude");
    const handler = createSetModelHandler({ store });
    await expect(
      handler({
        args: { name: "a", model: "gpt5.5" },
        scope: "root",
        msg: makeMsg("oc_root", "/model a gpt5.5"),
      }),
    ).rejects.toThrow(/codex 模型.*不能用于 claude/);
  });

  test("batch all resolves per-session backend", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "a", "claude");
    seed(store, "s2", "b", "codex");
    const handler = createSetModelHandler({ store });
    const result = await handler({
      args: { name: "all", model: "default" },
      scope: "root",
      msg: makeMsg("oc_root", "/model all default"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("已更新 2 个 session");
    // Using a claude alias on "all" should succeed for claude sessions, fail for codex
    const result2 = await handler({
      args: { name: "all", model: "opus" },
      scope: "root",
      msg: makeMsg("oc_root", "/model all opus"),
    });
    if (!("replyText" in result2)) throw new Error("expected replyText");
    expect(result2.replyText).toContain("未更新任何 session");
    expect(result2.replyText).toContain("失败 1");
    expect((await store.findSessionByName("a"))?.model).toBeNull();
    expect((await store.findSessionByName("b"))?.model).toBeNull();
  });

  test("all-codex clamps every tuple atomically without probing the model", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "sol", "codex", { model: "gpt-5.6-sol", effort: "ultra", backendSessionId: "resume-1" });
    seed(store, "s2", "luna", "codex", { model: "gpt-5.6-luna", effort: "max" });
    seed(store, "s3", "locked", "codex", { modelLocked: true, effort: "ultra" });
    const apply = vi.spyOn(store, "applySessionRuntimeConfigMutations");
    const probe = vi.fn(async () => ({ kind: "available" as const, checkedAt: 1 }));
    const handler = createSetModelHandler({ store, availability: { probe } });

    const result = await handler({ args: { name: "all-codex", model: "gpt-5.5" }, scope: "root", msg: makeMsg("oc_root", "") });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(probe).not.toHaveBeenCalled();
    expect((await store.findSessionByName("sol"))?.effort).toBe("xhigh");
    expect((await store.findSessionByName("sol"))?.backendSessionId).toBe("resume-1");
    expect((await store.findSessionByName("luna"))?.effort).toBe("xhigh");
    expect((await store.findSessionByName("locked"))?.model).toBe("gpt-5.5");
    expect(result.replyText).toContain("ultra→xhigh");
  });

  test("model default keeps null while clamping against the effective default without probing", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "legacy", "codex", { model: "gpt-5.5", effort: "ultra" });
    const probe = vi.fn(async () => ({ kind: "available" as const, checkedAt: 1 }));
    const handler = createSetModelHandler({ store, availability: { probe } });
    await handler({ args: { name: "legacy", model: "default" }, scope: "root", msg: makeMsg("oc_root", "") });
    const row = await store.findSessionByName("legacy");
    expect(probe).not.toHaveBeenCalled();
    expect(row?.model).toBeNull();
    expect(row?.effort).toBe("ultra");
  });

  test("persists the model without probing even when a transient probe is injected", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "a", "codex", { model: "gpt-5.4", effort: "high", backendSessionId: "resume" });
    const probe = vi.fn(async () => ({ kind: "transient_failure" as const, checkedAt: 1, reason: "timeout" }));
    const handler = createSetModelHandler({ store, availability: { probe } });
    await handler({ args: { name: "a", model: "gpt-5.5" }, scope: "root", msg: makeMsg("oc_root", "") });
    expect(probe).not.toHaveBeenCalled();
    expect(await store.findSessionByName("a")).toMatchObject({ model: "gpt-5.5" });
  });

  test("stale bulk conflict leaves every non-drifted selected tuple unchanged and surfaces failure", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "a", "codex", { model: "gpt-5.4", effort: "high", backendSessionId: "resume-a" });
    seed(store, "s2", "b", "codex", { model: "gpt-5.4", effort: "medium", backendSessionId: "resume-b" });
    const apply = vi.fn(async (mutations) => {
      await store.updateSessionModel(asSessionId("s2"), "gpt-5.6-luna");
      return store.applySessionRuntimeConfigMutations(mutations);
    });
    const handler = createSetModelHandler({
      store: { ...store, applySessionRuntimeConfigMutations: apply },
    });

    await expect(handler({ args: { name: "all-codex", model: "gpt-5.5" }, scope: "root", msg: makeMsg("oc_root", "") })).rejects.toThrow(/runtime config mutation conflict/i);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(await store.findSessionByName("a")).toMatchObject({ model: "gpt-5.4", effort: "high", backendSessionId: "resume-a" });
    expect(await store.findSessionByName("b")).toMatchObject({ model: "gpt-5.6-luna", effort: "medium", backendSessionId: "resume-b" });
  });
});

describe("resolveModelAlias", () => {
  beforeEach(() => {
    resetCodexModelCatalogForTests(TEST_CODEX_CATALOG);
  });

  test("claude aliases resolve to full claude model IDs", () => {
    expect(resolveModelAlias("fable", "claude")).toBe("claude-fable-5");
    expect(resolveModelAlias("fable5", "claude")).toBe("claude-fable-5");
    expect(resolveModelAlias("fable-5", "claude")).toBe("claude-fable-5");
    expect(resolveModelAlias("opus", "claude")).toBe("claude-opus-5");
    expect(resolveModelAlias("opus5", "claude")).toBe("claude-opus-5");
    expect(resolveModelAlias("opus-5", "claude")).toBe("claude-opus-5");
    expect(resolveModelAlias("opus4.8", "claude")).toBe("claude-opus-4-8");
    expect(resolveModelAlias("opus-4.8", "claude")).toBe("claude-opus-4-8");
    expect(resolveModelAlias("sonnet", "claude")).toBe("claude-sonnet-5");
    expect(resolveModelAlias("sonnet5", "claude")).toBe("claude-sonnet-5");
    expect(resolveModelAlias("sonnet-5", "claude")).toBe("claude-sonnet-5");
    expect(resolveModelAlias("sonnet4.6", "claude")).toBe("claude-sonnet-4-6");
    expect(resolveModelAlias("sonnet-4.6", "claude")).toBe("claude-sonnet-4-6");
    expect(resolveModelAlias("haiku", "claude")).toBe("claude-haiku-4-5-20251001");
  });

  test("codex aliases resolve for codex backend", () => {
    expect(resolveModelAlias("gpt5.6-sol", "codex")).toBe("gpt-5.6-sol");
    expect(resolveModelAlias("gpt5.6-terra", "codex")).toBe("gpt-5.6-terra");
    expect(resolveModelAlias("gpt5.6-luna", "codex")).toBe("gpt-5.6-luna");
    expect(resolveModelAlias("gpt5.5", "codex")).toBe("gpt-5.5");
  });

  test("codex alias targets stay inside the current catalog", () => {
    const catalog = new Set(getCodexBundledModels());
    expect(Object.values(CODEX_MODEL_ALIASES).every((target) => catalog.has(target))).toBe(true);
  });

  test("unknown strings pass through", () => {
    expect(resolveModelAlias("gpt-5.7-future", "codex")).toBe("gpt-5.7-future");
    expect(resolveModelAlias("claude-opus-4-8", "claude")).toBe("claude-opus-4-8");
  });

  test("claude alias on codex backend throws", () => {
    expect(() => resolveModelAlias("sonnet", "codex")).toThrow(/claude 模型/);
  });

  test("codex alias on claude backend throws", () => {
    expect(() => resolveModelAlias("gpt5.5", "claude")).toThrow(/codex 模型/);
  });
});

describe("/effort batch mode", () => {
  test("all-codex updates only codex sessions", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "a", "claude");
    seed(store, "s2", "b", "codex");
    const handler = createSetEffortHandler({ store });
    const result = await handler({
      args: { name: "all-codex", level: "high" },
      scope: "root",
      msg: makeMsg("oc_root", "/effort all-codex high"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("已更新 1 个 session");
    expect(result.replyText).toContain("backend=codex");
    expect(result.replyText).toContain("high");
    expect((await store.findSessionByName("a"))?.effort).toBeNull();
    expect((await store.findSessionByName("b"))?.effort).toBe("high");
  });

  test("all with default restores default on every session", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "a", "claude", { effort: "high" });
    seed(store, "s2", "b", "codex", { effort: "max" });
    const handler = createSetEffortHandler({ store });
    const result = await handler({
      args: { name: "all", level: "default" },
      scope: "root",
      msg: makeMsg("oc_root", "/effort all default"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("已更新 2 个 session");
    expect((await store.findSessionByName("a"))?.effort).toBeNull();
    expect((await store.findSessionByName("b"))?.effort).toBeNull();
  });

  test("invalid level is rejected before batch dispatch", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "a", "claude");
    const handler = createSetEffortHandler({ store });
    await expect(
      handler({
        args: { name: "all", level: "bogus" },
        scope: "root",
        msg: makeMsg("oc_root", "/effort all bogus"),
      }),
    ).rejects.toThrow(/无效的 effort level/);
  });

  test("all-codex rejects ultracode before persistence or Codex policy", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "sol", "codex", { model: "gpt-5.6-sol", effort: "high" });
    seed(store, "s2", "legacy", "codex", { model: "gpt-5.5", effort: "medium" });
    const apply = vi.spyOn(store, "applySessionRuntimeConfigMutations");
    const handler = createSetEffortHandler({ store });

    await expect(
      handler({
        args: { name: "all-codex", level: "ultracode" },
        scope: "root",
        msg: makeMsg("oc_root", "/effort all-codex ultracode"),
      }),
    ).rejects.toThrow(/Codex.*ultracode/);
    expect((await store.findSessionByName("sol"))?.effort).toBe("high");
    expect((await store.findSessionByName("legacy"))?.effort).toBe("medium");
    expect(apply).not.toHaveBeenCalled();
  });

  test("all-kimi targets only kimi sessions", async () => {
    const calls: any[] = [];
    const store = {
      findSessionByName: async () => null,
      updateSessionEffort: async () => {},
      updateSessionEffortLocked: async () => {},
      getBackendRuntimeDefaults: async () => null,
      updateBackendRuntimeDefaults: async () => {},
      listActiveSessionsByBackend: async (b?: any) => { calls.push(b); return []; },
      applySessionRuntimeConfigMutations: async () => ({ updated: 0 }),
      getPendingSessionRuntimeConfig: async () => null,
      queueSessionRuntimeConfigMutation: async () => {},
    };
    const handler = createSetEffortHandler({ store });
    await handler({
      args: { name: "all-kimi", level: "high" },
      scope: "root",
      msg: makeMsg("oc_root", "/effort all-kimi high"),
    });
    expect(calls).toEqual(["kimi"]);
  });

  test("codex gpt-5.6-sol session accepts ultra because the selected model supports it", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "sol", "codex", { model: "gpt-5.6-sol" });
    const handler = createSetEffortHandler({ store });

    const result = await handler({
      args: { name: "sol", level: "ultra" },
      scope: "root",
      msg: makeMsg("oc_root", "/effort sol ultra"),
    });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("effort 已切换为 ultra");
    expect((await store.findSessionByName("sol"))?.effort).toBe("ultra");
  });

  test("codex session rejects minimal because current catalog does not expose it", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "sol", "codex", { model: "gpt-5.6-sol" });
    const handler = createSetEffortHandler({ store });

    await expect(
      handler({
        args: { name: "sol", level: "minimal" },
        scope: "root",
        msg: makeMsg("oc_root", "/effort sol minimal"),
      }),
    ).rejects.toThrow(/无效的 effort level：minimal/);
    expect((await store.findSessionByName("sol"))?.effort).toBeNull();
  });

  test("single codex effort clamps above the selected model's supported level and reports effective value", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "legacy", "codex", { model: "gpt-5.5" });
    const handler = createSetEffortHandler({ store });

    const result = await handler({
      args: { name: "legacy", level: "ultra" },
      scope: "root",
      msg: makeMsg("oc_root", "/effort legacy ultra"),
    });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("ultra→xhigh");
    expect((await store.findSessionByName("legacy"))?.effort).toBe("xhigh");
  });

  test("claude session rejects codex-only ultra with backend-specific message", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "claude-a", "claude");
    const handler = createSetEffortHandler({ store });

    await expect(
      handler({
        args: { name: "claude-a", level: "ultra" },
        scope: "root",
        msg: makeMsg("oc_root", "/effort claude-a ultra"),
      }),
    ).rejects.toThrow(/^(?=.*Claude CLI)(?=.*max)(?=.*ultra)(?=.*Codex)/);
  });

  test("all-codex applies ultra only to models that support it and reports model-specific failures", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "sol", "codex", { model: "gpt-5.6-sol" });
    seed(store, "s2", "legacy", "codex", { model: "gpt-5.5" });
    const handler = createSetEffortHandler({ store });

    const result = await handler({
      args: { name: "all-codex", level: "ultra" },
      scope: "root",
      msg: makeMsg("oc_root", "/effort all-codex ultra"),
    });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("已更新 2 个 session");
    expect(result.replyText).toContain("ultra→xhigh");
    expect(result.replyText).not.toContain("sol:");
    expect(result.replyText).toContain("legacy");
    expect((await store.findSessionByName("sol"))?.effort).toBe("ultra");
    expect((await store.findSessionByName("legacy"))?.effort).toBe("xhigh");
  });

  test("all-codex ultra clamps each model and commits once", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "sol", "codex", { model: "gpt-5.6-sol" });
    seed(store, "s2", "luna", "codex", { model: "gpt-5.6-luna" });
    seed(store, "s3", "legacy", "codex", { model: "gpt-5.5" });
    const apply = vi.spyOn(store, "applySessionRuntimeConfigMutations");
    const handler = createSetEffortHandler({ store });
    await handler({ args: { name: "all-codex", level: "ultra" }, scope: "root", msg: makeMsg("oc_root", "") });
    expect(apply).toHaveBeenCalledTimes(1);
    expect((await store.findSessionByName("sol"))?.effort).toBe("ultra");
    expect((await store.findSessionByName("luna"))?.effort).toBe("max");
    expect((await store.findSessionByName("legacy"))?.effort).toBe("xhigh");
  });
});
