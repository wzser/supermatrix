import { beforeEach, describe, expect, test } from "vitest";
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
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
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
    expect((await store.findSessionByName("a"))?.model).toBe("claude-opus-4-7");
    expect((await store.findSessionByName("b"))?.model).toBeNull();
    expect((await store.findSessionByName("c"))?.model).toBe("claude-opus-4-7");
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

  test("/model all-claude skips locked sessions and reports them", async () => {
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
    expect(result.replyText).toContain("已更新 2 个");
    expect(result.replyText).toContain("跳过 1 个锁定 session: claude-b");
    expect((await store.findSessionByName("claude-a"))?.model).toBe("claude-sonnet-4-6");
    expect((await store.findSessionByName("claude-b"))?.model).not.toBe("claude-sonnet-4-6");
    expect((await store.findSessionByName("claude-c"))?.model).toBe("claude-sonnet-4-6");
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
      args: { name: "a", model: "gpt-5.4" },
      scope: "root",
      msg: makeMsg("oc_root", "/model a gpt-5.4"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect((await store.findSessionByName("a"))?.model).toBe("gpt-5.4");
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
      '未知 codex 模型 "gpt-5.3"。当前可用：gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex / gpt-5.2',
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
    expect(result2.replyText).toContain("已更新 1 个 session");
    expect(result2.replyText).toContain("失败 1");
    expect((await store.findSessionByName("a"))?.model).toBe("claude-opus-4-7");
    expect((await store.findSessionByName("b"))?.model).toBeNull();
  });
});

describe("resolveModelAlias", () => {
  beforeEach(() => {
    resetCodexModelCatalogForTests(TEST_CODEX_CATALOG);
  });

  test("claude aliases resolve to full claude model IDs", () => {
    expect(resolveModelAlias("opus", "claude")).toBe("claude-opus-4-7");
    expect(resolveModelAlias("opus4.7", "claude")).toBe("claude-opus-4-7");
    expect(resolveModelAlias("sonnet", "claude")).toBe("claude-sonnet-4-6");
    expect(resolveModelAlias("haiku", "claude")).toBe("claude-haiku-4-5-20251001");
  });

  test("codex aliases resolve for codex backend", () => {
    expect(resolveModelAlias("gpt5.5", "codex")).toBe("gpt-5.5");
    expect(resolveModelAlias("gpt5.3-codex", "codex")).toBe("gpt-5.3-codex");
  });

  test("codex alias targets stay inside the current catalog", () => {
    const catalog = new Set(getCodexBundledModels());
    expect(Object.values(CODEX_MODEL_ALIASES).every((target) => catalog.has(target))).toBe(true);
  });

  test("unknown strings pass through", () => {
    expect(resolveModelAlias("gpt-5.4", "codex")).toBe("gpt-5.4");
    expect(resolveModelAlias("claude-opus-4-7", "claude")).toBe("claude-opus-4-7");
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

  test("all-kimi targets only kimi sessions", async () => {
    const calls: any[] = [];
    const store = {
      findSessionByName: async () => null,
      updateSessionEffort: async () => {},
      listActiveSessionsByBackend: async (b?: any) => { calls.push(b); return []; },
    };
    const handler = createSetEffortHandler({ store });
    await handler({
      args: { name: "all-kimi", level: "high" },
      scope: "root",
      msg: makeMsg("oc_root", "/effort all-kimi high"),
    });
    expect(calls).toEqual(["kimi"]);
  });
});
