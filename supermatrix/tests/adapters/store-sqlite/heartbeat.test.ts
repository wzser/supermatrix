import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteBindingStore } from "../../../src/adapters/store-sqlite/index.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";

const BASE = {
  scope: "user" as const,
  backend: "claude" as const,
  purpose: "heartbeat test",
  createdAt: asTimestamp(1_700_000_000_000),
};

let store: SqliteBindingStore | null = null;
let dir: string | null = null;

async function createStore(): Promise<SqliteBindingStore> {
  dir = mkdtempSync(path.join(tmpdir(), "supermatrix-heartbeat-"));
  store = new SqliteBindingStore(path.join(dir, "console.db"));
  await store.init();
  return store;
}

async function createSession(
  store: SqliteBindingStore,
  id: string,
  name: string,
  options: { scope?: "user" | "root" | "child"; parentId?: string } = {},
): Promise<void> {
  await store.createSession({
    id: asSessionId(id),
    ...BASE,
    name,
    scope: options.scope ?? "user",
    parentId: options.parentId ? asSessionId(options.parentId) : null,
    depth: options.scope === "child" ? 1 : 0,
    workdir: asAbsolutePath(`/tmp/ws/${name}`),
  });
}

afterEach(async () => {
  if (store) {
    await store.close();
    store = null;
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe("SqliteBindingStore heartbeat", () => {
  it("defaults heartbeat to enabled for newly created non-child sessions", async () => {
    const store = await createStore();
    await createSession(store, "user", "alpha");
    await createSession(store, "root", "root", { scope: "root" });
    await createSession(store, "parent", "parent");
    await createSession(store, "child", "child", { scope: "child", parentId: "parent" });
    await createSession(store, "heartbeat", "heartbeat");

    await expect(store.getSessionHeartbeatEnabled(asSessionId("user"))).resolves.toBe(true);
    await expect(store.getSessionHeartbeatEnabled(asSessionId("root"))).resolves.toBe(true);
    await expect(store.getSessionHeartbeatEnabled(asSessionId("child"))).resolves.toBe(false);
    await expect(store.getSessionHeartbeatEnabled(asSessionId("heartbeat"))).resolves.toBe(false);
  });

  it("toggles heartbeat on and off", async () => {
    const store = await createStore();
    await createSession(store, "s1", "alpha");

    await expect(store.getSessionHeartbeatEnabled(asSessionId("s1"))).resolves.toBe(true);

    await store.updateSessionHeartbeatEnabled(asSessionId("s1"), false);
    await expect(store.getSessionHeartbeatEnabled(asSessionId("s1"))).resolves.toBe(false);

    await store.updateSessionHeartbeatEnabled(asSessionId("s1"), true);
    await expect(store.getSessionHeartbeatEnabled(asSessionId("s1"))).resolves.toBe(true);
  });

  it("lists heartbeat-enabled non-child sessions only", async () => {
    const store = await createStore();
    await createSession(store, "enabled_late", "alpha");
    await createSession(store, "enabled_tie_a", "zulu");
    await createSession(store, "enabled_tie_b", "bravo");
    await createSession(store, "disabled", "charlie");
    await createSession(store, "root", "root", { scope: "root" });
    await createSession(store, "parent", "parent");
    await createSession(store, "child", "child", { scope: "child", parentId: "parent" });
    await createSession(store, "deleted", "deleted");
    await createSession(store, "heartbeat", "heartbeat");

    await store.updateSessionHeartbeatEnabled(asSessionId("disabled"), false);
    await store.updateSessionStatus(asSessionId("deleted"), "deleted", asTimestamp(1_700_000_001_000));
    store.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(1_700_000_000_300, "enabled_late");
    store.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(1_700_000_000_100, "enabled_tie_a");
    store.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(1_700_000_000_100, "enabled_tie_b");
    store.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(1_700_000_000_200, "root");
    store.db
      .prepare("UPDATE sessions SET heartbeat_enabled = 0 WHERE id = ?")
      .run("parent");

    const sessions = await store.listHeartbeatEnabledSessions();
    expect(sessions.map((s) => s.name)).toEqual(["bravo", "zulu", "root", "alpha"]);
  });

  it("excludes child sessions, deleted sessions, and heartbeat itself even when enabled", async () => {
    const store = await createStore();
    await createSession(store, "included", "scheduler");
    await createSession(store, "root", "root", { scope: "root" });
    await createSession(store, "parent", "parent");
    await createSession(store, "child", "child", { scope: "child", parentId: "parent" });
    await createSession(store, "deleted", "deleted");
    await createSession(store, "heartbeat", "heartbeat");

    for (const id of ["included", "root", "child", "deleted", "heartbeat"]) {
      await store.updateSessionHeartbeatEnabled(asSessionId(id), true);
    }
    await store.updateSessionHeartbeatEnabled(asSessionId("parent"), false);
    await store.updateSessionStatus(asSessionId("deleted"), "deleted", asTimestamp(1_700_000_001_000));

    const sessions = await store.listHeartbeatEnabledSessions();
    expect(sessions.map((s) => s.name).sort()).toEqual(["root", "scheduler"]);
  });
});
