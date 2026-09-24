import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { UserError } from "../../../src/domain/errors.ts";
import { createSetModelHandler, resolveAndValidateModel } from "../../../src/app/commands/setModel.ts";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import { getCodexDefaultModel } from "../../../src/ports/CodexModelCatalog.ts";
import {
  resolveCodexRouteOverride,
  ROUTE_STATE_CONTRACT_VERSION,
} from "../../../src/adapters/backend-codex/routeState.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";

function seedCodexSession(store: ReturnType<typeof createFakeBindingStore>, status: "idle" | "busy" = "idle") {
  store.seedSession({
    id: asSessionId("s1"),
    name: "codex-a",
    alias: "",
    avatar: "",
    category: "",
    fpManaged: null,
    scope: "user",
    backend: "codex",
    model: "gpt-5.4",
    effort: "high",
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/ws/codex-a"),
    backendSessionId: "resume-a",
    chatName: null,
    purpose: "",
    status,
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
  });
}

const msg = {
  groupId: asLarkGroupId("oc_root"),
  messageId: "m",
  userId: "u",
  text: "/model codex-a gpt-5.5",
  attachments: [],
  receivedAtMs: 0,
};

describe("/model read view route awareness", () => {
  // Wires the real route-state/v1 consumer (the one the dispatch path uses) the
  // way bootstrap.ts does, only against a temp state file — so these assert the
  // shipped contract consumption, not a hand-rolled parser.
  let dir: string;
  const intended = getCodexDefaultModel();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sm-setmodel-route-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function handlerForState(state: unknown) {
    const path = join(dir, `route-state-${Math.random().toString(36).slice(2)}.json`);
    if (state !== undefined) {
      writeFileSync(path, typeof state === "string" ? state : JSON.stringify(state));
    }
    return createSetModelHandler({
      store: createFakeBindingStore(),
      resolveCodexRouteOverride: (intendedModel) => resolveCodexRouteOverride(intendedModel, path),
    });
  }

  const deepseekState = (overrides: Record<string, unknown> = {}) => ({
    contractVersion: ROUTE_STATE_CONTRACT_VERSION,
    backend: "codex",
    route: "deepseek",
    defaultModel: "deepseek-v4-flash",
    servedModels: ["deepseek-v4-flash"],
    activatedAt: "2026-08-07T12:00:00+08:00",
    proxy: { host: "127.0.0.1", port: 15722, healthUrl: "http://127.0.0.1:15722/health" },
    ...overrides,
  });

  async function overview(state: unknown): Promise<string> {
    const result = await handlerForState(state)({ args: {}, scope: "root", msg });
    if (!("replyText" in result)) throw new Error("expected replyText");
    return result.replyText;
  }

  test("shows the routed model plus a route annotation while deepseek is active", async () => {
    const text = await overview(deepseekState());

    expect(text).toContain(
      `codex: configured=default, effective=deepseek-v4-flash（deepseek 路由覆盖，切回自动恢复；意图 model=${intended}）`,
    );
    // Intent layer stays clean: claude / kimi lines are untouched by codex routing.
    expect(text).not.toContain("claude: configured=default, effective=deepseek");
    expect(text).not.toContain("kimi: configured=default, effective=deepseek");
  });

  test("/model global lists the same routed codex effective model", async () => {
    const result = await handlerForState(deepseekState())({
      args: { name: "global" },
      scope: "root",
      msg,
    });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain(
      `codex: configured=default, effective=deepseek-v4-flash（deepseek 路由覆盖，切回自动恢复；意图 model=${intended}）`,
    );
  });

  test("passthrough route shows the catalog default with no annotation", async () => {
    const text = await overview(deepseekState({
      route: "openai",
      defaultModel: null,
      servedModels: [],
      proxy: null,
    }));

    expect(text).toContain(`codex: configured=default, effective=${intended}`);
    expect(text).not.toContain("路由覆盖");
  });

  test("fails open to the catalog default when route-state is missing / corrupt / unknown-version", async () => {
    for (const state of [undefined, "{not json", deepseekState({ contractVersion: "sm-switch.route-state/v2" })]) {
      const text = await overview(state);
      expect(text).toContain(`codex: configured=default, effective=${intended}`);
      expect(text).not.toContain("路由覆盖");
    }
  });

  test("stays at the catalog default when no resolver is injected at all", async () => {
    const result = await createSetModelHandler({ store: createFakeBindingStore() })({
      args: {},
      scope: "root",
      msg,
    });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain(`codex: configured=default, effective=${intended}`);
    expect(result.replyText).not.toContain("路由覆盖");
  });
});

describe("resolveAndValidateModel", () => {
  test("rejects retired Opus 4.7 command aliases while opus points to Opus 5", () => {
    for (const input of ["opus4.7", "opus-4.7", "opus-4-7"]) {
      expect(() => resolveAndValidateModel(input, "claude")).toThrow(UserError);
    }

    expect(resolveAndValidateModel("opus", "claude")).toBe("claude-opus-5");
  });
});

describe("/model single mutation guards", () => {
  test("busy single-session model change queues without changing the current run tuple", async () => {
    const store = createFakeBindingStore();
    seedCodexSession(store, "busy");
    const apply = vi.spyOn(store, "applySessionRuntimeConfigMutations");
    const handler = createSetModelHandler({ store });

    const result = await handler({ args: { name: "codex-a", model: "gpt-5.5" }, scope: "root", msg });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("已排队，将在当前 run 结束后生效");
    expect(apply).not.toHaveBeenCalled();
    expect(await store.findSessionByName("codex-a")).toMatchObject({
      backend: "codex",
      model: "gpt-5.4",
      effort: "high",
      backendSessionId: "resume-a",
      status: "busy",
    });
  });

  test("persists a catalog-valid model without probing even when an unavailable probe is injected", async () => {
    // /model single must validate against the catalog/policy and atomically
    // persist without a generative availability probe. Inject a probe that would
    // reject and prove the hot path never calls it while committing exactly once.
    const store = createFakeBindingStore();
    seedCodexSession(store);
    const apply = vi.spyOn(store, "applySessionRuntimeConfigMutations");
    const probe = vi.fn(async () => ({ kind: "unavailable" as const, checkedAt: 1, reason: "not entitled" }));
    const syncSessionTable = vi.fn();
    const handler = createSetModelHandler({ store, availability: { probe }, syncSessionTable });

    await handler({ args: { name: "codex-a", model: "gpt-5.5" }, scope: "root", msg });

    expect(probe).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(syncSessionTable).toHaveBeenCalledOnce();
    expect(syncSessionTable).toHaveBeenCalledWith("current");
    expect(await store.findSessionByName("codex-a")).toMatchObject({
      backend: "codex",
      model: "gpt-5.5",
    });
  });

  test("catalog-invalid model rejects with zero writes (no partial persist)", async () => {
    const store = createFakeBindingStore();
    seedCodexSession(store);
    const apply = vi.spyOn(store, "applySessionRuntimeConfigMutations");
    const probe = vi.fn(async () => ({ kind: "available" as const, checkedAt: 1 }));
    const handler = createSetModelHandler({ store, availability: { probe } });

    await expect(
      handler({ args: { name: "codex-a", model: "gpt-5.3" }, scope: "root", msg: { ...msg, text: "/model codex-a gpt-5.3" } }),
    ).rejects.toThrow(UserError);

    expect(probe).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(await store.findSessionByName("codex-a")).toMatchObject({
      backend: "codex",
      model: "gpt-5.4",
      effort: "high",
      backendSessionId: "resume-a",
    });
  });
});
