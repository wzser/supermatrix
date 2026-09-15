#!/usr/bin/env tsx
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { SqliteBindingStore } from "../src/adapters/store-sqlite/index.ts";

const HOUR_MS = 60 * 60 * 1000;
export const MAX_EXPIRY_HOURS = 72;
const RECEIPT_SCHEMA_VERSION = 2;
const LEGACY_RECEIPT_SCHEMA_VERSION = 1;

export const DEFAULT_CODEX_STATE_DB_PATH = join(homedir(), ".codex", "state_5.sqlite");
export const DEFAULT_RUNTIME_ROOT = "/Users/LOCAL_USER/SuperMatrixRuntime";

export type SnapshotStatus = "active" | "released";
export type ReleaseReason =
  | "operation-verified"
  | "expiry"
  | "restore-success"
  | "superseded-by-verified-full-backup";

export type ManagedSqliteSnapshotReceipt = {
  schemaVersion: 1 | 2;
  snapshotId: string;
  operationId: string;
  managedRoot: string;
  sourcePath: string;
  owner: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  snapshotPath: string;
  snapshotBytes: number;
  snapshotSha256: string;
  integrityCheck: "ok";
  status: SnapshotStatus;
  releasedAt?: string;
  releaseReason?: ReleaseReason;
  sourceIntegrityCheckAtRelease?: "ok";
};

export type CreateManagedSqliteSnapshotInput = {
  sourceDbPath: string;
  auditDbPath: string;
  managedRoot: string;
  owner: string;
  operationId: string;
  reason: string;
  expiryHours: number;
  nowMs?: number;
  snapshotId?: string;
};

export type FinalizeManagedSqliteSnapshotInput = {
  auditDbPath: string;
  receiptPath: string;
  operationId: string;
  nowMs?: number;
};

export type PruneManagedSqliteSnapshotsInput = {
  auditDbPath: string;
  managedRoot: string;
  nowMs?: number;
};

export type ManagedCodexStateSnapshotReceipt = ManagedSqliteSnapshotReceipt;
export type CreateManagedCodexStateSnapshotInput = CreateManagedSqliteSnapshotInput;
export type FinalizeManagedCodexStateSnapshotInput = FinalizeManagedSqliteSnapshotInput & {
  sourceDbPath?: string;
};
export type PruneManagedCodexStateSnapshotsInput = PruneManagedSqliteSnapshotsInput;

export async function createManagedSqliteSnapshot(
  input: CreateManagedSqliteSnapshotInput,
): Promise<{ receipt: ManagedSqliteSnapshotReceipt; receiptPath: string }> {
  const nowMs = input.nowMs ?? Date.now();
  const sourceDbPath = requireRegularFile(input.sourceDbPath, "source SQLite database");
  const auditDbPath = requireRegularFile(input.auditDbPath, "SuperMatrix audit database");
  const managedRoot = resolve(input.managedRoot);
  const owner = requiredText(input.owner, "owner");
  const operationId = validateOperationId(input.operationId);
  const reason = requiredText(input.reason, "reason");
  validateExpiryHours(input.expiryHours);
  const snapshotId = validateSnapshotId(input.snapshotId ?? defaultSnapshotId(nowMs));
  const { snapshotPath, snapshotDir, receiptPath } = managedPaths(managedRoot, snapshotId, RECEIPT_SCHEMA_VERSION);
  if (existsSync(snapshotDir) || existsSync(receiptPath)) {
    throw new Error(`snapshot id already exists: ${snapshotId}`);
  }

  await ensureAuditTable(auditDbPath);
  releaseExpiredAndRejectActiveSource({ auditDbPath, managedRoot, sourcePath: sourceDbPath, nowMs });
  mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });

  let snapshotWritten = false;
  let receiptWritten = false;
  try {
    await backupReadOnlySource(sourceDbPath, snapshotPath);
    snapshotWritten = true;
    chmodSync(snapshotPath, 0o600);
    const integrityCheck = sqliteQuickCheck(snapshotPath);
    const snapshotBytes = statSync(snapshotPath).size;
    const snapshotSha256 = await sha256File(snapshotPath);
    const receipt: ManagedSqliteSnapshotReceipt = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      snapshotId,
      operationId,
      managedRoot,
      sourcePath: sourceDbPath,
      owner,
      reason,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + input.expiryHours * HOUR_MS).toISOString(),
      snapshotPath,
      snapshotBytes,
      snapshotSha256,
      integrityCheck,
      status: "active",
    };
    writeReceipt(receiptPath, receipt);
    receiptWritten = true;
    appendAuditEvent(auditDbPath, receipt, "created", nowMs);
    return { receipt, receiptPath };
  } catch (err) {
    if (receiptWritten) rmSync(receiptPath, { force: true });
    if (snapshotWritten || existsSync(snapshotDir)) rmSync(snapshotDir, { recursive: true, force: true });
    throw err;
  }
}

