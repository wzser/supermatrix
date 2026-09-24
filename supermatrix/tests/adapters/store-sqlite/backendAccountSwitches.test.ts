import { describe, expect, test } from "vitest";
import {
  asAbsolutePath,
  asSessionId,
  asTimestamp,
} from "../../../src/domain/ids.ts";
import { createTempStore } from "./helpers.ts";

const BASE = {
  name: "kimi-target",
  scope: "user" as const,
  backend: "kimi" as const,
  workdir: asAbsolutePath("/tmp/ws/kimi-target"),
  purpose: "test",
  createdAt: asTimestamp(1_700_000_000_000),
};

describe("SqliteBindingStore backend account switches", () => {
  test("clearBackendSessionIdsForBackend clears session and branch ids in one shot", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      // kimi idle session with a persisted id and a pending fork branch.
      const kimi = await store.createSession({ id: asSessionId("sess_kimi_1"), ...BASE });
      await store.updateSessionBackendSessionId(kimi.id, "bks-kimi-1");
      await store.createSessionBranch({
        sessionId: kimi.id,
        name: "plan-a",
        sourceBranchName: "main",
        sourceBackendSessionId: "bks-kimi-1",
        forkPending: true,
        createdAt: asTimestamp(2_000),
      });
      // kimi session with no persisted id — must not be counted.
      await store.createSession({ id: asSessionId("sess_kimi_2"), ...BASE, name: "kimi-2" });
      // deleted kimi session — untouched.
      const deleted = await store.createSession({ id: asSessionId("sess_kimi_3"), ...BASE, name: "kimi-3" });
      await store.updateSessionBackendSessionId(deleted.id, "bks-kimi-3");
      await store.updateSessionStatus(deleted.id, "deleted", asTimestamp(2_100));
      // claude session — different backend, untouched.
      const claude = await store.createSession({
        id: asSessionId("sess_claude_1"),
        ...BASE,
        name: "claude-1",
        backend: "claude",
      });
      await store.updateSessionBackendSessionId(claude.id, "bks-claude-1");

      const result = await store.clearBackendSessionIdsForBackend("kimi", asTimestamp(3_000));

      expect(result).toEqual({ sessions: 1, branches: 1 });
      expect((await store.findSessionById(kimi.id))?.backendSessionId).toBeNull();
      const branch = await store.findSessionBranch(kimi.id, "plan-a");
      expect(branch).toMatchObject({
        backendSessionId: null,
        sourceBackendSessionId: null,
        forkPending: false,
      });
      expect((await store.findSessionById(deleted.id))?.backendSessionId).toBe("bks-kimi-3");
      expect((await store.findSessionById(claude.id))?.backendSessionId).toBe("bks-claude-1");
    } finally {
      await cleanup();
    }
  });

  test("countBusySessionsByBackend counts only busy rows of the given backend", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const busyKimi = await store.createSession({ id: asSessionId("sess_busy_kimi"), ...BASE, name: "busy-kimi" });
      await store.updateSessionStatus(busyKimi.id, "busy", asTimestamp(2_000));
      await store.createSession({ id: asSessionId("sess_idle_kimi"), ...BASE, name: "idle-kimi" });
      const busyClaude = await store.createSession({
        id: asSessionId("sess_busy_claude"),
        ...BASE,
        name: "busy-claude",
        backend: "claude",
      });
      await store.updateSessionStatus(busyClaude.id, "busy", asTimestamp(2_000));

      expect(await store.countBusySessionsByBackend("kimi")).toBe(1);
      expect(await store.countBusySessionsByBackend("claude")).toBe(1);
      expect(await store.countBusySessionsByBackend("codex")).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("record/find round-trips and the primary key rejects duplicates", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      expect(await store.findBackendAccountSwitch("req-1")).toBeNull();

      await store.recordBackendAccountSwitch({
        clientRequestId: "req-1",
        backend: "kimi",
        caller: "sm-switch",
        fromProfile: "work",
        toProfile: "personal",
        switchedAt: "2026-07-31T09:00:00Z",
        clearedSessions: 4,
        clearedBranches: 2,
        createdAt: asTimestamp(5_000),
      });

      expect(await store.findBackendAccountSwitch("req-1")).toEqual({
        clientRequestId: "req-1",
        backend: "kimi",
        caller: "sm-switch",
        fromProfile: "work",
        toProfile: "personal",
        switchedAt: "2026-07-31T09:00:00Z",
        clearedSessions: 4,
        clearedBranches: 2,
        createdAt: 5_000,
      });

      await expect(
        store.recordBackendAccountSwitch({
          clientRequestId: "req-1",
          backend: "kimi",
          caller: "sm-switch",
          clearedSessions: 0,
          clearedBranches: 0,
          createdAt: asTimestamp(6_000),
        }),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});
