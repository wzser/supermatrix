import { describe, expect, test } from "vitest";
import { createHeartbeatHandler } from "../../../src/app/commands/heartbeat.ts";
import { buildCommandRegistry } from "../../../src/app/commandRegistry.ts";
import { createCommandRouter } from "../../../src/app/commandRouter.ts";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";

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
  extra: Partial<Session> = {},
) {
  store.seedSession({
    id: asSessionId(id),
    name,
    alias: "",
    avatar: "",
    category: "", fpManaged: null,
    scope: "user",
    backend: "codex",
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

function bindHeartbeatRouter(
  store: ReturnType<typeof createFakeBindingStore>,
  resolveUserGroupSession = async () => ({ name: "scheduler", id: asSessionId("s1") }),
  controls: Array<Record<string, unknown>> = [],
) {
  const registry = buildCommandRegistry();
  registry["heartbeat"].handler = createHeartbeatHandler({
    store,
    resolveUserGroupSession,
    heartbeatControl: async (input) => {
      controls.push(input);
      if (input.action === "status") return { status: "active" };
      if (input.action === "pause") return { status: input.permanent ? "permanent" : "paused", expires_at: "2026-05-19T15:00:00+00:00" };
      return { status: "resumed" };
    },
  });
  return createCommandRouter(registry);
}

async function replyText(result: Awaited<ReturnType<ReturnType<typeof createCommandRouter>["route"]>>) {
  if (!("replyText" in result)) throw new Error("expected replyText");
  return result.replyText;
}

describe("/heartbeat", () => {
  test("metadata marks root target name as required", () => {
    const registry = buildCommandRegistry();
    const nameParam = registry["heartbeat"].command.params.find((param) => param.name === "name");

    expect(nameParam).toMatchObject({
      kind: "positional",
      required: true,
      scope: ["root"],
    });
  });

  test("user scope enables, reports status on, and disables current bound session", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "scheduler");
    const router = bindHeartbeatRouter(store);

    await expect(
      replyText(await router.route({ scope: "user", msg: makeMsg("oc_scheduler", "/heartbeat on") })),
    ).resolves.toBe("✓ heartbeat「scheduler」已开启");
    await expect(store.getSessionHeartbeatEnabled(asSessionId("s1"))).resolves.toBe(true);

    await expect(
      replyText(await router.route({ scope: "user", msg: makeMsg("oc_scheduler", "/heartbeat status") })),
    ).resolves.toBe("heartbeat「scheduler」当前：on");

    await expect(
      replyText(await router.route({ scope: "user", msg: makeMsg("oc_scheduler", "/heartbeat off") })),
    ).resolves.toBe("✓ heartbeat「scheduler」已关闭");
    await expect(store.getSessionHeartbeatEnabled(asSessionId("s1"))).resolves.toBe(false);
  });

  test("user scope no-op on and off reply with already messages", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "scheduler");
    const router = bindHeartbeatRouter(store);

    await router.route({ scope: "user", msg: makeMsg("oc_scheduler", "/heartbeat on") });
    await expect(
      replyText(await router.route({ scope: "user", msg: makeMsg("oc_scheduler", "/heartbeat on") })),
    ).resolves.toBe("✓ heartbeat「scheduler」已经开启");

    await router.route({ scope: "user", msg: makeMsg("oc_scheduler", "/heartbeat off") });
    await expect(
      replyText(await router.route({ scope: "user", msg: makeMsg("oc_scheduler", "/heartbeat off") })),
    ).resolves.toBe("✓ heartbeat「scheduler」已经关闭");
  });

  test("root scope parser routes two-position form and toggles scheduler", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "scheduler");
    const router = bindHeartbeatRouter(store);

    await expect(
      replyText(await router.route({ scope: "root", msg: makeMsg("oc_root", "/heartbeat scheduler on") })),
    ).resolves.toBe("✓ heartbeat「scheduler」已开启");

    await expect(store.getSessionHeartbeatEnabled(asSessionId("s1"))).resolves.toBe(true);
  });

  test("user scope stop heartbeat defaults to 60 minute pause and keeps heartbeat enabled", async () => {
    const store = createFakeBindingStore();
    const controls: Array<Record<string, unknown>> = [];
    seed(store, "s1", "scheduler");
    const router = bindHeartbeatRouter(store, undefined, controls);

    await expect(
      replyText(await router.route({ scope: "user", msg: makeMsg("oc_scheduler", "/heartbeat stop") })),
    ).resolves.toBe("✓ heartbeat「scheduler」已暂停 60 分钟，到 2026-05-19T15:00:00+00:00");

    await expect(store.getSessionHeartbeatEnabled(asSessionId("s1"))).resolves.toBe(true);
    expect(controls[0]).toMatchObject({ action: "pause", sessionName: "scheduler", minutes: 60 });
  });

  test("root scope stop heartbeat permanent disables heartbeat and records permanent pause", async () => {
    const store = createFakeBindingStore();
    const controls: Array<Record<string, unknown>> = [];
    seed(store, "s1", "scheduler");
    const router = bindHeartbeatRouter(store, undefined, controls);

    await expect(
      replyText(await router.route({ scope: "root", msg: makeMsg("oc_root", "/heartbeat scheduler stop permanent") })),
    ).resolves.toBe("✓ heartbeat「scheduler」已永久停止");

    await expect(store.getSessionHeartbeatEnabled(asSessionId("s1"))).resolves.toBe(false);
    expect(controls[0]).toMatchObject({ action: "pause", sessionName: "scheduler", permanent: true });
  });

  test("user scope resume heartbeat enables heartbeat and clears pause", async () => {
    const store = createFakeBindingStore();
    const controls: Array<Record<string, unknown>> = [];
    seed(store, "s1", "scheduler");
    const router = bindHeartbeatRouter(store, undefined, controls);

    await expect(
      replyText(await router.route({ scope: "user", msg: makeMsg("oc_scheduler", "/heartbeat resume") })),
    ).resolves.toBe("✓ heartbeat「scheduler」已恢复");

    await expect(store.getSessionHeartbeatEnabled(asSessionId("s1"))).resolves.toBe(true);
    expect(controls[0]).toMatchObject({ action: "resume", sessionName: "scheduler" });
  });

  test("child session rejects heartbeat", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "worker", { scope: "child" });
    const router = bindHeartbeatRouter(store);

    await expect(
      replyText(await router.route({ scope: "root", msg: makeMsg("oc_root", "/heartbeat worker on") })),
    ).resolves.toBe("❌ child session 不支持 heartbeat");
  });

  test("deleted session rejects heartbeat", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "scheduler", { status: "deleted" });
    const router = bindHeartbeatRouter(store);

    await expect(
      replyText(await router.route({ scope: "root", msg: makeMsg("oc_root", "/heartbeat scheduler status") })),
    ).resolves.toBe("❌ session 已删除：scheduler");
  });

  test("heartbeat session rejects enabling itself", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "heartbeat");
    const router = bindHeartbeatRouter(store);

    await expect(
      replyText(await router.route({ scope: "root", msg: makeMsg("oc_root", "/heartbeat heartbeat on") })),
    ).resolves.toBe("❌ heartbeat session 自身不支持开启 heartbeat");
  });
});