export async function finalizeManagedSqliteSnapshot(
  input: FinalizeManagedSqliteSnapshotInput,
): Promise<ManagedSqliteSnapshotReceipt> {
  const auditDbPath = requireRegularFile(input.auditDbPath, "SuperMatrix audit database");
  const nowMs = input.nowMs ?? Date.now();
  await ensureAuditTable(auditDbPath);
  const receipt = readReceipt(input.receiptPath);
  if (receipt.operationId !== validateOperationId(input.operationId)) {
    throw new Error(`operation id does not match snapshot receipt: ${receipt.operationId}`);
  }
  if (receipt.status === "released") return receipt;
  const sourceDbPath = requireRegularFile(receipt.sourcePath, "source SQLite database");
  sqliteQuickCheck(sourceDbPath);
  return releaseSnapshot({
    auditDbPath,
    receiptPath: resolve(input.receiptPath),
    receipt,
    nowMs,
    releaseReason: "operation-verified",
    sourceIntegrityCheckAtRelease: "ok",
  });
}

export async function pruneManagedSqliteSnapshots(
  input: PruneManagedSqliteSnapshotsInput,
): Promise<{
  released: Array<{ snapshotId: string; reason: ReleaseReason }>;
  orphanedReleased: Array<{ snapshotId: string; reason: "orphan-hard-expiry" }>;
  skipped: string[];
}> {
  const auditDbPath = requireRegularFile(input.auditDbPath, "SuperMatrix audit database");
  const managedRoot = resolve(input.managedRoot);
  const nowMs = input.nowMs ?? Date.now();
  await ensureAuditTable(auditDbPath);
  const released: Array<{ snapshotId: string; reason: ReleaseReason }> = [];
  const orphanedReleased: Array<{ snapshotId: string; reason: "orphan-hard-expiry" }> = [];
  const skipped: string[] = [];
  const activeSnapshotDirs = new Set<string>();

  for (const receiptPath of listReceiptPaths(managedRoot)) {
    let receipt: ManagedSqliteSnapshotReceipt;
    try {
      receipt = readReceipt(receiptPath);
    } catch {
      skipped.push(receiptPath);
      continue;
    }
    if (receipt.status !== "active") continue;
    const paths = managedPaths(receipt.managedRoot, receipt.snapshotId, receipt.schemaVersion);
    activeSnapshotDirs.add(paths.snapshotDir);
    if (Date.parse(receipt.expiresAt) > nowMs) continue;
    const releasedReceipt = releaseSnapshot({
      auditDbPath,
      receiptPath,
      receipt,
      nowMs,
      releaseReason: "expiry",
    });
    activeSnapshotDirs.delete(paths.snapshotDir);
    released.push({ snapshotId: releasedReceipt.snapshotId, reason: "expiry" });
  }

  const hardExpiryCutoffMs = nowMs - MAX_EXPIRY_HOURS * HOUR_MS;
  for (const snapshotDir of listSnapshotDirs(managedRoot)) {
    if (activeSnapshotDirs.has(snapshotDir)) continue;
    const stat = safeLstat(snapshotDir);
    if (!stat || stat.mtimeMs > hardExpiryCutoffMs) continue;
    const snapshotId = basename(snapshotDir);
    rmSync(snapshotDir, { recursive: true, force: true });
    orphanedReleased.push({ snapshotId, reason: "orphan-hard-expiry" });
  }
  return { released, orphanedReleased, skipped };
}

export async function createManagedCodexStateSnapshot(
  input: CreateManagedCodexStateSnapshotInput,
): Promise<{ receipt: ManagedSqliteSnapshotReceipt; receiptPath: string }> {
  const nowMs = input.nowMs ?? Date.now();
  const snapshotId = input.snapshotId ?? defaultSnapshotId(nowMs);
  return createManagedSqliteSnapshot({
    ...input,
    nowMs,
    snapshotId,
    operationId: input.operationId,
  });
}

export async function finalizeManagedCodexStateSnapshot(
  input: FinalizeManagedCodexStateSnapshotInput,
): Promise<ManagedSqliteSnapshotReceipt> {
  const receipt = readReceipt(input.receiptPath);
  if (input.sourceDbPath && resolve(input.sourceDbPath) !== receipt.sourcePath) {
    throw new Error(`source path does not match snapshot receipt: ${receipt.sourcePath}`);
  }
  return finalizeManagedSqliteSnapshot({
    auditDbPath: input.auditDbPath,
    receiptPath: input.receiptPath,
    operationId: input.operationId,
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
  });
}

