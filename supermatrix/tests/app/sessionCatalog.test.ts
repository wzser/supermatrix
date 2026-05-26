import { describe, expect, test } from "vitest";
import { createSessionCatalogService } from "../../src/app/sessionCatalog.ts";
import {
  asAbsolutePath,
  asSessionId,
  asTimestamp,
} from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";
import { createFakeEventBus } from "../fakes/fakeEventBus.ts";
import { createFakeWorkspaceFs } from "../fakes/fakeWorkspaceFs.ts";

const CATALOG_PATH = asAbsolutePath("/ws/session-catalog.json");

function mkSession(name: string, overrides: Partial<Session> = {}): Session {
  return {
    id: asSessionId("sess_" + name),
    name,
    alias: "",
    avatar: "",
    category: "",
    fpManaged: null,
    scope: "user",
    backend: "claude",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/ws/" + name),
    backendSessionId: null,
    chatName: null,
    purpose: "p-" + name,
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
    ...overrides,
  };
}

function mkService(extra: { withEventBus?: boolean } = {}) {
  const store = createFakeBindingStore();
  const fs = createFakeWorkspaceFs();
  const eventBus = createFakeEventBus();
  const service = createSessionCatalogService({
    store,
    fs,
    catalogPath: CATALOG_PATH,
    clock: { now: () => asTimestamp(1_700_000_000_000) },
    ...(extra.withEventBus ? { eventBus } : {}),
  });
  return { store, fs, eventBus, service };
}

describe("session catalog service", () => {
  test("regenerateCatalog writes the global catalog JSON file", async () => {
    const { store, fs, service } = mkService();
    store.seedSession(mkSession("foo", { alias: "F" }));
    store.seedSession(mkSession("bar"));

    await service.regenerateCatalog("startup");

    const raw = fs.files.get("/ws/session-catalog.json");
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!) as {
      generated_at: string;
      sessions: Array<{ name: string; alias: string }>;
    };
    expect(parsed.generated_at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(parsed.sessions.map((s) => s.name)).toEqual(["bar", "foo"]);
    expect(parsed.sessions.find((s) => s.name === "foo")!.alias).toBe("F");
  });

  test("regenerateCatalog emits a catalog_updated event with the reason", async () => {
    const { store, eventBus, service } = mkService({ withEventBus: true });
    store.seedSession(mkSession("foo"));

    await service.regenerateCatalog("new sibling: foo");

    expect(eventBus.published).toEqual([
      { kind: "catalog_updated", reason: "new sibling: foo" },
    ]);
  });

  test("regenerateCatalog works without an event bus", async () => {
    const { store, fs, service } = mkService();
    store.seedSession(mkSession("foo"));

    await expect(service.regenerateCatalog("no bus")).resolves.toBeUndefined();
    expect(fs.files.has("/ws/session-catalog.json")).toBe(true);
  });

  test("regenerateCatalog excludes fpManaged=false sessions", async () => {
    const { store, fs, service } = mkService();
    store.seedSession(mkSession("kept", { fpManaged: null }));
    store.seedSession(mkSession("dropped", { fpManaged: false }));

    await service.regenerateCatalog("scope");

    const parsed = JSON.parse(fs.files.get("/ws/session-catalog.json")!) as {
      sessions: Array<{ name: string }>;
    };
    expect(parsed.sessions.map((s) => s.name)).toEqual(["kept"]);
  });
});
