import { beforeEach, describe, expect, test, vi } from "vitest";
import { createSetEffortHandler } from "../../../src/app/commands/setEffort.ts";
import { createSetModelHandler } from "../../../src/app/commands/setModel.ts";
import { UserError } from "../../../src/domain/errors.ts";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import { resetConfiguredBackendRuntimeDefaultsForTests } from "../../../src/ports/BackendRuntimeDefaults.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";

beforeEach(() => resetConfiguredBackendRuntimeDefaultsForTests());

function makeMsg(groupId: string, text: string) {
  return { groupId: asLarkGroupId(groupId), messageId: "m", userId: "u", text, attachments: [], receivedAtMs: 0 };
}

function seed(
  store: ReturnType<typeof createFakeBindingStore>,
  id: string,
  name: string,
  backend: "claude" | "codex",
  extra: Partial<Session> = {},
) {
  store.seedSession({
    id: asSessionId(id), name, alias: "", avatar: "", category: "", fpManaged: null,
    scope: "user", backend, model: null, effort: "high", thinking: false, modelLocked: false,
    effortLocked: false, workdir: asAbsolutePath(`/ws/${name}`), backendSessionId: null,
    chatName: null, purpose: "", status: "idle", parentId: null, depth: 0,
    inactivityTimeoutS: null, maxRuntimeS: null, childType: null, triggerKind: null,
    postIdentity: null, callerInvocation: null, continuationHook: null, capabilityPayload: null,
    createdAt: asTimestamp(1), updatedAt: asTimestamp(1), ...extra,
  });
}

