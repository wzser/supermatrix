import { describe, expect, it, vi } from "vitest";
import { reconcileBackendProcessesCheck } from "../../../../src/app/bootSelfCheck/checks/reconcileBackendProcesses.ts";
import { createFakeProcessLister } from "../../../fakes/fakeProcessLister.ts";
import { SqliteBindingStore } from "../../../../src/adapters/store-sqlite/index.ts";
import {
  asAbsolutePath,
  asSessionId,
  asTimestamp,
  asMessageRunId,
  asLarkGroupId,
} from "../../../../src/domain/ids.ts";
import type { BootCheckContext } from "../../../../src/app/bootSelfCheck/types.ts";

// A real backend session id is a 36-char hex UUID.
const ORPHAN_UUID = "53316059-aaaa-bbbb-cccc-000000000001";

async function makeStoreWithOrphan() {
  const store = new SqliteBindingStore(":memory:");
  await store.init();
  const now = asTimestamp(1_000_000);
  await store.createSession({
    id: asSessionId("sess_orph"),
    name: "orphaned",
    scope: "root",
    backend: "claude",
    workdir: asAbsolutePath("/workspace/orphaned"),
    purpose: "",
    createdAt: now,
  });
  await store.updateSessionBackendSessionId(asSessionId("sess_orph"), ORPHAN_UUID);
  await store.startMessageRun({
    id: asMessageRunId("mr_orph"),
    sessionId: asSessionId("sess_orph"),
    groupId: asLarkGroupId("g"),
    prompt: "hi",
    startedAt: now,
  });
  return store;
}

describe("reconcile-backend-processes (observe)", () => {
  it("reports orphans + stuck runs without killing or writing to DB", async () => {
    const store = await makeStoreWithOrphan();
    const lister = createFakeProcessLister({
      processes: [
        {
          pid: 72418,
          ppid: 1,
          cmd: `claude -p --resume ${ORPHAN_UUID}`,
          cwd: "/workspace/orphaned",
          backendSessionId: ORPHAN_UUID,
        },
      ],
    });
    const ctx: BootCheckContext = {
      cfg: { workspaceRoot: "/workspace" } as BootCheckContext["cfg"],
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: () => ({} as never),
      } as never,
      processLister: lister,
      store,
    };
    const result = await reconcileBackendProcessesCheck.run(ctx, "observe");
    expect(result.status).toBe("info");
    if (result.status === "info") {
      expect(result.detail).toMatchObject({
        wouldKill: [72418],
      });
    }
    // Nothing was actually killed
    expect(lister.killedPids).toEqual([]);
    // Run is still in running state
    const runsStillRunning = await store.findRunningMessageRuns();
    expect(runsStillRunning.map((r) => r.id)).toEqual(["mr_orph"]);
  });

  it("returns ok when system is consistent", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    const lister = createFakeProcessLister({ processes: [] });
    const ctx: BootCheckContext = {
      cfg: { workspaceRoot: "/workspace" } as BootCheckContext["cfg"],
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: () => ({} as never),
      } as never,
      processLister: lister,
      store,
    };
    const result = await reconcileBackendProcessesCheck.run(ctx, "observe");
    expect(result.status).toBe("ok");
  });

  it("does not report runs as hanging when session is busy (legitimate in-progress run)", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    const now = asTimestamp(1_000_000);
    await store.createSession({
      id: asSessionId("sess_busy"),
      name: "busy-session",
      scope: "root",
      backend: "claude",
      workdir: asAbsolutePath("/workspace/busy"),
      purpose: "",
      createdAt: now,
    });
    await store.updateSessionStatus(asSessionId("sess_busy"), "busy", now);
    await store.startMessageRun({
      id: asMessageRunId("mr_busy"),
      sessionId: asSessionId("sess_busy"),
      groupId: asLarkGroupId("g"),
      prompt: "processing",
      startedAt: now,
    });
    const lister = createFakeProcessLister({ processes: [] });
    const ctx: BootCheckContext = {
      cfg: { workspaceRoot: "/workspace" } as BootCheckContext["cfg"],
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({} as never) } as never,
      processLister: lister,
      store,
    };
    const result = await reconcileBackendProcessesCheck.run(ctx, "observe");
    expect(result.status).toBe("ok");
  });

  it("reports run as hanging when session is idle", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    const now = asTimestamp(1_000_000);
    await store.createSession({
      id: asSessionId("sess_idle"),
      name: "idle-session",
      scope: "root",
      backend: "claude",
      workdir: asAbsolutePath("/workspace/idle"),
      purpose: "",
      createdAt: now,
    });
    await store.updateSessionStatus(asSessionId("sess_idle"), "idle", now);
    await store.startMessageRun({
      id: asMessageRunId("mr_stuck"),
      sessionId: asSessionId("sess_idle"),
      groupId: asLarkGroupId("g"),
      prompt: "stuck",
      startedAt: now,
    });
    const lister = createFakeProcessLister({ processes: [] });
    const ctx: BootCheckContext = {
      cfg: { workspaceRoot: "/workspace" } as BootCheckContext["cfg"],
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({} as never) } as never,
      processLister: lister,
      store,
    };
    const result = await reconcileBackendProcessesCheck.run(ctx, "observe");
    expect(result.status).toBe("info");
    if (result.status === "info") {
      expect(result.detail).toMatchObject({
        wouldTimeout: ["mr_stuck"],
      });
    }
  });
});

