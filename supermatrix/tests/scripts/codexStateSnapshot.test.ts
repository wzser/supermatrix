import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SqliteBindingStore } from "../../src/adapters/store-sqlite/index.ts";

const NOW_MS = new Date("2026-08-03T03:00:00.000Z").getTime();
const tempDirs: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "codex-state-snapshot-test-"));
  tempDirs.push(root);
  return root;
}

async function createAuditDb(path: string): Promise<void> {
  const store = new SqliteBindingStore(path);
  try {
    await store.init();
  } finally {
    await store.close();
  }
}

function createSourceDb(path: string): void {
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
    db.prepare("INSERT INTO threads (id, title) VALUES (?, ?)").run("thread-1", "kept from WAL");
  } finally {
    db.close();
  }
}

async function lifecycle() {
  return import("../../scripts/codex-state-snapshot.ts");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("codex-state-snapshot", () => {
  test("creates a verified managed snapshot with owner reason expiry receipt and an audit row", async () => {
    const root = tempRoot();
    const sourceDbPath = join(root, "state_5.sqlite");
    const auditDbPath = join(root, "supermatrix.db");
    const managedRoot = join(root, "managed");
    createSourceDb(sourceDbPath);
    await createAuditDb(auditDbPath);

    const result = await (await lifecycle()).createManagedCodexStateSnapshot({
      sourceDbPath,
      auditDbPath,
      managedRoot,
      owner: "codexroot",
      operationId: "codex-restore-test0001",
      reason: "test pre-restore snapshot",
      expiryHours: 24,
      nowMs: NOW_MS,
      snapshotId: "2026-08-03T03-00-00Z-test0001",
    });

    expect(result.receipt.status).toBe("active");
    expect(result.receipt.owner).toBe("codexroot");
    expect(result.receipt.reason).toBe("test pre-restore snapshot");
    expect(result.receipt.expiresAt).toBe(new Date(NOW_MS + 24 * 60 * 60 * 1000).toISOString());
    expect(result.receipt.integrityCheck).toBe("ok");
    expect(existsSync(result.receipt.snapshotPath)).toBe(true);
    expect(existsSync(result.receiptPath)).toBe(true);

    const snapshot = new Database(result.receipt.snapshotPath, { readonly: true });
    expect(snapshot.prepare("SELECT title FROM threads WHERE id = ?").pluck().get("thread-1")).toBe("kept from WAL");
    snapshot.close();

    const audit = new Database(auditDbPath, { readonly: true });
    const row = audit.prepare("SELECT event, operation_id, owner, reason, snapshot_bytes FROM managed_sqlite_snapshot_audit").get() as {
      event: string;
      operation_id: string;
      owner: string;
      reason: string;
      snapshot_bytes: number;
    };
    audit.close();
    expect(row).toMatchObject({
      event: "created",
      operation_id: "codex-restore-test0001",
      owner: "codexroot",
      reason: "test pre-restore snapshot",
    });
    expect(row.snapshot_bytes).toBeGreaterThan(0);
  });

  test("refuses a second active Codex snapshot instead of deleting rollback state for an unfinished operation", async () => {
    const root = tempRoot();
    const sourceDbPath = join(root, "state_5.sqlite");
    const auditDbPath = join(root, "supermatrix.db");
    const managedRoot = join(root, "managed");
    createSourceDb(sourceDbPath);
    await createAuditDb(auditDbPath);
    const api = await lifecycle();

    const first = await api.createManagedCodexStateSnapshot({
      sourceDbPath, auditDbPath, managedRoot, owner: "codexroot", operationId: "codex-first", reason: "first", expiryHours: 24,
      nowMs: NOW_MS, snapshotId: "2026-08-03T03-00-00Z-first001",
    });
    await expect(api.createManagedCodexStateSnapshot({
      sourceDbPath, auditDbPath, managedRoot, owner: "codexroot", operationId: "codex-second", reason: "second", expiryHours: 24,
      nowMs: NOW_MS + 1, snapshotId: "2026-08-03T03-00-01Z-second01",
    })).rejects.toThrow("active snapshot already exists for source");

    expect(existsSync(first.receipt.snapshotPath)).toBe(true);
    expect(existsSync(first.receiptPath)).toBe(true);
    expect(JSON.parse(readFileSync(first.receiptPath, "utf8"))).toMatchObject({
      status: "active",
    });

    const audit = new Database(auditDbPath, { readonly: true });
    const events = audit.prepare("SELECT event FROM managed_sqlite_snapshot_audit WHERE snapshot_id = ? ORDER BY created_at, id")
      .all(first.receipt.snapshotId)
      .map((row) => (row as { event: string }).event);
    audit.close();
    expect(events).toEqual(["created"]);
  });

  test("a verified successful restore releases its snapshot before expiry and preserves a compact receipt", async () => {
    const root = tempRoot();
    const sourceDbPath = join(root, "state_5.sqlite");
    const auditDbPath = join(root, "supermatrix.db");
    const managedRoot = join(root, "managed");
    createSourceDb(sourceDbPath);
    await createAuditDb(auditDbPath);
    const api = await lifecycle();
    const created = await api.createManagedCodexStateSnapshot({
      sourceDbPath, auditDbPath, managedRoot, owner: "codexroot", operationId: "codex-restore", reason: "restore", expiryHours: 24,
      nowMs: NOW_MS, snapshotId: "2026-08-03T03-00-00Z-restore1",
    });

    const finalized = await api.finalizeManagedCodexStateSnapshot({
      sourceDbPath,
      auditDbPath,
      receiptPath: created.receiptPath,
      operationId: "codex-restore",
      nowMs: NOW_MS + 5_000,
    });

    expect(finalized.status).toBe("released");
    expect(finalized.releaseReason).toBe("operation-verified");
    expect(existsSync(created.receipt.snapshotPath)).toBe(false);
    expect(existsSync(created.receiptPath)).toBe(true);
  });

  test("the managed sweep releases an expired snapshot without deleting its receipt history", async () => {
    const root = tempRoot();
    const sourceDbPath = join(root, "state_5.sqlite");
    const auditDbPath = join(root, "supermatrix.db");
    const managedRoot = join(root, "managed");
    createSourceDb(sourceDbPath);
    await createAuditDb(auditDbPath);
    const api = await lifecycle();
    const created = await api.createManagedCodexStateSnapshot({
      sourceDbPath, auditDbPath, managedRoot, owner: "codexroot", operationId: "codex-expiry", reason: "expiry", expiryHours: 1,
      nowMs: NOW_MS, snapshotId: "2026-08-03T03-00-00Z-expired1",
    });

    const pruned = await api.pruneManagedCodexStateSnapshots({
      auditDbPath,
      managedRoot,
      nowMs: NOW_MS + 60 * 60 * 1000,
    });

    expect(pruned.released).toEqual([{ snapshotId: created.receipt.snapshotId, reason: "expiry" }]);
    expect(existsSync(created.receipt.snapshotPath)).toBe(false);
    expect(JSON.parse(readFileSync(created.receiptPath, "utf8"))).toMatchObject({
      status: "released",
      releaseReason: "expiry",
    });
  });

  test("refuses to reuse a snapshot id instead of overwriting an existing managed artifact", async () => {
    const root = tempRoot();
    const sourceDbPath = join(root, "state_5.sqlite");
    const auditDbPath = join(root, "supermatrix.db");
    const managedRoot = join(root, "managed");
    createSourceDb(sourceDbPath);
    await createAuditDb(auditDbPath);
    const api = await lifecycle();
    const input = {
      sourceDbPath, auditDbPath, managedRoot, owner: "codexroot", operationId: "codex-collision", reason: "collision", expiryHours: 24,
      nowMs: NOW_MS, snapshotId: "2026-08-03T03-00-00Z-collision",
    };
    const created = await api.createManagedCodexStateSnapshot(input);

    await expect(api.createManagedCodexStateSnapshot(input)).rejects.toThrow("snapshot id already exists");
    expect(existsSync(created.receipt.snapshotPath)).toBe(true);
  });

  test("prunes a live schema-v1 Codex receipt without moving its legacy artifact", async () => {
    const root = tempRoot();
    const sourceDbPath = join(root, "state_5.sqlite");
    const auditDbPath = join(root, "supermatrix.db");
    const managedRoot = join(root, "managed");
    const snapshotId = "2026-08-03T03-00-00Z-legacy01";
    const snapshotDir = join(managedRoot, "snapshots", snapshotId);
    const snapshotPath = join(snapshotDir, "state_5.sqlite");
    const receiptDir = join(managedRoot, "receipts");
    const receiptPath = join(receiptDir, `${snapshotId}.json`);
    createSourceDb(sourceDbPath);
    mkdirSync(snapshotDir, { recursive: true });
    createSourceDb(snapshotPath);
    mkdirSync(receiptDir, { recursive: true });
    await createAuditDb(auditDbPath);
    writeFileSync(receiptPath, `${JSON.stringify({
      schemaVersion: 1,
      snapshotId,
      managedRoot,
      sourcePath: sourceDbPath,
      owner: "codexroot",
      reason: "legacy live receipt",
      createdAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(NOW_MS - 1).toISOString(),
      snapshotPath,
      snapshotBytes: statSync(snapshotPath).size,
      snapshotSha256: "legacy-hash",
      integrityCheck: "ok",
      status: "active",
    }, null, 2)}\n`);

    const pruned = await (await lifecycle()).pruneManagedCodexStateSnapshots({ auditDbPath, managedRoot, nowMs: NOW_MS });

    expect(pruned.released).toEqual([{ snapshotId, reason: "expiry" }]);
    expect(existsSync(snapshotPath)).toBe(false);
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      operationId: snapshotId,
      status: "released",
      releaseReason: "expiry",
    });
  });
});