describe("/effort input aliases", () => {
  test("successful effort mutation requests a session-table sync", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "codex-a", "codex");
    const syncSessionTable = vi.fn();
    const handler = createSetEffortHandler({ store, syncSessionTable });

    await handler({
      scope: "root",
      args: { name: "codex-a", level: "medium" },
      msg: makeMsg("oc_root", "/effort codex-a medium"),
    });

    expect(syncSessionTable).toHaveBeenCalledOnce();
    expect(syncSessionTable).toHaveBeenCalledWith("current");
  });

  for (const t of ["默认", "DEFAULT"]) {
    test(`${t} resets effort to default`, async () => {
      const store = createFakeBindingStore();
      seed(store, "s1", "codex-a", "codex");
      const handler = createSetEffortHandler({
        store,
        resolveUserGroupSession: async () => ({ name: "codex-a", id: asSessionId("s1") }),
      });

      const r = await handler({ scope: "user", args: { name: "", level: t }, msg: makeMsg("oc_codex", `/effort ${t}`) });

      if (!("replyText" in r)) throw new Error("expected replyText");
      expect(r.replyText).toContain("已恢复默认 effort");
      expect((await store.findSessionByName("codex-a"))?.effort).toBeNull();
    });
  }

  test("ULTRA canonicalizes to ultra and is accepted on a codex session", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "codex-a", "codex");
    const handler = createSetEffortHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "codex-a", id: asSessionId("s1") }),
    });

    const r = await handler({ scope: "user", args: { name: "", level: "ULTRA" }, msg: makeMsg("oc_codex", "/effort ULTRA") });

    if (!("replyText" in r)) throw new Error("expected replyText");
    expect((await store.findSessionByName("codex-a"))?.effort).toBe("ultra");
  });

  test("full-width ULTRA canonicalizes to ultra and is accepted on a codex session", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "codex-a", "codex");
    const handler = createSetEffortHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "codex-a", id: asSessionId("s1") }),
    });

    const r = await handler({ scope: "user", args: { name: "", level: "ＵＬＴＲＡ" }, msg: makeMsg("oc_codex", "/effort ＵＬＴＲＡ") });

    if (!("replyText" in r)) throw new Error("expected replyText");
    expect((await store.findSessionByName("codex-a"))?.effort).toBe("ultra");
  });

  test("ULTRA on a claude session keeps the existing rejection", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "claude-a", "claude");
    const handler = createSetEffortHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "claude-a", id: asSessionId("s1") }),
    });

    await expect(
      handler({ scope: "user", args: { name: "", level: "ULTRA" }, msg: makeMsg("oc_claude", "/effort ULTRA") }),
    ).rejects.toThrow(UserError);
  });

  test.each(["claude-fable-5", "fable"] as const)("Claude Fable model %s accepts ultracode", async (model) => {
    const store = createFakeBindingStore();
    seed(store, "s1", "claude-fable", "claude", { model });
    const handler = createSetEffortHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "claude-fable", id: asSessionId("s1") }),
    });

    const result = await handler({
      scope: "user", args: { name: "", level: "ultracode" }, msg: makeMsg("oc_claude", "/effort ultracode"),
    });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("ultracode");
    expect((await store.findSessionByName("claude-fable"))?.effort).toBe("ultracode");
  });

  test("ULTRA on a Claude Fable session names ultracode and leaves effort unchanged", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "claude-fable", "claude", { model: "fable" });
    const apply = vi.spyOn(store, "applySessionRuntimeConfigMutations");
    const handler = createSetEffortHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "claude-fable", id: asSessionId("s1") }),
    });

    await expect(
      handler({ scope: "user", args: { name: "", level: "ULTRA" }, msg: makeMsg("oc_claude", "/effort ULTRA") }),
    ).rejects.toThrow(/正确.*ultracode/);
    expect((await store.findSessionByName("claude-fable"))?.effort).toBe("high");
    expect(apply).not.toHaveBeenCalled();
  });

  test("ultracode fails closed for a non-Fable Claude session before persistence", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "claude-opus", "claude", { model: "claude-opus-4-8" });
    const apply = vi.spyOn(store, "applySessionRuntimeConfigMutations");
    const handler = createSetEffortHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "claude-opus", id: asSessionId("s1") }),
    });

    await expect(
      handler({ scope: "user", args: { name: "", level: "ultracode" }, msg: makeMsg("oc_claude", "/effort ultracode") }),
    ).rejects.toThrow(/ultracode.*Fable/);
    expect((await store.findSessionByName("claude-opus"))?.effort).toBe("high");
    expect(apply).not.toHaveBeenCalled();
  });

  test("global Claude ultracode fails closed before persistence", async () => {
    const store = createFakeBindingStore();
    const persist = vi.spyOn(store, "updateBackendRuntimeDefaults");
    const handler = createSetEffortHandler({ store });

    await expect(
      handler({ scope: "root", args: { name: "global", level: "claude", value: "ultracode" }, msg: makeMsg("oc_root", "/effort global claude ultracode") }),
    ).rejects.toThrow(/全局默认.*Fable/);
    expect(persist).not.toHaveBeenCalled();
  });

  test("single Codex ultracode fails closed before persistence", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "codex-a", "codex", { model: "gpt-5.6-sol" });
    const apply = vi.spyOn(store, "applySessionRuntimeConfigMutations");
    const handler = createSetEffortHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "codex-a", id: asSessionId("s1") }),
    });

    await expect(
      handler({ scope: "user", args: { name: "", level: "ultracode" }, msg: makeMsg("oc_codex", "/effort ultracode") }),
    ).rejects.toThrow(/Codex.*ultracode/);
    expect((await store.findSessionByName("codex-a"))?.effort).toBe("high");
    expect(apply).not.toHaveBeenCalled();
  });

  test("global Codex ultracode fails closed before persistence", async () => {
    const store = createFakeBindingStore();
    const persist = vi.spyOn(store, "updateBackendRuntimeDefaults");
    const handler = createSetEffortHandler({ store });

    await expect(
      handler({ scope: "root", args: { name: "global", level: "codex", value: "ultracode" }, msg: makeMsg("oc_root", "/effort global codex ultracode") }),
    ).rejects.toThrow(/Codex.*ultracode/);
    expect(persist).not.toHaveBeenCalled();
  });

  test("global codex 默认 resets the configured runtime-default effort", async () => {
    const store = createFakeBindingStore();
    const handler = createSetEffortHandler({ store });

    const r = await handler({ scope: "root", args: { name: "global", level: "codex", value: "默认" }, msg: makeMsg("oc_root", "/effort global codex 默认") });

    if (!("replyText" in r)) throw new Error("expected replyText");
    expect(r.replyText).toContain("codex 全局默认 effort 已设置为 default");
    expect(await store.getBackendRuntimeDefaults("codex")).toMatchObject({ effort: null });
  });
});

