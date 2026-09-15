#!/usr/bin/env tsx
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  DEFAULT_RUNTIME_ROOT,
  createManagedSqliteSnapshot,
  finalizeManagedSqliteSnapshot,
  pruneManagedSqliteSnapshots,
} from "./codex-state-snapshot.ts";

export {
  MAX_EXPIRY_HOURS,
  createManagedSqliteSnapshot,
  finalizeManagedSqliteSnapshot,
  pruneManagedSqliteSnapshots,
} from "./codex-state-snapshot.ts";
export type {
  CreateManagedSqliteSnapshotInput,
  FinalizeManagedSqliteSnapshotInput,
  ManagedSqliteSnapshotReceipt,
  PruneManagedSqliteSnapshotsInput,
  ReleaseReason,
} from "./codex-state-snapshot.ts";

type CliCommand =
  | { kind: "create"; sourceDbPath: string; owner: string; operationId: string; reason: string; expiryHours: number }
  | { kind: "finalize"; receiptPath: string; operationId: string }
  | { kind: "prune" };

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function parseCommand(argv: string[]): CliCommand {
  const kind = argv[0];
  if (kind === "prune" && argv.length === 1) return { kind };
  if (kind !== "create" && kind !== "finalize") {
    throw new Error(
      "usage: managed-sqlite-snapshot.ts create --source-db <runtime-db> --owner <owner> --operation-id <id> --reason <reason> --expiry-hours <1-72> | finalize --receipt <path> --operation-id <id> | prune",
    );
  }
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`${flag ?? "argument"} requires a value`);
    values.set(flag, value);
  }
  const operationId = required(values.get("--operation-id") ?? "", "operationId");
  if (kind === "finalize") {
    return {
      kind,
      receiptPath: required(values.get("--receipt") ?? "", "receipt"),
      operationId,
    };
  }
  const expiryHours = Number(values.get("--expiry-hours"));
  if (!Number.isInteger(expiryHours) || expiryHours < 1 || expiryHours > 72) {
    throw new Error("expiryHours must be an integer from 1 to 72");
  }
  return {
    kind,
    sourceDbPath: required(values.get("--source-db") ?? "", "sourceDb"),
    owner: required(values.get("--owner") ?? "", "owner"),
    operationId,
    reason: required(values.get("--reason") ?? "", "reason"),
    expiryHours,
  };
}

function requireRuntimeDatabase(path: string, runtimeRoot: string): string {
  const dataRoot = resolve(runtimeRoot, "data");
  const resolved = resolve(path);
  const allowed = new Set([
    resolve(dataRoot, "supermatrix.db"),
    resolve(dataRoot, "scheduler.db"),
    resolve(dataRoot, "scheduler-v2.db"),
  ]);
  if (!allowed.has(resolved)) throw new Error(`source database is not an allowed SuperMatrix runtime database: ${resolved}`);
  if (!existsSync(resolved)) throw new Error(`source database does not exist: ${resolved}`);
  return resolved;
}

function requireManagedReceipt(path: string, managedRoot: string): string {
  const receiptsRoot = resolve(managedRoot, "receipts");
  const resolved = resolve(path);
  const rel = relative(receiptsRoot, resolved);
  if (!rel || rel.startsWith("..") || rel.includes("/")) {
    throw new Error(`receipt must be a direct child of ${receiptsRoot}`);
  }
  return resolved;
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  const runtimeRoot = resolve(process.env.SM_RUNTIME_ROOT?.trim() || DEFAULT_RUNTIME_ROOT);
  const auditDbPath = resolve(process.env.SM_DB_PATH?.trim() || join(runtimeRoot, "data", "supermatrix.db"));
  const managedRoot = join(runtimeRoot, "data", "managed-sqlite-snapshots");
  if (command.kind === "create") {
    console.log(JSON.stringify(await createManagedSqliteSnapshot({
      sourceDbPath: requireRuntimeDatabase(command.sourceDbPath, runtimeRoot),
      auditDbPath,
      managedRoot,
      owner: command.owner,
      operationId: command.operationId,
      reason: command.reason,
      expiryHours: command.expiryHours,
    }), null, 2));
    return;
  }
  if (command.kind === "finalize") {
    console.log(JSON.stringify(await finalizeManagedSqliteSnapshot({
      auditDbPath,
      receiptPath: requireManagedReceipt(command.receiptPath, managedRoot),
      operationId: command.operationId,
    }), null, 2));
    return;
  }
  console.log(JSON.stringify(await pruneManagedSqliteSnapshots({ auditDbPath, managedRoot }), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