describe("reconcile-backend-processes (execute)", () => {
  // Regression: socail-king incident (2026-05-15). A claude run orphaned by a
  // previous console kept matching a live orphan process across reboots, so the
  // boot reconciler "kept" it forever — the run never left `running` and the
  // session was permanently blocked (dispatcher rejected every new prompt with
  // "prior run still marked running"). Boot must time such runs out: an orphan
  // process spawned by a dead console has no readable stdout for the new one.
  it("times out a claude run even when a live orphan process still matches it", async () => {
    const store = await makeStoreWithOrphan();
    const lister = createFakeProcessLister({
      processes: [
        {
          pid: 72418,
          ppid: 1,
          cmd: `claude -p --resume ${ORPHAN_UUID}`,
          cwd: "/workspace/orphaned",
          backendSessionId: ORPHAN_UUID,
        },
      ],
    });
    const ctx: BootCheckContext = {
      cfg: { workspaceRoot: "/workspace" } as BootCheckContext["cfg"],
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({} as never) } as never,
      processLister: lister,
      store,
    };
    const result = await reconcileBackendProcessesCheck.run(ctx, "execute");
    expect(result.status).toBe("warn");
    // The orphaned claude process is killed — a previous console spawned it and
    // the current console has no handle to its output stream.
    expect(lister.killedPids).toEqual([72418]);
    // The run is timed out, not kept.
    expect(await store.findRunningMessageRuns()).toEqual([]);
    const row = store.db
      .prepare("SELECT status, error_message FROM message_runs WHERE id = ?")
      .get("mr_orph") as { status: string; error_message: string | null };
    expect(row.status).toBe("timeout");
    expect(row.error_message).toBe("boot reconcile: backend orphaned by console restart");
  });

  it("times out a run when no orphan process exists for it", async () => {
    const store = await makeStoreWithOrphan();
    const lister = createFakeProcessLister({ processes: [] }); // no alive orphans
    const ctx: BootCheckContext = {
      cfg: { workspaceRoot: "/workspace" } as BootCheckContext["cfg"],
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({} as never) } as never,
      processLister: lister,
      store,
    };
    const result = await reconcileBackendProcessesCheck.run(ctx, "execute");
    expect(result.status).toBe("warn");
    expect(lister.killedPids).toEqual([]);
    expect(await store.findRunningMessageRuns()).toEqual([]);
    const row = store.db
      .prepare("SELECT error_message FROM message_runs WHERE id = ?")
      .get("mr_orph") as { error_message: string };
    expect(row.error_message).toBe("boot reconcile: backend orphaned by console restart");
  });

  it("times out a claude run with no persisted backend_session_id even when a cwd-matched orphan is alive", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    const now = asTimestamp(1_000_000);
    await store.createSession({
      id: asSessionId("sess_fresh"),
      name: "fresh-child",
      scope: "child",
      backend: "claude",
      workdir: asAbsolutePath("/workspace/fresh"),
      purpose: "",
      createdAt: now,
    });
    await store.updateSessionStatus(asSessionId("sess_fresh"), "error", now);
    await store.startMessageRun({
      id: asMessageRunId("mr_fresh"),
      sessionId: asSessionId("sess_fresh"),
      groupId: asLarkGroupId("g"),
      prompt: "processing",
      startedAt: now,
    });

    const lister = createFakeProcessLister({
      processes: [
        {
          pid: 72419,
          ppid: 1,
          cmd: 'claude -p --output-format stream-json "processing"',
          cwd: "/workspace/fresh",
          backendSessionId: null,
        },
      ],
    });
    const ctx: BootCheckContext = {
      cfg: { workspaceRoot: "/workspace" } as BootCheckContext["cfg"],
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({} as never) } as never,
      processLister: lister,
      store,
    };
    const result = await reconcileBackendProcessesCheck.run(ctx, "execute");
    expect(result.status).toBe("warn");
    expect(lister.killedPids).toEqual([72419]);
    expect(await store.findRunningMessageRuns()).toEqual([]);
    const row = store.db
      .prepare("SELECT status, error_message FROM message_runs WHERE id = ?")
      .get("mr_fresh") as { status: string; error_message: string | null };
    expect(row.status).toBe("timeout");
    expect(row.error_message).toBe("boot reconcile: backend orphaned by console restart");
  });
});

