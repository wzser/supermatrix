import { describe, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { SqliteBindingStore } from "../../../src/adapters/store-sqlite/index.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asMessageRunId,
  asSessionId,
  asTimestamp,
} from "../../../src/domain/ids.ts";
import { createTempStore } from "./helpers.ts";

async function seedIdleClaudeSession(
  store: Awaited<ReturnType<typeof createTempStore>>["store"],
  id = "sess_claude",
): Promise<ReturnType<typeof asSessionId>> {
  const sessionId = asSessionId(id);
  await store.createSession({
    id: sessionId,
    name: id,
    scope: "user",
    backend: "claude",
    workdir: asAbsolutePath(`/tmp/${id}`),
    purpose: "maintenance lease test",
    createdAt: asTimestamp(1_700_000_000_000),
  });
  await store.updateSessionStatus(sessionId, "idle", asTimestamp(1_700_000_000_001));
  return sessionId;
}

function leaseInput(overrides: Partial<{
  owner: string;
  tokenHash: string;
  requestId: string;
  acquiredAt: ReturnType<typeof asTimestamp>;
}> = {}) {
  return {
    backend: "claude" as const,
    owner: "sm-switch",
    tokenHash: "sha256:lease-token-a",
    requestId: "switch-001",
    acquiredAt: asTimestamp(1_700_000_000_010),
    ...overrides,
  };
}

function admissionInput(sessionId: ReturnType<typeof asSessionId>, id = "mr_admission") {
  return {
    id: asMessageRunId(id),
    sessionId,
    groupId: asLarkGroupId("oc_lease"),
    prompt: "must not start",
    startedAt: asTimestamp(1_700_000_000_011),
  };
}

