import { describe, expect, test, vi } from "vitest";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import { UserError } from "../../../src/domain/errors.ts";
import { createTempStore } from "./helpers.ts";

const BASE = {
  name: "foo",
  scope: "user" as const,
  backend: "claude" as const,
  workdir: asAbsolutePath("/tmp/ws/foo"),
  purpose: "test",
  createdAt: asTimestamp(1_700_000_000_000),
};

describe("SqliteBindingStore sessions", () => {
  test("createSession stores and returns the row", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const session = await store.createSession({ id: asSessionId("s1"), ...BASE });
      expect(session).toMatchObject({ id: "s1", name: "foo", status: "initializing" });
      expect(session.backendSessionId).toBeNull();
    } finally {
      await cleanup();
    }
  });

  // FP v1.0 contract §4 chat_name option (a): no new chat_name writers.
  // The store no longer accepts a chatName parameter and the column stays
  // NULL on creation; existing rows (e.g. future-teller='预言家') are
  // grandfathered and left untouched (red line: no UPDATE).
  test("createSession leaves chat_name NULL — no new chat_name writers per v1.0 §4", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("s_unset"), ...BASE, name: "unset" });
      const row = await store.findSessionById(asSessionId("s_unset"));
      expect(row?.chatName).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("createSessionWithBinding leaves chat_name NULL — no new chat_name writers per v1.0 §4", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const { session } = await store.createSessionWithBinding(
        { id: asSessionId("s_bound"), ...BASE, name: "bound" },
        "oc_group_1" as never,
      );
      expect(session.chatName).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("warns when a persisted capability_payload cannot be parsed", async () => {
    const { store, cleanup } = await createTempStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await store.createSession({ id: asSessionId("s_bad_payload"), ...BASE });
      store.db
        .prepare("UPDATE sessions SET capability_payload = ? WHERE id = ?")
        .run("{bad json", "s_bad_payload");

      const session = await store.findSessionById(asSessionId("s_bad_payload"));

      expect(session?.capabilityPayload).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("[store-sqlite] invalid sessions.capability_payload"),
        expect.objectContaining({ sessionId: "s_bad_payload" }),
      );
    } finally {
      warn.mockRestore();
      await cleanup();
    }
  });

  test("findSessionByName returns null when missing", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      expect(await store.findSessionByName("missing")).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("findSessionByName prefers an exact name over an alias match", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({
        id: asSessionId("s_alias"),
        ...BASE,
        name: "alpha",
        alias: "target",
      });
      await store.createSession({
        id: asSessionId("s_name"),
        ...BASE,
        name: "target",
      });

      const session = await store.findSessionByName("target");

      expect(session?.id).toBe("s_name");
    } finally {
      await cleanup();
    }
  });

  test("updateSessionStatus and findSessionById round trip", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("s1"), ...BASE });
      await store.updateSessionStatus(asSessionId("s1"), "idle", asTimestamp(1_700_000_001_000));
      const s = await store.findSessionById(asSessionId("s1"));
      expect(s?.status).toBe("idle");
      expect(s?.updatedAt).toBe(1_700_000_001_000);
    } finally {
      await cleanup();
    }
  });

  test("updateSessionBackendSessionId persists value", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("s1"), ...BASE });
      await store.updateSessionBackendSessionId(asSessionId("s1"), "bks-1");
      expect((await store.findSessionById(asSessionId("s1")))?.backendSessionId).toBe("bks-1");
      await store.updateSessionBackendSessionId(asSessionId("s1"), null);
      expect((await store.findSessionById(asSessionId("s1")))?.backendSessionId).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("updateSessionModelLocked round-trips", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const id = asSessionId("s_lock");
      await store.createSession({ id, ...BASE, name: "lock-test" });
      const before = await store.findSessionById(id);
      expect(before?.modelLocked).toBe(false);

      await store.updateSessionModelLocked(id, true);
      const after = await store.findSessionById(id);
      expect(after?.modelLocked).toBe(true);

      await store.updateSessionModelLocked(id, false);
      const back = await store.findSessionById(id);
      expect(back?.modelLocked).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("fp_managed defaults to NULL (unmarked) and round-trips explicit false/true", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const s = await store.createSession({ id: asSessionId("s_fp"), ...BASE, name: "fp-test" });
      // New rows are unmarked — NULL maps to fpManaged === null.
      expect(s.fpManaged).toBeNull();

      // FP's sync script writes the column directly; the mapper must read it back.
      store.db.prepare("UPDATE sessions SET fp_managed = 0 WHERE id = ?").run("s_fp");
      expect((await store.findSessionById(asSessionId("s_fp")))?.fpManaged).toBe(false);

      store.db.prepare("UPDATE sessions SET fp_managed = 1 WHERE id = ?").run("s_fp");
      expect((await store.findSessionById(asSessionId("s_fp")))?.fpManaged).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("listActiveSessions excludes deleted", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("s1"), ...BASE });
      await store.createSession({ id: asSessionId("s2"), ...BASE, name: "bar" });
      await store.updateSessionStatus(asSessionId("s2"), "deleted", asTimestamp(1_700_000_002_000));
      const active = await store.listActiveSessions();
      expect(active.map((s) => s.id)).toEqual(["s1"]);
    } finally {
      await cleanup();
    }
  });

  test("listActiveSessions excludes child sessions (decisions.md D5)", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("parent"), ...BASE });
      await store.createSession({
        id: asSessionId("child"),
        ...BASE,
        name: "child_of_parent",
        scope: "child",
        parentId: asSessionId("parent"),
        depth: 1,
      });
      await store.updateSessionStatus(asSessionId("child"), "idle", asTimestamp(1_700_000_002_000));

      const active = await store.listActiveSessions();
      expect(active.map((s) => s.id)).toEqual(["parent"]);

      // Children still visible via listAllSessions (for diagnostic / debug).
      const all = await store.listAllSessions();
      expect(all.map((s) => s.id).sort()).toEqual(["child", "parent"]);
    } finally {
      await cleanup();
    }
  });

  test("deleteSessionAndBinding cascades to non-terminal child sessions (decisions.md D11)", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("parent"), ...BASE });
      await store.createSession({
        id: asSessionId("child_idle"),
        ...BASE,
        name: "child_idle",
        scope: "child",
        parentId: asSessionId("parent"),
        depth: 1,
      });
      await store.updateSessionStatus(asSessionId("child_idle"), "idle", asTimestamp(1));
      await store.createSession({
        id: asSessionId("child_busy"),
        ...BASE,
        name: "child_busy",
        scope: "child",
        parentId: asSessionId("parent"),
        depth: 1,
      });
      await store.updateSessionStatus(asSessionId("child_busy"), "busy", asTimestamp(1));
      await store.createSession({
        id: asSessionId("child_error"),
        ...BASE,
        name: "child_error",
        scope: "child",
        parentId: asSessionId("parent"),
        depth: 1,
      });
      await store.updateSessionStatus(asSessionId("child_error"), "error", asTimestamp(1));

      await store.deleteSessionAndBinding(asSessionId("parent"));

      const parent = await store.findSessionById(asSessionId("parent"));
      const childIdle = await store.findSessionById(asSessionId("child_idle"));
      const childBusy = await store.findSessionById(asSessionId("child_busy"));
      const childError = await store.findSessionById(asSessionId("child_error"));
      expect(parent?.status).toBe("deleted");
      expect(childIdle?.status).toBe("deleted");
      expect(childBusy?.status).toBe("deleted");
      // error children are preserved for retention / audit
      expect(childError?.status).toBe("error");
    } finally {
      await cleanup();
    }
  });

  test("countActiveSessions and countBusySessions", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("s1"), ...BASE });
      await store.createSession({ id: asSessionId("s2"), ...BASE, name: "bar" });
      await store.updateSessionStatus(asSessionId("s1"), "busy", asTimestamp(1_700_000_003_000));
      expect(await store.countActiveSessions()).toBe(2);
      expect(await store.countBusySessions()).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("resetBusySessionsOnBoot flips busy without backend_session_id → error", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("s1"), ...BASE });
      await store.updateSessionStatus(asSessionId("s1"), "busy", asTimestamp(1_700_000_003_000));
      const count = await store.resetBusySessionsOnBoot(asTimestamp(1_700_000_999_000));
      expect(count).toBe(1);
      expect((await store.findSessionById(asSessionId("s1")))?.status).toBe("error");
    } finally {
      await cleanup();
    }
  });

  test("resetBusySessionsOnBoot runs all status repairs in one transaction", async () => {
    const { store, cleanup } = await createTempStore();
    const txSpy = vi.spyOn(store.db, "transaction");
    try {
      await store.createSession({ id: asSessionId("s1"), ...BASE });
      await store.updateSessionStatus(asSessionId("s1"), "busy", asTimestamp(1_700_000_002_000));

      await store.resetBusySessionsOnBoot(asTimestamp(1_700_000_999_000));

      expect(txSpy).toHaveBeenCalled();
    } finally {
      txSpy.mockRestore();
      await cleanup();
    }
  });

  test("resetBusySessionsOnBoot flips busy with backend_session_id → idle (resumable)", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("s1"), ...BASE });
      await store.updateSessionBackendSessionId(asSessionId("s1"), "bks-1");
      await store.updateSessionStatus(asSessionId("s1"), "busy", asTimestamp(1_700_000_003_000));
      const count = await store.resetBusySessionsOnBoot(asTimestamp(1_700_000_999_000));
      expect(count).toBe(1);
      const after = await store.findSessionById(asSessionId("s1"));
      expect(after?.status).toBe("idle");
      expect(after?.backendSessionId).toBe("bks-1");
    } finally {
      await cleanup();
    }
  });

  test("resetBusySessionsOnBoot splits mixed busy sessions correctly", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("s1"), ...BASE, name: "with_bks" });
      await store.updateSessionBackendSessionId(asSessionId("s1"), "bks-1");
      await store.updateSessionStatus(asSessionId("s1"), "busy", asTimestamp(1_700_000_003_000));
      await store.createSession({ id: asSessionId("s2"), ...BASE, name: "without_bks" });
      await store.updateSessionStatus(asSessionId("s2"), "busy", asTimestamp(1_700_000_003_000));
      const count = await store.resetBusySessionsOnBoot(asTimestamp(1_700_000_999_000));
      expect(count).toBe(2);
      expect((await store.findSessionById(asSessionId("s1")))?.status).toBe("idle");
      expect((await store.findSessionById(asSessionId("s2")))?.status).toBe("error");
    } finally {
      await cleanup();
    }
  });

  test("countActiveChildrenByParent counts only busy children", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const parent = await store.createSession({
        id: asSessionId("p1"),
        name: "parent",
        scope: "user",
        backend: "claude",
        workdir: asAbsolutePath("/ws/parent"),
        purpose: "",
        createdAt: asTimestamp(1000),
      });
      await store.updateSessionStatus(parent.id, "idle", asTimestamp(1001));

      await store.createSession({
        id: asSessionId("c1"),
        name: "child_parent_1",
        scope: "child",
        backend: "claude",
        workdir: asAbsolutePath("/ws/parent"),
        purpose: "",
        createdAt: asTimestamp(2000),
        parentId: parent.id,
        depth: 1,
      });
      await store.updateSessionStatus(asSessionId("c1"), "idle", asTimestamp(2001));

      await store.createSession({
        id: asSessionId("c2"),
        name: "child_parent_2",
        scope: "child",
        backend: "claude",
        workdir: asAbsolutePath("/ws/parent"),
        purpose: "",
        createdAt: asTimestamp(3000),
        parentId: parent.id,
        depth: 1,
      });
      await store.updateSessionStatus(asSessionId("c2"), "busy", asTimestamp(3001));

      // deleted child should not count
      await store.createSession({
        id: asSessionId("c3"),
        name: "child_parent_3",
        scope: "child",
        backend: "claude",
        workdir: asAbsolutePath("/ws/parent"),
        purpose: "",
        createdAt: asTimestamp(4000),
        parentId: parent.id,
        depth: 1,
      });
      await store.updateSessionStatus(asSessionId("c3"), "deleted", asTimestamp(4001));

      // Only busy children count as active (idle c1 and deleted c3 excluded)
      expect(await store.countActiveChildrenByParent(parent.id)).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("cleanupStaleChildSessions marks idle children as deleted", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({
        id: asSessionId("p2"),
        name: "parent2",
        scope: "user",
        backend: "claude",
        workdir: asAbsolutePath("/ws/p2"),
        purpose: "",
        createdAt: asTimestamp(1000),
      });
      await store.updateSessionStatus(asSessionId("p2"), "idle", asTimestamp(1001));

      // stale child: idle, updated long ago
      await store.createSession({
        id: asSessionId("stale1"),
        name: "child_p2_stale",
        scope: "child",
        backend: "claude",
        workdir: asAbsolutePath("/ws/p2"),
        purpose: "",
        createdAt: asTimestamp(1000),
        parentId: asSessionId("p2"),
        depth: 1,
      });
      await store.updateSessionStatus(asSessionId("stale1"), "idle", asTimestamp(1000));

      // fresh child: idle, updated recently
      await store.createSession({
        id: asSessionId("fresh1"),
        name: "child_p2_fresh",
        scope: "child",
        backend: "claude",
        workdir: asAbsolutePath("/ws/p2"),
        purpose: "",
        createdAt: asTimestamp(9_000_000),
        parentId: asSessionId("p2"),
        depth: 1,
      });
      await store.updateSessionStatus(asSessionId("fresh1"), "idle", asTimestamp(9_000_000));

      // cutoff = 5_000_000 → stale1 (updated_at=1000) is before cutoff
      const cleaned = await store.cleanupStaleChildSessions(asTimestamp(5_000_000));
      expect(cleaned).toBe(1);

      const stale = await store.findSessionById(asSessionId("stale1"));
      expect(stale?.status).toBe("deleted");

      const fresh = await store.findSessionById(asSessionId("fresh1"));
      expect(fresh?.status).toBe("idle");
    } finally {
      await cleanup();
    }
  });

  test("cleanupErroredChildSessions marks only stale error children as deleted", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({
        id: asSessionId("p_err"),
        name: "parent_err",
        scope: "user",
        backend: "claude",
        workdir: asAbsolutePath("/ws/p_err"),
        purpose: "",
        createdAt: asTimestamp(1000),
      });
      await store.updateSessionStatus(asSessionId("p_err"), "idle", asTimestamp(1001));

      await store.createSession({
        id: asSessionId("old_error"),
        name: "child_p_err_old_error",
        scope: "child",
        backend: "claude",
        workdir: asAbsolutePath("/ws/p_err"),
        purpose: "",
        createdAt: asTimestamp(1000),
        parentId: asSessionId("p_err"),
        depth: 1,
      });
      await store.updateSessionStatus(asSessionId("old_error"), "error", asTimestamp(1000));

      await store.createSession({
        id: asSessionId("fresh_error"),
        name: "child_p_err_fresh_error",
        scope: "child",
        backend: "claude",
        workdir: asAbsolutePath("/ws/p_err"),
        purpose: "",
        createdAt: asTimestamp(9_000_000),
        parentId: asSessionId("p_err"),
        depth: 1,
      });
      await store.updateSessionStatus(asSessionId("fresh_error"), "error", asTimestamp(9_000_000));

      await store.createSession({
        id: asSessionId("old_idle"),
        name: "child_p_err_old_idle",
        scope: "child",
        backend: "claude",
        workdir: asAbsolutePath("/ws/p_err"),
        purpose: "",
        createdAt: asTimestamp(1000),
        parentId: asSessionId("p_err"),
        depth: 1,
      });
      await store.updateSessionStatus(asSessionId("old_idle"), "idle", asTimestamp(1000));

      const cleaned = await store.cleanupErroredChildSessions(asTimestamp(5_000_000));
      expect(cleaned).toBe(1);

      const oldError = await store.findSessionById(asSessionId("old_error"));
      expect(oldError?.status).toBe("deleted");

      const freshError = await store.findSessionById(asSessionId("fresh_error"));
      expect(freshError?.status).toBe("error");

      const oldIdle = await store.findSessionById(asSessionId("old_idle"));
      expect(oldIdle?.status).toBe("idle");
    } finally {
      await cleanup();
    }
  });

  test("updateSessionInactivityTimeout persists value", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const s = await store.createSession({ id: asSessionId("s1"), ...BASE });
      expect(s.inactivityTimeoutS).toBeNull();

      await store.updateSessionInactivityTimeout(s.id, 1800);
      const after = await store.findSessionById(s.id);
      expect(after!.inactivityTimeoutS).toBe(1800);

      await store.updateSessionInactivityTimeout(s.id, null);
      const reset = await store.findSessionById(s.id);
      expect(reset!.inactivityTimeoutS).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("updateSessionMaxRuntime persists value", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const s = await store.createSession({ id: asSessionId("s2"), ...BASE, name: "t2" });
      expect(s.maxRuntimeS).toBeNull();

      await store.updateSessionMaxRuntime(s.id, 3600);
      const after = await store.findSessionById(s.id);
      expect(after!.maxRuntimeS).toBe(3600);

      await store.updateSessionMaxRuntime(s.id, null);
      const reset = await store.findSessionById(s.id);
      expect(reset!.maxRuntimeS).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("cleanupStuckBusyChildren marks busy children with no backend as error", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({
        id: asSessionId("p3"),
        name: "parent3",
        scope: "user",
        backend: "claude",
        workdir: asAbsolutePath("/ws/p3"),
        purpose: "",
        createdAt: asTimestamp(1000),
      });
      await store.updateSessionStatus(asSessionId("p3"), "idle", asTimestamp(1001));

      // stuck busy child: no backend_session_id, updated long ago
      await store.createSession({
        id: asSessionId("stuck1"),
        name: "child_p3_stuck",
        scope: "child",
        backend: "claude",
        workdir: asAbsolutePath("/ws/p3"),
        purpose: "",
        createdAt: asTimestamp(1000),
        parentId: asSessionId("p3"),
        depth: 1,
      });
      await store.updateSessionStatus(asSessionId("stuck1"), "busy", asTimestamp(1000));

      // busy child WITH backend_session_id: should NOT be cleaned
      await store.createSession({
        id: asSessionId("running1"),
        name: "child_p3_running",
        scope: "child",
        backend: "claude",
        workdir: asAbsolutePath("/ws/p3"),
        purpose: "",
        createdAt: asTimestamp(1000),
        parentId: asSessionId("p3"),
        depth: 1,
      });
      await store.updateSessionStatus(asSessionId("running1"), "busy", asTimestamp(1000));
      await store.updateSessionBackendSessionId(asSessionId("running1"), "bks-123");

      const cleaned = await store.cleanupStuckBusyChildren(asTimestamp(5_000_000));
      expect(cleaned).toBe(1);

      const stuck = await store.findSessionById(asSessionId("stuck1"));
      expect(stuck?.status).toBe("error");

      const running = await store.findSessionById(asSessionId("running1"));
      expect(running?.status).toBe("busy");
    } finally {
      await cleanup();
    }
  });
});