// ---------------------------------------------------------------------------
// T7: kimi ACP PID-aware filtering
// ---------------------------------------------------------------------------

const FAKE_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => ({} as never),
} as never;

describe("reconcile-backend-processes: kimi ACP PID-aware filtering", () => {
  it("kimi acp matching the live backend PID is preserved, orphan with different PID is killed", async () => {
    const livePid = 11111;
    const orphanPid = 22222;
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    const killAll = vi.fn(async (pids: number[]) => pids);
    const processLister = {
      list: async () => [
        { pid: livePid, cmd: "/Users/x/.local/bin/kimi acp", cwd: "/ws", backendSessionId: null, ppid: 99 },
        { pid: orphanPid, cmd: "/Users/x/.local/bin/kimi acp", cwd: "/ws", backendSessionId: null, ppid: 1 },
      ],
      killAll,
      getCommand: async () => null,
      getProcessInfo: async () => null,
    };
    const ctx: BootCheckContext = {
      cfg: { workspaceRoot: "/ws" } as BootCheckContext["cfg"],
      logger: FAKE_LOGGER,
      processLister,
      store,
      getKimiAcpPid: () => livePid,
    };
    await reconcileBackendProcessesCheck.run(ctx, "execute");
    // Only the orphan (different PID) should be killed
    expect(killAll).toHaveBeenCalledWith([orphanPid]);
  });

  it("kimi term / kimi web (no 'acp' in cmd) is left alone and NOT in kill list", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    const killAll = vi.fn(async (pids: number[]) => pids);
    const processLister = {
      list: async () => [
        { pid: 33333, cmd: "/Users/x/.local/bin/kimi term", cwd: "/ws", backendSessionId: null, ppid: 1 },
        { pid: 44444, cmd: "/Users/x/.local/bin/kimi web", cwd: "/ws", backendSessionId: null, ppid: 1 },
      ],
      killAll,
      getCommand: async () => null,
      getProcessInfo: async () => null,
    };
    const ctx: BootCheckContext = {
      cfg: { workspaceRoot: "/ws" } as BootCheckContext["cfg"],
      logger: FAKE_LOGGER,
      processLister,
      store,
      getKimiAcpPid: () => null,
    };
    const result = await reconcileBackendProcessesCheck.run(ctx, "execute");
    // kimi term / web must not appear in kill list
    expect(result.status).toBe("ok");
    expect(killAll).not.toHaveBeenCalled();
  });

  it("when getKimiAcpPid returns null, all kimi acp orphans are killed", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    const killAll = vi.fn(async (pids: number[]) => pids);
    const processLister = {
      list: async () => [
        { pid: 55555, cmd: "/Users/x/.local/bin/kimi acp", cwd: "/ws", backendSessionId: null, ppid: 1 },
        { pid: 66666, cmd: "/Users/x/.local/bin/kimi acp", cwd: "/ws", backendSessionId: null, ppid: 1 },
      ],
      killAll,
      getCommand: async () => null,
      getProcessInfo: async () => null,
    };
    const ctx: BootCheckContext = {
      cfg: { workspaceRoot: "/ws" } as BootCheckContext["cfg"],
      logger: FAKE_LOGGER,
      processLister,
      store,
      getKimiAcpPid: () => null,
    };
    await reconcileBackendProcessesCheck.run(ctx, "execute");
    // Both kimi acp orphans killed (no live kimi backend)
    expect(killAll).toHaveBeenCalledWith([55555, 66666]);
  });

  it("kimi session with running run is kept alive when live ACP PID matches", async () => {
    const livePid = 77777;
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    const now = asTimestamp(1_000_000);
    await store.createSession({
      id: asSessionId("sess_kimi"),
      name: "kimi-session",
      scope: "root",
      backend: "kimi",
      workdir: asAbsolutePath("/workspace/kimi"),
      purpose: "",
      createdAt: now,
    });
    await store.startMessageRun({
      id: asMessageRunId("mr_kimi"),
      sessionId: asSessionId("sess_kimi"),
      groupId: asLarkGroupId("g"),
      prompt: "hello kimi",
      startedAt: now,
    });
    const killAll = vi.fn(async (pids: number[]) => pids);
    const processLister = {
      // kimi acp runs from a different cwd than the session workdir — that's intentional
      list: async () => [
        { pid: livePid, cmd: "/Users/x/.local/bin/kimi acp", cwd: "/", backendSessionId: null, ppid: 1 },
      ],
      killAll,
      getCommand: async () => null,
      getProcessInfo: async () => null,
    };
    const ctx: BootCheckContext = {
      cfg: { workspaceRoot: "/workspace" } as BootCheckContext["cfg"],
      logger: FAKE_LOGGER,
      processLister,
      store,
      getKimiAcpPid: () => livePid,
    };
    const result = await reconcileBackendProcessesCheck.run(ctx, "execute");
    expect(result.status).toBe("warn");
    // Live process was reserved — nothing killed
    expect(killAll).not.toHaveBeenCalled();
    // Run stays running
    const runningAfter = await store.findRunningMessageRuns();
    expect(runningAfter.map((r) => r.id)).toEqual(["mr_kimi"]);
  });

  it("claude / codex orphans are still killed — existing behavior unchanged", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    const killAll = vi.fn(async (pids: number[]) => pids);
    const processLister = {
      list: async () => [
        { pid: 88888, cmd: "claude -p", cwd: "/workspace/c", backendSessionId: null, ppid: 1 },
        { pid: 99999, cmd: "codex -p", cwd: "/workspace/d", backendSessionId: null, ppid: 1 },
      ],
      killAll,
      getCommand: async () => null,
      getProcessInfo: async () => null,
    };
    const ctx: BootCheckContext = {
      cfg: { workspaceRoot: "/workspace" } as BootCheckContext["cfg"],
      logger: FAKE_LOGGER,
      processLister,
      store,
    };
    await reconcileBackendProcessesCheck.run(ctx, "execute");
    expect(killAll).toHaveBeenCalledWith([88888, 99999]);
  });
});