describe("SqliteBindingStore Claude maintenance lease", () => {
  test("read-only lookup reports idle or the active lease without writing an audit event", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await expect(store.getBackendMaintenanceLease("claude")).resolves.toBeNull();
      expect(await store.listBackendMaintenanceLeaseEvents("claude")).toEqual([]);

      await store.acquireBackendMaintenanceLease(leaseInput());
      const eventsBeforeLookup = await store.listBackendMaintenanceLeaseEvents("claude");
      await expect(store.getBackendMaintenanceLease("claude")).resolves.toEqual({
        backend: "claude",
        owner: "sm-switch",
        requestId: "switch-001",
        acquiredAt: asTimestamp(1_700_000_000_010),
      });
      expect(await store.listBackendMaintenanceLeaseEvents("claude")).toEqual(eventsBeforeLookup);
    } finally {
      await cleanup();
    }
  });

  test("lease survives a store reopen and still fences new admission", async () => {
    const { store, dir } = await createTempStore();
    let reopened: SqliteBindingStore | null = null;
    try {
      const sessionId = await seedIdleClaudeSession(store, "sess_durable");
      await store.acquireBackendMaintenanceLease(leaseInput());
      await store.close();

      reopened = new SqliteBindingStore(join(dir, "console.db"));
      await reopened.init();
      await expect(reopened.admitMessageRun(admissionInput(sessionId, "mr_after_reopen")))
        .resolves.toMatchObject({ kind: "maintenance", backend: "claude" });
    } finally {
      if (reopened) {
        await reopened.close();
      } else {
        await store.close();
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("acquire commits a durable Claude lease that atomically denies later run admission", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const sessionId = await seedIdleClaudeSession(store);

      await expect(store.acquireBackendMaintenanceLease(leaseInput())).resolves.toMatchObject({
        kind: "acquired",
        duplicate: false,
        lease: { backend: "claude", owner: "sm-switch", requestId: "switch-001" },
      });

      await expect(store.admitMessageRun(admissionInput(sessionId, "mr_after_lease"))).resolves.toMatchObject({
        kind: "maintenance",
        backend: "claude",
        lease: { owner: "sm-switch" },
      });

      expect(await store.findRunningMessageRunBySession(sessionId)).toBeNull();
      expect((await store.findSessionById(sessionId))?.status).toBe("idle");
    } finally {
      await cleanup();
    }
  });

  test("admit-first keeps acquire out until the actual running message_run finishes", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const sessionId = await seedIdleClaudeSession(store);
      await expect(store.admitMessageRun(admissionInput(sessionId, "mr_before_lease"))).resolves.toMatchObject({
        kind: "admitted",
        messageRunId: "mr_before_lease",
      });

      await expect(store.acquireBackendMaintenanceLease(leaseInput())).resolves.toEqual({
        kind: "running_message_runs",
        backend: "claude",
        runningMessageRunCount: 1,
      });

      await store.finishMessageRun(asMessageRunId("mr_before_lease"), "completed", "done");
      // The session remains busy until normal run cleanup. The lease relies on
      // message_runs, not a Kimi-style session busy count, so it can now fence
      // later admissions without pretending a completed run is still active.
      await expect(store.acquireBackendMaintenanceLease(leaseInput({
        requestId: "switch-after-run",
        acquiredAt: asTimestamp(1_700_000_000_012),
      }))).resolves.toMatchObject({ kind: "acquired", duplicate: false });
    } finally {
      await cleanup();
    }
  });

  test("lease owner and token protect idempotent acquire/release and leave an audit trail", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await expect(store.acquireBackendMaintenanceLease(leaseInput({
        tokenHash: "sha256:opaque-token-A",
      }))).resolves.toMatchObject({ kind: "acquired", duplicate: false });
      await expect(store.acquireBackendMaintenanceLease(leaseInput({
        requestId: "switch-duplicate-request",
        tokenHash: "sha256:opaque-token-A",
      }))).resolves.toMatchObject({
        kind: "acquired",
        duplicate: true,
        lease: { owner: "sm-switch", requestId: "switch-001" },
      });
      await expect(store.acquireBackendMaintenanceLease(leaseInput({
        owner: "another-owner",
        tokenHash: "sha256:another-token",
      }))).resolves.toMatchObject({
        kind: "held",
        lease: { owner: "sm-switch" },
      });

      await expect(store.releaseBackendMaintenanceLease({
        ...leaseInput({ owner: "another-owner", tokenHash: "sha256:opaque-token-A" }),
        releasedAt: asTimestamp(1_700_000_000_020),
      })).resolves.toMatchObject({ kind: "owner_mismatch" });
      await expect(store.releaseBackendMaintenanceLease({
        ...leaseInput({ tokenHash: "sha256:wrong-token" }),
        releasedAt: asTimestamp(1_700_000_000_021),
      })).resolves.toMatchObject({ kind: "token_mismatch" });
      await expect(store.releaseBackendMaintenanceLease({
        ...leaseInput({ tokenHash: "sha256:opaque-token-A" }),
        releasedAt: asTimestamp(1_700_000_000_022),
      })).resolves.toMatchObject({ kind: "released", duplicate: false });
      await expect(store.releaseBackendMaintenanceLease({
        ...leaseInput({ tokenHash: "sha256:opaque-token-A" }),
        releasedAt: asTimestamp(1_700_000_000_023),
      })).resolves.toEqual({ kind: "released", duplicate: true });

      const events = await store.listBackendMaintenanceLeaseEvents("claude");
      expect(events.map((event) => event.outcome)).toEqual([
        "not_held",
        "released",
        "token_mismatch",
        "owner_mismatch",
        "held",
        "duplicate",
        "acquired",
      ]);
      expect(JSON.stringify(events)).not.toContain("opaque-token-A");
    } finally {
      await cleanup();
    }
  });

  test("an admission write error rolls back the status transition instead of silently admitting", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const firstId = await seedIdleClaudeSession(store, "sess_first");
      const secondId = await seedIdleClaudeSession(store, "sess_second");
      await store.startMessageRun(admissionInput(firstId, "mr_duplicate_id"));
      await store.finishMessageRun(asMessageRunId("mr_duplicate_id"), "completed", "done");

      await expect(store.admitMessageRun(admissionInput(secondId, "mr_duplicate_id")))
        .rejects.toThrow(/UNIQUE constraint failed/u);
      expect((await store.findSessionById(secondId))?.status).toBe("idle");
      expect(await store.findRunningMessageRunBySession(secondId)).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