export async function pruneManagedCodexStateSnapshots(
  input: PruneManagedCodexStateSnapshotsInput,
): ReturnType<typeof pruneManagedSqliteSnapshots> {
  return pruneManagedSqliteSnapshots(input);
}

function releaseExpiredAndRejectActiveSource(input: {
  auditDbPath: string;
  managedRoot: string;
  sourcePath: string;
  nowMs: number;
}): void {
  for (const receiptPath of listReceiptPaths(input.managedRoot)) {
    let receipt: ManagedSqliteSnapshotReceipt;
    try {
      receipt = readReceipt(receiptPath);
    } catch {
      const receiptName = basename(receiptPath);
      const snapshotId = receiptName.endsWith(".json")
        ? validateSnapshotIdOrNull(receiptName.slice(0, -".json".length))
        : null;
      if (snapshotId) {
        const snapshotDir = managedPaths(input.managedRoot, snapshotId, RECEIPT_SCHEMA_VERSION).snapshotDir;
        if (existsSync(snapshotDir)) {
          throw new Error(`unreadable snapshot receipt blocks create: ${receiptPath}`);
        }
      }
      continue;
    }
    if (
      receipt.status !== "active"
      || receipt.sourcePath !== input.sourcePath
    ) continue;
    if (Date.parse(receipt.expiresAt) > input.nowMs) {
      throw new Error(`active snapshot already exists for source: ${receipt.snapshotId}`);
    }
    releaseSnapshot({
      auditDbPath: input.auditDbPath,
      receiptPath,
      receipt,
      nowMs: input.nowMs,
      releaseReason: "expiry",
    });
  }
}

function releaseSnapshot(input: {
  auditDbPath: string;
  receiptPath: string;
  receipt: ManagedSqliteSnapshotReceipt;
  nowMs: number;
  releaseReason: ReleaseReason;
  sourceIntegrityCheckAtRelease?: "ok";
}): ManagedSqliteSnapshotReceipt {
  const receipt = input.receipt;
  const { snapshotPath, snapshotDir } = managedPaths(receipt.managedRoot, receipt.snapshotId, receipt.schemaVersion);
  if (snapshotPath !== receipt.snapshotPath) throw new Error("snapshot receipt path is outside its managed directory");
  rmSync(snapshotDir, { recursive: true, force: true });
  const released: ManagedSqliteSnapshotReceipt = {
    ...receipt,
    status: "released",
    releasedAt: new Date(input.nowMs).toISOString(),
    releaseReason: input.releaseReason,
    ...(input.sourceIntegrityCheckAtRelease ? { sourceIntegrityCheckAtRelease: input.sourceIntegrityCheckAtRelease } : {}),
  };
  writeReceipt(input.receiptPath, released);
  appendAuditEvent(input.auditDbPath, released, "released", input.nowMs);
  return released;
}

