import { beforeEach, describe, expect, test, vi } from "vitest";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { BackendKind, EffortLevel, Session, SessionStatus } from "../../src/domain/session.ts";
import {
  getCodexModelCatalogSnapshot,
  setCodexModelCatalogEntries,
  setCodexEffectiveDefaultModel,
} from "../../src/ports/CodexModelCatalog.ts";
import {
  getConfiguredBackendRuntimeDefaults,
  resetConfiguredBackendRuntimeDefaultsForTests,
  setConfiguredBackendRuntimeDefaults,
} from "../../src/ports/BackendRuntimeDefaults.ts";
import { resolveCodexExecutionModel } from "../../src/adapters/backend-codex/commandBuilder.ts";
import { RuntimeConfigConflictError } from "../../src/ports/BindingStore.ts";
import { reconcileCodexRuntimeConfigs } from "../../src/app/reconcileCodexRuntimeConfigs.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";

const CATALOG = [
  { slug: "default-new", supportedEfforts: ["low", "medium", "high"] },
  { slug: "fallback-ok", supportedEfforts: ["low", "medium"] },
  { slug: "legacy-ok", supportedEfforts: ["low", "medium", "high", "xhigh"] },
];

function session(name: string, options: {
  backend?: BackendKind;
  model?: string | null;
  effort?: EffortLevel | null;
  status?: SessionStatus;
  scope?: Session["scope"];
} = {}): Session {
  return {
    id: asSessionId(name), name, alias: "", avatar: "", category: "", fpManaged: null,
    scope: options.scope ?? "user", backend: options.backend ?? "codex",
    model: options.model ?? null, effort: options.effort ?? null,
    thinking: false, modelLocked: false, workdir: asAbsolutePath(`/tmp/${name}`),
    backendSessionId: null, chatName: null, purpose: "test", status: options.status ?? "idle",
    parentId: null, depth: options.scope === "child" ? 1 : 0,
    inactivityTimeoutS: null, maxRuntimeS: null, childType: null, triggerKind: null,
    postIdentity: null, callerInvocation: null, continuationHook: null, capabilityPayload: null,
    createdAt: asTimestamp(1), updatedAt: asTimestamp(1),
  };
}

