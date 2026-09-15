import { describe, expect, test } from "vitest";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import { createTempStore } from "./helpers.ts";

const BASE = {
  name: "foo",
  scope: "user" as const,
  backend: "claude" as const,
  workdir: asAbsolutePath("/tmp/ws/foo"),
  purpose: "",
  createdAt: asTimestamp(1_700_000_000_000),
};

describe("SqliteBindingStore bindings", () => {
  test("createSessionWithBinding creates both atomically", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const out = await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE },
        asLarkGroupId("oc_1")
      );
      expect(out.session.id).toBe("s1");
      expect(out.binding.groupId).toBe("oc_1");
      expect(out.binding.sessionId).toBe("s1");
      const found = await store.findByGroup(asLarkGroupId("oc_1"));
      expect(found?.sessionId).toBe("s1");
    } finally {
      await cleanup();
    }
  });

  test("createSessionWithBinding persists backend-neutral initial settings", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.updateBackendRuntimeDefaults("claude", {
        model: "claude-live-binding",
        effort: null,
      });
      const out = await store.createSessionWithBinding(
        {
          id: asSessionId("s_settings"),
          ...BASE,
          name: "settings",
          category: "平台",
          thinking: true,
          inactivityTimeoutS: 321,
          maxRuntimeS: 654,
          heartbeatEnabled: false,
          affiliatedTo: "codexroot",
        },
        asLarkGroupId("oc_settings"),
      );

      expect(out.session).toMatchObject({
        category: "平台",
        thinking: true,
        inactivityTimeoutS: 321,
        maxRuntimeS: 654,
        affiliatedTo: "codexroot",
      });
      expect(await store.getSessionHeartbeatEnabled(out.session.id)).toBe(false);
      expect(await store.getSessionRuntimeSettings(out.session.id)).toMatchObject({
        mainModelDefault: "claude-live-binding",
        mainEffortDefault: null,
      });
    } finally {
      await cleanup();
    }
  });

  test("createSessionWithBinding rolls back if binding conflicts", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE },
        asLarkGroupId("oc_1")
      );
      await expect(
        store.createSessionWithBinding(
          { id: asSessionId("s2"), ...BASE, name: "bar" },
          asLarkGroupId("oc_1")
        )
      ).rejects.toThrow();
      expect(await store.findSessionByName("bar")).toBeNull();
      expect(await store.getSessionRuntimeSettings(asSessionId("s2"))).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("deleteSessionAndBinding soft-deletes session and removes binding", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const { session } = await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE },
        asLarkGroupId("oc_1")
      );
      await store.deleteSessionAndBinding(session.id);
      const after = await store.findSessionById(session.id);
      expect(after?.status).toBe("deleted");
      expect(await store.findByGroup(asLarkGroupId("oc_1"))).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("scheduler cleanup request is durable, retryable after failure, and idempotent", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const input = {
        clientRequestId: "2026-09-03:session-delete-cleanup:s1",
        sessionId: asSessionId("s1"),
        sessionName: "foo",
        createdAt: asTimestamp(1_700_000_000_000),
      };
      await expect(store.beginSchedulerCleanupRequest(input)).resolves.toMatchObject({
        shouldDispatch: true,
        request: { status: "pending", attemptCount: 1 },
      });
      await store.markSchedulerCleanupFailed(input.clientRequestId, "scheduler unavailable", asTimestamp(1_700_000_001_000));
      await expect(store.listSchedulerCleanupRequests()).resolves.toMatchObject([{
        clientRequestId: input.clientRequestId,
        status: "failed",
        attemptCount: 1,
        lastError: "scheduler unavailable",
      }]);

      await expect(store.beginSchedulerCleanupRequest({ ...input, createdAt: asTimestamp(1_700_000_002_000) })).resolves.toMatchObject({
        shouldDispatch: true,
        request: { status: "pending", attemptCount: 2 },
      });
      await store.markSchedulerCleanupSubmitted(input.clientRequestId, asTimestamp(1_700_000_003_000));
      await expect(store.beginSchedulerCleanupRequest(input)).resolves.toMatchObject({
        shouldDispatch: false,
        request: { status: "submitted", attemptCount: 2 },
      });
      expect((await store.listSchedulerCleanupRequests()).length).toBe(1);
    } finally {
      await cleanup();
    }
  });
});