async function backupReadOnlySource(sourceDbPath: string, snapshotPath: string): Promise<void> {
  const source = new Database(sourceDbPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try {
    await source.backup(snapshotPath);
  } finally {
    source.close();
  }
}

function sqliteQuickCheck(path: string): "ok" {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try {
    const result = db.pragma("quick_check(1)", { simple: true });
    if (result !== "ok") throw new Error(`SQLite quick_check failed for ${path}: ${String(result)}`);
    return "ok";
  } finally {
    db.close();
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function ensureAuditTable(auditDbPath: string): Promise<void> {
  const store = new SqliteBindingStore(auditDbPath);
  try {
    const migrations = await store.init();
    if (migrations.degraded.some((entry) => entry.version === 47)) {
      throw new Error("managed SQLite snapshot audit migration is unavailable");
    }
  } finally {
    await store.close();
  }
  const audit = new Database(auditDbPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try {
    const table = audit.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get("managed_sqlite_snapshot_audit");
    if (!table) throw new Error("managed SQLite snapshot audit table is missing");
  } finally {
    audit.close();
  }
}

function appendAuditEvent(
  auditDbPath: string,
  receipt: ManagedSqliteSnapshotReceipt,
  event: "created" | "released",
  nowMs: number,
): void {
  const audit = new Database(auditDbPath, { fileMustExist: true, timeout: 5_000 });
  try {
    audit.prepare(`
      INSERT OR IGNORE INTO managed_sqlite_snapshot_audit (
        id, snapshot_id, operation_id, event, source_path, owner, reason, snapshot_path,
        snapshot_sha256, snapshot_bytes, receipt_path, expires_at, release_reason, created_at
      ) VALUES (
        @id, @snapshotId, @operationId, @event, @sourcePath, @owner, @reason, @snapshotPath,
        @snapshotSha256, @snapshotBytes, @receiptPath, @expiresAt, @releaseReason, @createdAt
      )
    `).run({
      id: `${receipt.snapshotId}:${event}`,
      snapshotId: receipt.snapshotId,
      operationId: receipt.operationId,
      event,
      sourcePath: receipt.sourcePath,
      owner: receipt.owner,
      reason: receipt.reason,
      snapshotPath: receipt.snapshotPath,
      snapshotSha256: receipt.snapshotSha256,
      snapshotBytes: receipt.snapshotBytes,
      receiptPath: managedPaths(receipt.managedRoot, receipt.snapshotId, receipt.schemaVersion).receiptPath,
      expiresAt: Date.parse(receipt.expiresAt),
      releaseReason: event === "released" ? receipt.releaseReason ?? null : null,
      createdAt: nowMs,
    });
  } finally {
    audit.close();
  }
}

function managedPaths(
  managedRoot: string,
  snapshotId: string,
  schemaVersion: 1 | 2,
): { snapshotPath: string; snapshotDir: string; receiptPath: string } {
  const root = resolve(managedRoot);
  const snapshotsRoot = join(root, "snapshots");
  const receiptsRoot = join(root, "receipts");
  const snapshotDir = resolve(snapshotsRoot, snapshotId);
  const snapshotPath = resolve(snapshotDir, schemaVersion === LEGACY_RECEIPT_SCHEMA_VERSION ? "state_5.sqlite" : "snapshot.sqlite");
  const receiptPath = resolve(receiptsRoot, `${snapshotId}.json`);
  assertInside(snapshotsRoot, snapshotDir, "snapshot directory");
  assertInside(snapshotDir, snapshotPath, "snapshot file");
  assertInside(receiptsRoot, receiptPath, "receipt");
  return { snapshotPath, snapshotDir, receiptPath };
}

function listSnapshotDirs(managedRoot: string): string[] {
  const snapshotsRoot = join(resolve(managedRoot), "snapshots");
  if (!existsSync(snapshotsRoot)) return [];
  return readdirSync(snapshotsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && validateSnapshotIdOrNull(entry.name) !== null)
    .map((entry) => resolve(snapshotsRoot, entry.name))
    .filter((path) => {
      assertInside(snapshotsRoot, path, "snapshot directory");
      return true;
    })
    .sort();
}

function listReceiptPaths(managedRoot: string): string[] {
  const receiptsRoot = join(resolve(managedRoot), "receipts");
  if (!existsSync(receiptsRoot)) return [];
  return readdirSync(receiptsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => resolve(receiptsRoot, entry.name))
    .filter((path) => {
      assertInside(receiptsRoot, path, "receipt");
      return true;
    })
    .sort();
}

function readReceipt(receiptPath: string): ManagedSqliteSnapshotReceipt {
  const parsed: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`invalid snapshot receipt: ${receiptPath}`);
  const receipt = parsed as Partial<ManagedSqliteSnapshotReceipt>;
  if (
    (receipt.schemaVersion !== LEGACY_RECEIPT_SCHEMA_VERSION && receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION)
    || typeof receipt.snapshotId !== "string"
    || (receipt.schemaVersion === RECEIPT_SCHEMA_VERSION && typeof receipt.operationId !== "string")
    || typeof receipt.managedRoot !== "string"
    || typeof receipt.sourcePath !== "string"
    || typeof receipt.owner !== "string"
    || typeof receipt.reason !== "string"
    || typeof receipt.createdAt !== "string"
    || typeof receipt.expiresAt !== "string"
    || typeof receipt.snapshotPath !== "string"
    || typeof receipt.snapshotBytes !== "number"
    || typeof receipt.snapshotSha256 !== "string"
    || receipt.integrityCheck !== "ok"
    || (receipt.status !== "active" && receipt.status !== "released")
  ) throw new Error(`invalid snapshot receipt: ${receiptPath}`);
  const schemaVersion = receipt.schemaVersion;
  const createdAtMs = Date.parse(receipt.createdAt!);
  const expiresAtMs = Date.parse(receipt.expiresAt!);
  if (
    !Number.isFinite(createdAtMs)
    || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= createdAtMs
    || expiresAtMs - createdAtMs > MAX_EXPIRY_HOURS * HOUR_MS
  ) throw new Error(`invalid snapshot receipt expiry: ${receiptPath}`);
  const paths = managedPaths(receipt.managedRoot, validateSnapshotId(receipt.snapshotId), schemaVersion);
  if (resolve(receipt.snapshotPath) !== paths.snapshotPath || resolve(receiptPath) !== paths.receiptPath) {
    throw new Error(`snapshot receipt path is outside its managed directory: ${receiptPath}`);
  }
  return {
    ...(receipt as ManagedSqliteSnapshotReceipt),
    operationId: schemaVersion === LEGACY_RECEIPT_SCHEMA_VERSION
      ? validateOperationId(receipt.operationId ?? receipt.snapshotId)
      : validateOperationId(receipt.operationId!),
  };
}

function writeReceipt(path: string, receipt: ManagedSqliteSnapshotReceipt): void {
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tempPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, path);
}

function requireRegularFile(path: string, label: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${resolved}`);
  return resolved;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function validateExpiryHours(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_EXPIRY_HOURS) {
    throw new Error(`expiryHours must be an integer from 1 to ${MAX_EXPIRY_HOURS}`);
  }
}

function validateSnapshotId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{5,120}$/u.test(value)) throw new Error("snapshotId is invalid");
  return value;
}

function validateSnapshotIdOrNull(value: string): string | null {
  try {
    return validateSnapshotId(value);
  } catch {
    return null;
  }
}

function validateOperationId(value: string): string {
  const normalized = requiredText(value, "operationId");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{5,160}$/u.test(normalized)) throw new Error("operationId is invalid");
  return normalized;
}

function safeLstat(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function defaultSnapshotId(nowMs: number): string {
  return `${new Date(nowMs).toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
}

function assertInside(parent: string, path: string, label: string): void {
  const rel = relative(resolve(parent), resolve(path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${label} must stay inside the managed root`);
}

type CliCommand =
  | { kind: "create"; owner: string; operationId: string; reason: string; expiryHours: number }
  | { kind: "finalize"; receiptPath: string; operationId: string }
  | { kind: "prune" };

function parseCliCommand(argv: string[]): CliCommand {
  const command = argv[0];
  if (command === "prune" && argv.length === 1) return { kind: "prune" };
  if (command !== "create" && command !== "finalize") {
    throw new Error("usage: codex-state-snapshot.ts create --owner <owner> --operation-id <id> --reason <reason> --expiry-hours <1-72> | finalize --receipt <path> --operation-id <id> | prune");
  }
  let owner = "";
  let operationId = "";
  let reason = "";
  let expiryHours: number | null = null;
  let receiptPath = "";
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);
    if (argument === "--owner") owner = value;
    else if (argument === "--operation-id") operationId = value;
    else if (argument === "--reason") reason = value;
    else if (argument === "--expiry-hours") expiryHours = Number(value);
    else if (argument === "--receipt") receiptPath = value;
    else throw new Error(`unknown argument: ${argument}`);
    index += 1;
  }
  if (command === "create") {
    if (expiryHours === null) throw new Error("--expiry-hours is required");
    validateExpiryHours(expiryHours);
    return {
      kind: "create",
      owner: requiredText(owner, "owner"),
      operationId: validateOperationId(operationId),
      reason: requiredText(reason, "reason"),
      expiryHours,
    };
  }
  return {
    kind: "finalize",
    receiptPath: requiredText(receiptPath, "receipt"),
    operationId: validateOperationId(operationId),
  };
}

async function main(): Promise<void> {
  const command = parseCliCommand(process.argv.slice(2));
  const runtimeRoot = resolve(process.env.SM_RUNTIME_ROOT?.trim() || DEFAULT_RUNTIME_ROOT);
  const managedRoot = join(runtimeRoot, "data", "codex-state-snapshots");
  const auditDbPath = resolve(process.env.SM_DB_PATH?.trim() || join(runtimeRoot, "data", "supermatrix.db"));
  if (command.kind === "create") {
    const result = await createManagedCodexStateSnapshot({
      sourceDbPath: DEFAULT_CODEX_STATE_DB_PATH,
      auditDbPath,
      managedRoot,
      owner: command.owner,
      operationId: command.operationId,
      reason: command.reason,
      expiryHours: command.expiryHours,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command.kind === "finalize") {
    const receiptRoot = join(managedRoot, "receipts");
    const receiptPath = resolve(command.receiptPath);
    assertInside(receiptRoot, receiptPath, "receipt");
    const receipt = await finalizeManagedCodexStateSnapshot({
      sourceDbPath: DEFAULT_CODEX_STATE_DB_PATH,
      auditDbPath,
      receiptPath,
      operationId: command.operationId,
    });
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }
  console.log(JSON.stringify(await pruneManagedCodexStateSnapshots({ auditDbPath, managedRoot }), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