describe("reconcileCodexRuntimeConfigs", () => {
  beforeEach(() => {
    resetConfiguredBackendRuntimeDefaultsForTests();
    setCodexModelCatalogEntries(CATALOG, "test");
    setCodexEffectiveDefaultModel("default-new");
  });

  test("repairs every non-deleted Codex row, including children, and ignores other rows", async () => {
    const store = createFakeBindingStore();
    store.seedSession(session("valid", { model: "legacy-ok", effort: "xhigh" }));
    store.seedSession(session("clamp", { model: "default-new", effort: "ultra" }));
    store.seedSession(session("removed", { model: "retired", effort: "ultra" }));
    store.seedSession(session("dynamic", { model: null, effort: "max", scope: "child" }));
    store.seedSession(session("deleted", { model: "retired", effort: "ultra", status: "deleted" }));
    store.seedSession(session("claude", { backend: "claude", model: "retired", effort: "ultra" }));

    const summary = await reconcileCodexRuntimeConfigs({
      store,
      availability: { probe: vi.fn().mockResolvedValue({ kind: "available", checkedAt: 1 }) },
      now: () => asTimestamp(10),
      idFactory: (() => { let n = 0; return () => `boot_${++n}`; })(),
    });

    expect(summary).toMatchObject({ unchanged: 1, clamped: 2, fallbackModel: 1, conflict: 0, failed: 0 });
    expect((await store.findSessionByName("clamp"))?.effort).toBe("high");
    expect(await store.findSessionByName("removed")).toMatchObject({ model: "default-new", effort: "high" });
    expect(await store.findSessionByName("dynamic")).toMatchObject({ model: null, effort: "high" });
    expect(await store.findSessionByName("deleted")).toMatchObject({ model: "retired", effort: "ultra" });
    expect(await store.findSessionByName("claude")).toMatchObject({ model: "retired", effort: "ultra" });
    expect(store._listSessionRuntimeConfigAudit()).toHaveLength(3);
  });

  test("promotes the first confirmed available candidate after the catalog default is unavailable", async () => {
    const store = createFakeBindingStore();
    store.seedSession(session("dynamic", { effort: "ultra" }));
    const probe = vi.fn()
      .mockResolvedValueOnce({ kind: "unavailable", checkedAt: 1, reason: "not entitled" })
      .mockResolvedValueOnce({ kind: "available", checkedAt: 2 });

    const summary = await reconcileCodexRuntimeConfigs({ store, availability: { probe } });

    expect(probe.mock.calls.map(([model]) => model)).toEqual(["default-new", "fallback-ok"]);
    expect(summary.verifiedDefault).toBe("fallback-ok");
    expect(getCodexModelCatalogSnapshot().defaultModel).toBe("fallback-ok");
    expect(await store.findSessionByName("dynamic")).toMatchObject({ model: null, effort: "medium" });
  });

  test("keeps an unavailable configured default for display but executes the verified fallback", async () => {
    const store = createFakeBindingStore();
    store.seedSession(session("dynamic"));
    setConfiguredBackendRuntimeDefaults("codex", { model: "default-new" });
    const probe = vi.fn()
      .mockResolvedValueOnce({ kind: "unavailable", checkedAt: 1, reason: "not entitled" })
      .mockResolvedValueOnce({ kind: "available", checkedAt: 2 });

    const summary = await reconcileCodexRuntimeConfigs({ store, availability: { probe } });

    expect(summary.verifiedDefault).toBe("fallback-ok");
    expect(getConfiguredBackendRuntimeDefaults("codex").model).toBe("default-new");
    expect(getCodexModelCatalogSnapshot().defaultModel).toBe("fallback-ok");
    expect(resolveCodexExecutionModel(null)).toBe("fallback-ok");
  });

  test("transient default evidence skips default-dependent mutations but permits explicit deterministic clamps", async () => {
    const store = createFakeBindingStore();
    store.seedSession(session("explicit", { model: "legacy-ok", effort: "ultra" }));
    store.seedSession(session("removed", { model: "retired", effort: "ultra" }));
    store.seedSession(session("dynamic", { model: null, effort: "ultra" }));

    const summary = await reconcileCodexRuntimeConfigs({
      store,
      availability: { probe: vi.fn().mockResolvedValue({ kind: "transient_failure", checkedAt: 1, reason: "timeout token=secret" }) },
    });

    expect(await store.findSessionByName("explicit")).toMatchObject({ model: "legacy-ok", effort: "xhigh" });
    expect(await store.findSessionByName("removed")).toMatchObject({ model: "retired", effort: "ultra" });
    expect(await store.findSessionByName("dynamic")).toMatchObject({ model: null, effort: "ultra" });
    expect(summary).toMatchObject({ clamped: 1, fallbackModel: 0, failed: 2 });
    expect(JSON.stringify(store._listSessionRuntimeConfigAudit())).not.toContain("secret");
  });

  test("all confirmed unavailable candidates are probed once and cause no mutations", async () => {
    const store = createFakeBindingStore();
    store.seedSession(session("removed", { model: "retired", effort: "ultra" }));
    const probe = vi.fn().mockImplementation(async () => ({ kind: "unavailable", checkedAt: 1, reason: "no" }));

    const summary = await reconcileCodexRuntimeConfigs({ store, availability: { probe } });

    expect(probe).toHaveBeenCalledTimes(CATALOG.length);
    expect(new Set(probe.mock.calls.map(([model]) => model)).size).toBe(CATALOG.length);
    expect(summary).toMatchObject({ fallbackModel: 0, failed: 1, verifiedDefault: null });
    expect(store._listSessionRuntimeConfigAudit()).toEqual([]);
  });

  test("route-managed probes report a skip with its reason instead of a verification verdict", async () => {
    const store = createFakeBindingStore();
    store.seedSession(session("explicit", { model: "legacy-ok", effort: "ultra" }));
    store.seedSession(session("dynamic", { model: null, effort: "ultra" }));
    const probe = vi.fn().mockResolvedValue({
      kind: "skipped", checkedAt: 1,
      reason: 'codex route "deepseek" is active and serves deepseek-v4-flash; default-new is not served on this route, so it was not probed',
    });

    const summary = await reconcileCodexRuntimeConfigs({ store, availability: { probe } });

    expect(summary.verifiedDefault).toBeNull();
    expect(summary.defaultVerificationSkipped).toContain("deepseek");
    // No verified default -> default-dependent rows stay untouched, exactly as
    // with transient evidence. Deterministic clamps still apply.
    expect(summary).toMatchObject({ clamped: 1, fallbackModel: 0, failed: 1 });
    expect(await store.findSessionByName("explicit")).toMatchObject({ model: "legacy-ok", effort: "xhigh" });
    expect(await store.findSessionByName("dynamic")).toMatchObject({ model: null, effort: "ultra" });
  });

  test("a skipped candidate does not stop the search: a served candidate is still verified", async () => {
    const store = createFakeBindingStore();
    store.seedSession(session("dynamic", { effort: "ultra" }));
    const probe = vi.fn()
      .mockResolvedValueOnce({ kind: "skipped", checkedAt: 1, reason: "route deepseek does not serve default-new" })
      .mockResolvedValueOnce({ kind: "available", checkedAt: 2 });

    const summary = await reconcileCodexRuntimeConfigs({ store, availability: { probe } });

    expect(probe.mock.calls.map(([model]) => model)).toEqual(["default-new", "fallback-ok"]);
    expect(summary).toMatchObject({ verifiedDefault: "fallback-ok", defaultVerificationSkipped: null });
  });

  test("continues after one row conflicts and emits one secret-free audit per successful repair", async () => {
    const store = createFakeBindingStore();
    store.seedSession(session("first", { model: "legacy-ok", effort: "ultra" }));
    store.seedSession(session("second", { model: "legacy-ok", effort: "ultra" }));
    const apply = store.applySessionRuntimeConfigMutations.bind(store);
    vi.spyOn(store, "applySessionRuntimeConfigMutations").mockImplementation(async (mutations) => {
      if (mutations[0]?.sessionId === asSessionId("first")) throw new RuntimeConfigConflictError(asSessionId("first"));
      return apply(mutations);
    });

    const summary = await reconcileCodexRuntimeConfigs({
      store,
      availability: { probe: vi.fn().mockResolvedValue({ kind: "available", checkedAt: 1 }) },
    });

    expect(summary).toMatchObject({ clamped: 1, conflict: 1, failed: 0 });
    expect(summary.problems.conflict).toEqual(["first"]);
    expect(await store.findSessionByName("second")).toMatchObject({ effort: "xhigh" });
    const audit = store._listSessionRuntimeConfigAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ trigger: "boot", requested: { model: "legacy-ok", effort: "ultra" } });
    expect(audit[0]).not.toHaveProperty("auth");
    expect(audit[0]).not.toHaveProperty("prompt");
    expect(audit[0]).not.toHaveProperty("response");
  });
});