// FP v1.0 session-meta contract enforcement
// Source: <SM_WORKSPACE_ROOT>/first-principle/rules/session-meta-fields.md
describe("SqliteBindingStore session-meta v1.0 validation", () => {
  test("createSessionWithBinding rejects URL-form avatar (must be Bitable file_token)", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await expect(
        store.createSessionWithBinding(
          { id: asSessionId("s1"), ...BASE, avatar: "https://i.pinimg.com/736x/x.png" },
          "oc_g1" as never,
        ),
      ).rejects.toThrow(UserError);
    } finally { await cleanup(); }
  });

  test("createSessionWithBinding rejects data-URL avatar", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await expect(
        store.createSessionWithBinding(
          { id: asSessionId("s1"), ...BASE, avatar: "data:image/jpeg;base64,/9j/4AAQ" },
          "oc_g1" as never,
        ),
      ).rejects.toThrow(UserError);
    } finally { await cleanup(); }
  });

  test("createSessionWithBinding rejects filesystem-path avatar", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await expect(
        store.createSessionWithBinding(
          { id: asSessionId("s1"), ...BASE, avatar: "/Users/foo/img/oc_1bdb4ffd.jpg" },
          "oc_g1" as never,
        ),
      ).rejects.toThrow(UserError);
    } finally { await cleanup(); }
  });

  test("createSessionWithBinding rejects 27-char avatar with non-base62 chars", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      // hyphen is not in [A-Za-z0-9]
      await expect(
        store.createSessionWithBinding(
          { id: asSessionId("s1"), ...BASE, avatar: "NJvQbW8waoESiBxl0aHcHnwdnz-" },
          "oc_g1" as never,
        ),
      ).rejects.toThrow(UserError);
    } finally { await cleanup(); }
  });

  test("createSessionWithBinding rejects avatar of wrong length (26 chars)", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await expect(
        store.createSessionWithBinding(
          { id: asSessionId("s1"), ...BASE, avatar: "NJvQbW8waoESiBxl0aHcHnwdnz" },
          "oc_g1" as never,
        ),
      ).rejects.toThrow(UserError);
    } finally { await cleanup(); }
  });

  test("createSessionWithBinding accepts empty avatar", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const { session } = await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE, avatar: "" },
        "oc_g1" as never,
      );
      expect(session.avatar).toBe("");
    } finally { await cleanup(); }
  });

  test("createSessionWithBinding accepts a valid 27-char file_token avatar", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const { session } = await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE, avatar: "NJvQbW8waoESiBxl0aHcHnwdnzf" },
        "oc_g1" as never,
      );
      expect(session.avatar).toBe("NJvQbW8waoESiBxl0aHcHnwdnzf");
    } finally { await cleanup(); }
  });

  test("createSessionWithBinding rejects alias longer than 8 visible chars", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      // 9 visible chars (mixed CJK + ASCII counts by code point)
      await expect(
        store.createSessionWithBinding(
          { id: asSessionId("s1"), ...BASE, alias: "九字汉名超长别称" + "x" }, // 9
          "oc_g1" as never,
        ),
      ).rejects.toThrow(UserError);
    } finally { await cleanup(); }
  });

  test("createSessionWithBinding rejects alias with whitespace", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await expect(
        store.createSessionWithBinding(
          { id: asSessionId("s1"), ...BASE, alias: "ab cd" },
          "oc_g1" as never,
        ),
      ).rejects.toThrow(UserError);
    } finally { await cleanup(); }
  });

  test("createSessionWithBinding rejects alias containing /, \\, or |", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      for (const bad of ["a/b", "a\\b", "a|b"]) {
        await expect(
          store.createSessionWithBinding(
            { id: asSessionId(`bad-${bad}`), ...BASE, name: `n_${Math.random()}`, alias: bad },
            `oc_${bad}` as never,
          ),
        ).rejects.toThrow(UserError);
      }
    } finally { await cleanup(); }
  });

  test("createSessionWithBinding accepts empty alias and 8-char alias", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const { session: a } = await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE, alias: "" },
        "oc_g1" as never,
      );
      expect(a.alias).toBe("");
      const eight = "八字符的群组别称"; // 8 code-points
      const { session: b } = await store.createSessionWithBinding(
        { id: asSessionId("s2"), ...BASE, name: "named8", alias: eight },
        "oc_g2" as never,
      );
      expect(b.alias).toBe(eight);
    } finally { await cleanup(); }
  });

  test("createSessionWithBinding rejects category outside the closed enum", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await expect(
        store.createSessionWithBinding(
          { id: asSessionId("s1"), ...BASE, category: "框架" as never },
          "oc_g1" as never,
        ),
      ).rejects.toThrow(UserError);
    } finally { await cleanup(); }
  });

  test("createSessionWithBinding accepts each category enum value (and empty)", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const values = ["", "业务", "平台", "工具", "知识"] as const;
      for (let i = 0; i < values.length; i++) {
        const v = values[i]!;
        const { session } = await store.createSessionWithBinding(
          { id: asSessionId(`s${i}`), ...BASE, name: `n${i}`, category: v },
          `oc_g${i}` as never,
        );
        expect(session.category).toBe(v);
      }
    } finally { await cleanup(); }
  });

  test("createSession (no binding) also runs session-meta validators", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await expect(
        store.createSession({ id: asSessionId("s1"), ...BASE, avatar: "https://example.com/x" }),
      ).rejects.toThrow(UserError);
      await expect(
        store.createSession({ id: asSessionId("s2"), ...BASE, name: "n2", alias: "a b" }),
      ).rejects.toThrow(UserError);
      await expect(
        store.createSession({ id: asSessionId("s3"), ...BASE, name: "n3", category: "其它" as never }),
      ).rejects.toThrow(UserError);
    } finally { await cleanup(); }
  });

  test("findNonConformingAvatars returns rows whose avatar violates v1.0 format (read-only, no UPDATE)", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      // Seed conforming row via the API.
      await store.createSession({
        id: asSessionId("ok"), ...BASE, name: "ok", avatar: "NJvQbW8waoESiBxl0aHcHnwdnzf",
      });
      // Seed empty-avatar row (conforming).
      await store.createSession({ id: asSessionId("blank"), ...BASE, name: "blank" });
      // Seed deleted row with bad avatar — must be excluded (not visible to FP).
      await store.createSession({ id: asSessionId("gone"), ...BASE, name: "gone" });
      store.db.prepare("UPDATE sessions SET avatar = ?, status = 'deleted' WHERE id = ?")
        .run("https://x.example", "gone");
      // Seed child row with bad avatar — must be excluded (children are exempt).
      await store.createSession({
        id: asSessionId("kid"), ...BASE, name: "child_x", scope: "child",
        parentId: asSessionId("ok"), depth: 1,
      });
      store.db.prepare("UPDATE sessions SET avatar = ? WHERE id = ?")
        .run("https://x.example", "kid");
      // Seed user-scope, non-deleted, bad-avatar rows — these MUST be reported.
      await store.createSession({ id: asSessionId("bad1"), ...BASE, name: "bad1" });
      store.db.prepare("UPDATE sessions SET avatar = ? WHERE id = ?")
        .run("https://i.pinimg.com/736x/x.png", "bad1");
      await store.createSession({ id: asSessionId("bad2"), ...BASE, name: "bad2" });
      store.db.prepare("UPDATE sessions SET avatar = ? WHERE id = ?")
        .run("data:image/jpeg;base64,/9j/4AA", "bad2");
      await store.createSession({ id: asSessionId("bad3"), ...BASE, name: "bad3" });
      store.db.prepare("UPDATE sessions SET avatar = ? WHERE id = ?")
        .run("/Users/x/img.jpg", "bad3");

      const rows = await store.findNonConformingAvatars();
      const names = rows.map((r) => r.name).sort();
      expect(names).toEqual(["bad1", "bad2", "bad3"]);
      // Returned rows include the offending value so FP can drive migration.
      expect(rows.find((r) => r.name === "bad1")?.avatar).toBe("https://i.pinimg.com/736x/x.png");
    } finally { await cleanup(); }
  });
});
