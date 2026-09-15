import { describe, expect, test } from "vitest";
import {
  createSessionLifecycle,
  type SessionTableSyncMode,
} from "../../src/app/sessionLifecycle.ts";
import { UserError } from "../../src/domain/errors.ts";
import { asAbsolutePath, asTimestamp, type SessionId, type Timestamp } from "../../src/domain/ids.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";
import { createFakeEventBus } from "../fakes/fakeEventBus.ts";
import { createFakeLarkGateway } from "../fakes/fakeLarkGateway.ts";
import { createFakeWorkspaceFs } from "../fakes/fakeWorkspaceFs.ts";

function mkDeps(
  requestSessionTableSync: (
    mode?: SessionTableSyncMode,
    sessionNames?: readonly string[],
  ) => void = () => {},
  requestSchedulerCleanup?: (input: {
    sessionId: SessionId;
    sessionName: string;
    clientRequestId: string;
    requestedAt: Timestamp;
  }) => Promise<void>,
) {
  const store = createFakeBindingStore();
  const fs = createFakeWorkspaceFs({
    "/tpl/gitignore.default": "",
    "/tpl/claude-md-base.md": "# {{name}}\n",
    "/tpl/agents-md-base.md": "# {{name}}\n",
  });
  const lark = createFakeLarkGateway();
  const eventBus = createFakeEventBus();
  const clock = { now: () => asTimestamp(1_700_000_000_000) };
  const lifecycle = createSessionLifecycle({
    store,
    fs,
    lark,
    clock,
    workspaceRoot: asAbsolutePath("/ws"),
    catalogPath: asAbsolutePath("/ws/session-catalog.json"),
    principlesTemplatesDir: asAbsolutePath("/ws/first-principle/templates"),
    claudeMdTemplatePath: asAbsolutePath("/tpl/claude-md-base.md"),
    agentsMdTemplatePath: asAbsolutePath("/tpl/agents-md-base.md"),
    gitignorePath: asAbsolutePath("/tpl/gitignore.default"),
    ownerUserId: "u-owner",
    eventBus,
    requestSessionTableSync,
    ...(requestSchedulerCleanup ? { requestSchedulerCleanup } : {}),
  });
  return { store, fs, lark, eventBus, lifecycle };
}

describe("sessionLifecycle.delete", () => {
  test("successful delete requests scoped push-current for the tombstoned session", async () => {
    const requests: Array<{
      mode: SessionTableSyncMode | undefined;
      sessionNames: readonly string[] | undefined;
    }> = [];
    const { store, lifecycle } = mkDeps((mode, sessionNames) => {
      requests.push({ mode, sessionNames });
    });
    await lifecycle.create({ backend: "claude", name: "foo", purpose: "" });
    requests.length = 0;

    await lifecycle.delete({ name: "foo" });

    expect((await store.findSessionByName("foo"))?.status).toBe("deleted");
    expect(requests).toEqual([
      { mode: "scoped-push-current", sessionNames: ["foo"] },
    ]);
  });

  test("happy path dissolves group and soft-deletes session", async () => {
    const { store, lark, lifecycle } = mkDeps();
    await lifecycle.create({ backend: "claude", name: "foo", purpose: "" });
    await lifecycle.delete({ name: "foo" });
    const after = await store.findSessionByName("foo");
    expect(after?.status).toBe("deleted");
    expect(lark.dissolvedGroups).toHaveLength(1);
  });

  test("commits deletion before submitting one stable scheduler cleanup request", async () => {
    const cleanupCalls: Array<{
      sessionId: string;
      sessionName: string;
      clientRequestId: string;
      statusAtCall: string | undefined;
    }> = [];
    let store: ReturnType<typeof createFakeBindingStore>;
    const deps = mkDeps(
      () => {},
      async (input) => {
        cleanupCalls.push({
          ...input,
          statusAtCall: (await store.findSessionById(input.sessionId))?.status,
        });
      },
    );
    store = deps.store;
    await deps.lifecycle.create({ backend: "claude", name: "foo", purpose: "" });

    await deps.lifecycle.delete({ name: "foo" });

    expect(cleanupCalls).toHaveLength(1);
    expect(cleanupCalls[0]).toMatchObject({
      sessionName: "foo",
      statusAtCall: "deleted",
    });
    expect(cleanupCalls[0]?.sessionId).toMatch(/^sess_/u);
    expect(cleanupCalls[0]?.clientRequestId).toBe(
      `2023-11-14:session-delete-cleanup:${cleanupCalls[0]?.sessionId}`,
    );
    expect(deps.eventBus.published.findIndex((e) => e.kind === "session_deleted")).toBeGreaterThanOrEqual(0);
  });

  test("cleanup delivery failure does not resurrect or reject the committed delete", async () => {
    const { store, lifecycle } = mkDeps(
      () => {},
      async () => {
        throw new Error("scheduler unavailable");
      },
    );
    await lifecycle.create({ backend: "claude", name: "foo", purpose: "" });

    await expect(lifecycle.delete({ name: "foo" })).resolves.toBeUndefined();
    expect((await store.findSessionByName("foo"))?.status).toBe("deleted");
  });

  test("delete publishes session_deleted event", async () => {
    const { eventBus, lifecycle } = mkDeps();
    const { session } = await lifecycle.create({ backend: "claude", name: "foo", purpose: "" });
    eventBus.published.length = 0;

    await lifecycle.delete({ name: "foo" });
    const deleted = eventBus.published.find((e) => e.kind === "session_deleted");
    expect(deleted).toBeTruthy();
    expect(deleted!.kind === "session_deleted" && deleted!.sessionId).toBe(session.id);
  });

  test("delete on missing session throws UserError", async () => {
    const { lifecycle } = mkDeps();
    await expect(lifecycle.delete({ name: "nope" })).rejects.toThrow(UserError);
  });

  test("delete on busy session throws UserError", async () => {
    const { store, lifecycle } = mkDeps();
    const { session } = await lifecycle.create({ backend: "claude", name: "foo", purpose: "" });
    await store.updateSessionStatus(session.id, "busy", asTimestamp(1_700_000_001_000));
    await expect(lifecycle.delete({ name: "foo" })).rejects.toThrow(/正在运行/);
  });
});