describe("/effort — kimi model-aware thinking levels (kimi-code 0.30.0)", () => {
  function seedKimi(store: ReturnType<typeof createFakeBindingStore>, id: string, name: string, extra: Partial<Session> = {}) {
    store.seedSession({
      id: asSessionId(id), name, alias: "", avatar: "", category: "", fpManaged: null,
      scope: "user", backend: "kimi", model: null, effort: null, thinking: false, modelLocked: false,
      effortLocked: false, workdir: asAbsolutePath(`/ws/${name}`), backendSessionId: null,
      chatName: null, purpose: "", status: "idle", parentId: null, depth: 0,
      inactivityTimeoutS: null, maxRuntimeS: null, childType: null, triggerKind: null,
      postIdentity: null, callerInvocation: null, continuationHook: null, capabilityPayload: null,
      createdAt: asTimestamp(1), updatedAt: asTimestamp(1), ...extra,
    });
  }

  test("K2.7 session (fixed on) rejects an explicit level at admission", async () => {
    const store = createFakeBindingStore();
    seedKimi(store, "k1", "kimi-a", { effort: "high" });
    const apply = vi.spyOn(store, "applySessionRuntimeConfigMutations");
    const handler = createSetEffortHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "kimi-a", id: asSessionId("k1") }),
    });

    await expect(
      handler({ scope: "user", args: { name: "", level: "high" }, msg: makeMsg("oc_kimi", "/effort high") }),
    ).rejects.toThrow(/thinking 固定/);
    expect((await store.findSessionByName("kimi-a"))?.effort).toBe("high"); // unchanged
    expect(apply).not.toHaveBeenCalled();
  });

  test("busy K2.7 accepts /model k3 then /effort max against the projected tuple", async () => {
    const store = createFakeBindingStore();
    seedKimi(store, "k1", "kimi-a", { status: "busy" });
    const model = createSetModelHandler({ store });
    const effort = createSetEffortHandler({ store });

    const modelResult = await model({
      scope: "root",
      args: { name: "kimi-a", model: "k3" },
      msg: makeMsg("oc_root", "/model kimi-a k3"),
    });
    const effortResult = await effort({
      scope: "root",
      args: { name: "kimi-a", level: "max" },
      msg: makeMsg("oc_root", "/effort kimi-a max"),
    });

    if (!("replyText" in modelResult) || !("replyText" in effortResult)) {
      throw new Error("expected queue receipts");
    }
    expect(modelResult.replyText).toContain("已排队，将在当前 run 结束后生效");
    expect(effortResult.replyText).toContain("已排队，将在当前 run 结束后生效");
    expect(await store.findSessionByName("kimi-a")).toMatchObject({
      status: "busy",
      model: null,
      effort: null,
    });
    expect(store._getPendingSessionRuntimeConfig(asSessionId("k1"))?.projected).toMatchObject({
      backend: "kimi",
      model: "kimi-code/k3",
      effort: "max",
    });
    await store.updateSessionStatus(asSessionId("k1"), "idle", asTimestamp(2));
    await expect(store.drainPendingSessionRuntimeConfig(asSessionId("k1"))).resolves.toEqual({ kind: "applied" });
    expect(await store.findSessionByName("kimi-a")).toMatchObject({
      status: "idle",
      model: "kimi-code/k3",
      effort: "max",
    });
  });

  test("K2.7 highspeed session also rejects an explicit level", async () => {
    const store = createFakeBindingStore();
    seedKimi(store, "k1", "kimi-fast", { model: "kimi-code/kimi-for-coding-highspeed" });
    const handler = createSetEffortHandler({ store });

    await expect(
      handler({ scope: "root", args: { name: "kimi-fast", level: "low" }, msg: makeMsg("oc_root", "/effort kimi-fast low") }),
    ).rejects.toThrow(/thinking 固定/);
  });

  test.each([
    ["low", "low"],
    ["medium", "high"],
    ["high", "high"],
    ["xhigh", "max"],
    ["max", "max"],
    ["ultra", "max"],
  ] as const)("K3 session maps requested %s to native %s", async (requested, expected) => {
    const store = createFakeBindingStore();
    seedKimi(store, "k1", "kimi-k3", { model: "kimi-code/k3" });
    const handler = createSetEffortHandler({ store });

    const r = await handler({ scope: "root", args: { name: "kimi-k3", level: requested }, msg: makeMsg("oc_root", "") });
    if (!("replyText" in r)) throw new Error("expected replyText");
    expect((await store.findSessionByName("kimi-k3"))?.effort).toBe(expected);
  });

  // Legacy rows can still hold kimi-code/k3-256k, which the managed provider
  // no longer serves (session/set_model -> ACP -32603, 2026-08-05). It has no
  // capability entry any more, so effort admission must fail closed instead of
  // persisting a level that never reaches a runnable model.
  test("session persisted with the retired k3-256k model is rejected", async () => {
    const store = createFakeBindingStore();
    seedKimi(store, "k1", "kimi-k3xl", { model: "kimi-code/k3-256k" });
    const handler = createSetEffortHandler({ store });

    await expect(
      handler({ scope: "root", args: { name: "kimi-k3xl", level: "max" }, msg: makeMsg("oc_root", "") }),
    ).rejects.toThrow(UserError);
    expect((await store.findSessionByName("kimi-k3xl"))?.effort).toBeNull();
  });

  test("K3 session rejects ultracode (claude-only token)", async () => {
    const store = createFakeBindingStore();
    seedKimi(store, "k1", "kimi-k3", { model: "kimi-code/k3" });
    const apply = vi.spyOn(store, "applySessionRuntimeConfigMutations");
    const handler = createSetEffortHandler({ store });

    await expect(
      handler({ scope: "root", args: { name: "kimi-k3", level: "ultracode" }, msg: makeMsg("oc_root", "") }),
    ).rejects.toThrow(/ultracode/);
    expect(apply).not.toHaveBeenCalled();
  });

  test("default still clears a stored kimi effort", async () => {
    const store = createFakeBindingStore();
    seedKimi(store, "k1", "kimi-k3", { model: "kimi-code/k3", effort: "low" });
    const handler = createSetEffortHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "kimi-k3", id: asSessionId("k1") }),
    });

    const r = await handler({ scope: "user", args: { name: "", level: "default" }, msg: makeMsg("oc_kimi", "/effort default") });
    if (!("replyText" in r)) throw new Error("expected replyText");
    expect((await store.findSessionByName("kimi-k3"))?.effort).toBeNull();
  });

  test("/effort all updates compatible K3 sessions and reports K2.7 skips", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "codex-a", "codex");
    seedKimi(store, "k1", "kimi-k3", { model: "kimi-code/k3" });
    seedKimi(store, "k2", "kimi-a");
    const handler = createSetEffortHandler({ store });

    const r = await handler({ scope: "root", args: { name: "all", level: "high" }, msg: makeMsg("oc_root", "/effort all high") });
    if (!("replyText" in r)) throw new Error("expected replyText");
    expect(r.replyText).toContain("已更新 2 个");
    expect(r.replyText).toContain("kimi-a");
    expect((await store.findSessionByName("codex-a"))?.effort).toBe("high");
    expect((await store.findSessionByName("kimi-k3"))?.effort).toBe("high");
    expect((await store.findSessionByName("kimi-a"))?.effort).toBeNull(); // untouched skip
  });

  test("/effort all-kimi low updates K3 sessions and skips K2.7 sessions", async () => {
    const store = createFakeBindingStore();
    seedKimi(store, "k1", "kimi-k3", { model: "kimi-code/k3" });
    seedKimi(store, "k2", "kimi-k3b", { model: "kimi-code/k3" });
    seedKimi(store, "k3", "kimi-a");
    const handler = createSetEffortHandler({ store });

    const r = await handler({ scope: "root", args: { name: "all-kimi", level: "low" }, msg: makeMsg("oc_root", "/effort all-kimi low") });
    if (!("replyText" in r)) throw new Error("expected replyText");
    expect(r.replyText).toContain("已更新 2 个");
    expect(r.replyText).toContain("kimi-a");
    expect((await store.findSessionByName("kimi-k3"))?.effort).toBe("low");
    expect((await store.findSessionByName("kimi-k3b"))?.effort).toBe("low");
    expect((await store.findSessionByName("kimi-a"))?.effort).toBeNull();
  });

  test("/effort all-kimi default clears kimi efforts in bulk", async () => {
    const store = createFakeBindingStore();
    seedKimi(store, "k1", "kimi-k3", { model: "kimi-code/k3", effort: "low" });
    seedKimi(store, "k2", "kimi-a", { effort: null });
    const handler = createSetEffortHandler({ store });

    const r = await handler({ scope: "root", args: { name: "all-kimi", level: "default" }, msg: makeMsg("oc_root", "/effort all-kimi default") });
    if (!("replyText" in r)) throw new Error("expected replyText");
    expect((await store.findSessionByName("kimi-k3"))?.effort).toBeNull();
    expect((await store.findSessionByName("kimi-a"))?.effort).toBeNull();
  });
});
