import { describe, expect, test } from "vitest";
import {
  asAbsolutePath,
  asLarkGroupId,
  asMessageRunId,
  asSessionId,
  asTimestamp,
} from "../../../src/domain/ids.ts";
import { createTempStore } from "./helpers.ts";

const BASE = {
  name: "codexroot",
  scope: "user" as const,
  backend: "claude" as const,
  workdir: asAbsolutePath("/tmp/ws/codexroot"),
  purpose: "test",
  createdAt: asTimestamp(1_700_000_000_000),
};

describe("SqliteBindingStore session branches", () => {
  test("getActiveBranch returns main backed by sessions.backend_session_id when no branch rows exist", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const session = await store.createSession({ id: asSessionId("sess_1"), ...BASE });
      await store.updateSessionBackendSessionId(session.id, "bks-main");

      const active = await store.getActiveBranch(session.id);

      expect(active.name).toBe("main");
      expect(active.backendSessionId).toBe("bks-main");
      expect(active.forkPending).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("clears the session and main branch resume pointers in one write and reads both back", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const session = await store.createSession({ id: asSessionId("sess_1"), ...BASE });
      await store.updateSessionBranchBackendSessionId(session.id, "main", "codex-thread", asTimestamp(1_500));
      expect(store.db.prepare(
        "SELECT backend_session_id FROM sessions WHERE id = ?",
      ).pluck().get(session.id)).toBe("codex-thread");
      expect(store.db.prepare(
        "SELECT backend_session_id FROM session_branches WHERE session_id = ? AND name = 'main'",
      ).pluck().get(session.id)).toBe("codex-thread");

      await store.clearSessionBranchBackendSessionId(session.id, "main", asTimestamp(2_000));

      expect((await store.findSessionById(session.id))?.backendSessionId).toBeNull();
      expect((await store.findSessionBranch(session.id, "main"))?.backendSessionId).toBeNull();
      expect(store.db.prepare(
        "SELECT backend_session_id FROM sessions WHERE id = ?",
      ).pluck().get(session.id)).toBeNull();
      expect(store.db.prepare(
        "SELECT backend_session_id FROM session_branches WHERE session_id = ? AND name = 'main'",
      ).pluck().get(session.id)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("creates and switches a pending fork branch without changing session binding", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const session = await store.createSession({ id: asSessionId("sess_1"), ...BASE });
      await store.updateSessionBackendSessionId(session.id, "bks-main");

      await store.createSessionBranch({
        sessionId: session.id,
        name: "plan-a",
        sourceBranchName: "main",
        sourceBackendSessionId: "bks-main",
        forkPending: true,
        createdAt: asTimestamp(2_000),
      });
      await store.setActiveBranch(session.id, "plan-a", asTimestamp(2_001));

      const active = await store.getActiveBranch(session.id);
      const original = await store.findSessionById(session.id);
      expect(active.name).toBe("plan-a");
      expect(active.backendSessionId).toBeNull();
      expect(active.sourceBackendSessionId).toBe("bks-main");
      expect(active.forkPending).toBe(true);
      expect(original?.backendSessionId).toBe("bks-main");
    } finally {
      await cleanup();
    }
  });

  test("createSessionBranch persists a prepared backend id", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const session = await store.createSession({ id: asSessionId("sess_1"), ...BASE });

      const branch = await store.createSessionBranch({
        sessionId: session.id,
        name: "codex-plan",
        backendSessionId: "codex-child",
        sourceBranchName: "main",
        sourceBackendSessionId: "codex-source",
        forkPending: false,
        createdAt: asTimestamp(2_000),
      });

      expect(branch.backendSessionId).toBe("codex-child");
      expect(branch.sourceBackendSessionId).toBe("codex-source");
      expect(branch.forkPending).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("findSessionBranch synthesizes main for an existing session", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const session = await store.createSession({ id: asSessionId("sess_1"), ...BASE });

      const main = await store.findSessionBranch(session.id, "main");

      expect(main).toMatchObject({
        sessionId: session.id,
        name: "main",
        backendSessionId: null,
        forkPending: false,
      });
    } finally {
      await cleanup();
    }
  });

  test("message runs default to main and persist named branch", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const session = await store.createSession({ id: asSessionId("sess_1"), ...BASE });

      await store.startMessageRun({
        id: asMessageRunId("run_main"),
        sessionId: session.id,
        groupId: asLarkGroupId("oc_1"),
        prompt: "main prompt",
        startedAt: asTimestamp(3_000),
      });
      await store.startMessageRun({
        id: asMessageRunId("run_branch"),
        sessionId: session.id,
        groupId: asLarkGroupId("oc_1"),
        prompt: "branch prompt",
        branchName: "plan-a",
        startedAt: asTimestamp(3_001),
      });

      const rows = store.db
        .prepare("SELECT id, branch_name FROM message_runs ORDER BY id ASC")
        .all() as Array<{ id: string; branch_name: string }>;
      expect(rows).toEqual([
        { id: "run_branch", branch_name: "plan-a" },
        { id: "run_main", branch_name: "main" },
      ]);
    } finally {
      await cleanup();
    }
  });

  test("lists recent failed runs by branch for resume-poison confirmation", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const session = await store.createSession({ id: asSessionId("sess_1"), ...BASE });
      for (const [id, branchName, startedAt] of [
        ["run-main-old", "main", 3_000],
        ["run-named", "plan-a", 3_001],
        ["run-main-new", "main", 3_002],
      ] as const) {
        await store.startMessageRun({
          id: asMessageRunId(id),
          sessionId: session.id,
          groupId: asLarkGroupId("oc_1"),
          prompt: id,
          branchName,
          startedAt: asTimestamp(startedAt),
        });
        await store.finishMessageRun(asMessageRunId(id), "failed", undefined, "poison");
      }

      const recent = await store.listRecentMessageRuns(session.id, 2, "main");
      expect(recent.map((run) => run.id)).toEqual(["run-main-new", "run-main-old"]);
      expect(recent.every((run) => run.status === "failed")).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
