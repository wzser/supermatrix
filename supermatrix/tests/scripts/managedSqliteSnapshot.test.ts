import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SqliteBindingStore } from "../../src/adapters/store-sqlite/index.ts";

const NOW_MS = new Date("2026-08-04T03:00:00.000Z").getTime();
const HOUR_MS = 60 * 60 * 1000;
const tempDirs: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "managed-sqlite-snapshot-test-"));
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
    db.exec("CREATE TABLE evidence (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO evidence (id, value) VALUES (?, ?)").run("row-1", "kept from WAL");
  } finally {
    db.close();
  }
}

async function lifecycle() {
  return import("../../scripts/managed-sqlite-snapshot.ts");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("managed-sqlite-snapshot", () => {
  test("creates one verified snapshot with operation identity and a generic audit row", async () => {
    const root = tempRoot();
    const sourceDbPath = join(root, "supermatrix.db");
    const auditDbPath = join(root, "audit.db");
    const managedRoot = join(root, "managed");
    createSourceDb(sourceDbPath);
    await createAuditDb(auditDbPath);

    const result = await (await lifecycle()).createManagedSqliteSnapshot({
      sourceDbPath,
      auditDbPath,
      managedRoot,
      owner: "codexroot",
      operationId: "repair-mr_test0001",
      reason: "pre-mutation runtime repair",
      expiryHours: 24,
      nowMs: NOW_MS,
      snapshotId: "2026-08-04T03-00-00Z-runtime01",
    });

    expect(result.receipt).toMatchObject({
      schemaVersion: 2,
      owner: "codexroot",
      operationId: "repair-mr_test0001",
      status: "active",
      integrityCheck: "ok",
    });
    expect(result.receipt.expiresAt).toBe(new Date(NOW_MS + 24 * HOUR_MS).toISOString());
    expect(result.receipt.snapshotPath).toMatch(/snapshot\.sqlite$/u);
    expect(existsSync(result.receipt.snapshotPath)).toBe(true);

    const snapshot = new Database(result.receipt.snapshotPath, { readonly: true });
    expect(snapshot.prepare("SELECT value FROM evidence WHERE id = ?").pluck().get("row-1")).toBe("kept from WAL");
    snapshot.close();

    const audit = new Database(auditDbPath, { readonly: true });
    const row = audit.prepare(
      "SELECT event, operation_id, owner, snapshot_bytes FROM managed_sqlite_snapshot_audit",
    ).get() as { event: string; operation_id: string; owner: string; snapshot_bytes: number };
    audit.close();
    expect(row).toMatchObject({ event: "created", operation_id: "repair-mr_test0001", owner: "codexroot" });
    expect(row.snapshot_bytes).toBeGreaterThan(0);
  });

  test("rejects a second active snapshot for the same source instead of deleting the first", async () => {
    const root = tempRoot();
    const sourceDbPath = join(root, "supermatrix.db");
    const auditDbPath = join(root, "audit.db");
    const managedRoot = join(root, "managed");
    createSourceDb(sourceDbPath);
    await createAuditDb(auditDbPath);
    const api = await lifecycle();

    const first = await api.createManagedSqliteSnapshot({
      sourceDbPath, auditDbPath, managedRoot, owner: "codexroot", operationId: "repair-first",
      reason: "first", expiryHours: 24, nowMs: NOW_MS, snapshotId: "2026-08-04T03-00-00Z-first001",
    });

    await expect(api.createManagedSqliteSnapshot({
      sourceDbPath, auditDbPath, managedRoot, owner: "codexroot", operationId: "repair-second",
      reason: "second", expiryHours: 24, nowMs: NOW_MS + 1, snapshotId: "2026-08-04T03-00-01Z-second01",
    })).rejects.toThrow("active snapshot already exists for source");
    expect(existsSync(first.receipt.snapshotPath)).toBe(true);
  });

  test("finalize requires the matching operation and releases the artifact immediately", async () => {
    const root = tempRoot();
    const sourceDbPath = join(root, "scheduler.db");
    const auditDbPath = join(root, "audit.db");
    const managedRoot = join(root, "managed");
    createSourceDb(sourceDbPath);
    await createAuditDb(auditDbPath);
    const api = await lifecycle();
    const created = await api.createManagedSqliteSnapshot({
      sourceDbPath, auditDbPath, managedRoot, owner: "codexroot", operationId: "scheduler-repair",
      reason: "repair", expiryHours: 24, nowMs: NOW_MS, snapshotId: "2026-08-04T03-00-00Z-finalize1",
    });

    await expect(api.finalizeManagedSqliteSnapshot({
      auditDbPath, receiptPath: created.receiptPath, operationId: "wrong-operation", nowMs: NOW_MS + 1,
    })).rejects.toThrow("operation id does not match");

    const released = await api.finalizeManagedSqliteSnapshot({
      auditDbPath, receiptPath: created.receiptPath, operationId: "scheduler-repair", nowMs: NOW_MS + 2,
    });
    expect(released).toMatchObject({ status: "released", releaseReason: "operation-verified" });
    expect(existsSync(created.receipt.snapshotPath)).toBe(false);
    expect(existsSync(created.receiptPath)).toBe(true);
    await expect(api.finalizeManagedSqliteSnapshot({
      auditDbPath, receiptPath: created.receiptPath, operationId: "wrong-operation", nowMs: NOW_MS + 3,
    })).rejects.toThrow("operation id does not match");
  });

  test("expiry releases an unresolved snapshot without requiring a disaster backup", async () => {
    const root = tempRoot();
    const sourceDbPath = join(root, "scheduler-v2.db");
    const auditDbPath = join(root, "audit.db");
    const managedRoot = join(root, "managed");
    createSourceDb(sourceDbPath);
    await createAuditDb(auditDbPath);
    const api = await lifecycle();
    const created = await api.createManagedSqliteSnapshot({
      sourceDbPath, auditDbPath, managedRoot, owner: "codexroot", operationId: "scheduler-v2-repair",
      reason: "expiry", expiryHours: 1, nowMs: NOW_MS, snapshotId: "2026-08-04T03-00-00Z-expiry01",
    });

    const pruned = await api.pruneManagedSqliteSnapshots({
      auditDbPath, managedRoot, nowMs: NOW_MS + HOUR_MS,
    });

    expect(pruned.released).toEqual([{ snapshotId: created.receipt.snapshotId, reason: "expiry" }]);
    expect(existsSync(created.receipt.snapshotPath)).toBe(false);
    expect(JSON.parse(readFileSync(created.receiptPath, "utf8"))).toMatchObject({
      status: "released",
      releaseReason: "expiry",
    });
  });

  test("hard-prunes an orphaned managed artifact after the 72-hour cap", async () => {
    const root = tempRoot();
    const auditDbPath = join(root, "audit.db");
    const managedRoot = join(root, "managed");
    const orphanDir = join(managedRoot, "snapshots", "2026-08-01T00-00-00Z-orphan01");
    const orphanPath = join(orphanDir, "snapshot.sqlite");
    mkdirSync(orphanDir, { recursive: true });
    createSourceDb(orphanPath);
    const old = new Date(NOW_MS - 73 * HOUR_MS);
    utimesSync(orphanPath, old, old);
    utimesSync(orphanDir, old, old);
    await createAuditDb(auditDbPath);

    const pruned = await (await lifecycle()).pruneManagedSqliteSnapshots({ auditDbPath, managedRoot, nowMs: NOW_MS });

    expect(pruned.orphanedReleased).toEqual([{
      snapshotId: "2026-08-01T00-00-00Z-orphan01",
      reason: "orphan-hard-expiry",
    }]);
    expect(existsSync(orphanDir)).toBe(false);
  });

  test("a malformed expiry is skipped rather than interpreted as immediately expired", async () => {
    const root = tempRoot();
    const sourceDbPath = join(root, "supermatrix.db");
    const auditDbPath = join(root, "audit.db");
    const managedRoot = join(root, "managed");
    createSourceDb(sourceDbPath);
    await createAuditDb(auditDbPath);
    const api = await lifecycle();
    const created = await api.createManagedSqliteSnapshot({
      sourceDbPath, auditDbPath, managedRoot, owner: "codexroot", operationId: "malformed-expiry",
      reason: "corruption test", expiryHours: 24, nowMs: NOW_MS, snapshotId: "2026-08-04T03-00-00Z-malformed1",
    });
    const receipt = JSON.parse(readFileSync(created.receiptPath, "utf8")) as Record<string, unknown>;
    receipt.expiresAt = "not-a-date";
    writeFileSync(created.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    await expect(api.createManagedSqliteSnapshot({
      sourceDbPath, auditDbPath, managedRoot, owner: "codexroot", operationId: "after-corruption",
      reason: "must not bypass corrupt active state", expiryHours: 24, nowMs: NOW_MS + 1,
      snapshotId: "2026-08-04T03-00-01Z-afterbad1",
    })).rejects.toThrow("unreadable snapshot receipt blocks create");

    const pruned = await api.pruneManagedSqliteSnapshots({ auditDbPath, managedRoot, nowMs: NOW_MS + HOUR_MS });

    expect(pruned.released).toEqual([]);
    expect(pruned.skipped).toEqual([created.receiptPath]);
    expect(existsSync(created.receipt.snapshotPath)).toBe(true);
  });
});
