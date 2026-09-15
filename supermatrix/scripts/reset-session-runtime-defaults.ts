#!/usr/bin/env tsx
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SqliteBindingStore } from "../src/adapters/store-sqlite/index.ts";
import {
  resetSessionRuntimeDefaults,
  syncChangedSessionRuntimeDefaults,
} from "../src/app/resetSessionRuntimeDefaults.ts";
import type {
  ChangedRuntimeDefaultsSyncSummary,
  RuntimeDefaultsResetSummary,
} from "../src/app/resetSessionRuntimeDefaults.ts";
import { syncSessionTableToLark } from "../src/app/sessionLifecycle.ts";
import { asTimestamp } from "../src/domain/ids.ts";

type Options = {
  apply: boolean;
  changedOnly: boolean;
  retryBusy: boolean;
  runId: string | null;
  dbPath: string;
  receiptDir: string;
};

export function parseRuntimeDefaultsResetArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): Options {
  const runtimeRoot = env.SM_RUNTIME_ROOT?.trim() || "/Users/LOCAL_USER/SuperMatrixRuntime";
  let apply = false;
  let changedOnly = false;
  let retryBusy = false;
  let runId: string | null = env.SM_SCHEDULER_RUN_ID?.trim()
    || env.SCHEDULER_RUN_ID?.trim()
    || null;
  let dbPath = env.SM_DB_PATH?.trim() || join(runtimeRoot, "data", "supermatrix.db");
  let receiptDir = env.SM_RUNTIME_DEFAULT_RESET_RECEIPT_DIR?.trim()
    || join(runtimeRoot, "data", "runtime-default-reset");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--changed-only") changedOnly = true;
    else if (arg === "--retry-busy") retryBusy = true;
    else if (arg === "--run-id") {
      const value = argv[++i]?.trim();
      if (!value) throw new Error("--run-id requires a value");
      runId = value;
    } else if (arg === "--db") {
      const value = argv[++i];
      if (!value) throw new Error("--db requires a path");
      dbPath = resolve(value);
    } else if (arg === "--receipt-dir") {
      const value = argv[++i];
      if (!value) throw new Error("--receipt-dir requires a path");
      receiptDir = resolve(value);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (changedOnly && !apply) throw new Error("--changed-only requires --apply");
  if (retryBusy && !apply) throw new Error("--retry-busy requires --apply");
  return { apply, changedOnly, retryBusy, runId, dbPath, receiptDir };
}

export function classifyRuntimeDefaultsResetReceipt(
  summary: {
    busySkipped: readonly string[];
    invalidDefaults?: readonly unknown[];
  },
  retryBusy: boolean,
): { ok: true } | {
  ok: false;
  retryable: boolean;
  reason: "invalid_runtime_defaults" | "readiness_targets_not_ready";
} {
  if ((summary.invalidDefaults?.length ?? 0) > 0) {
    return {
      ok: false,
      retryable: false,
      reason: "invalid_runtime_defaults",
    };
  }
  if (retryBusy && summary.busySkipped.length > 0) {
    return {
      ok: false,
      retryable: true,
      reason: "readiness_targets_not_ready",
    };
  }
  return { ok: true };
}

export function runtimeDefaultsResetExitCode(
  classification: ReturnType<typeof classifyRuntimeDefaultsResetReceipt>,
): 0 | 1 | 75 {
  if (classification.ok) return 0;
  return classification.retryable ? 75 : 1;
}

function runtimeDefaultsResetSummaryText(
  summary: RuntimeDefaultsResetSummary | ChangedRuntimeDefaultsSyncSummary,
  changedOnly: boolean,
): string {
  if (changedOnly && "changedMainDefaultSessions" in summary) {
    return `Bitable runtime settings synchronized: changed_main=${summary.changedMainDefaultSessions.length}, child_changed=${summary.childDefaultsChanged}, updated=${summary.updatedSessions}, busy=${summary.busySkipped.length}, invalid=${summary.invalidDefaults.length}`;
  }
  return `Runtime defaults reset: updated=${summary.updatedSessions}, busy=${summary.busySkipped.length}, invalid=${summary.invalidDefaults.length}`;
}

async function main(): Promise<void> {
  const options = parseRuntimeDefaultsResetArgs(process.argv.slice(2), process.env);
  const startedAt = Date.now();
  const runId = options.runId ?? `manual_${randomUUID()}`;
  const store = new SqliteBindingStore(options.dbPath);
  let storeClosed = false;
  let receipt: Record<string, unknown>;
  try {
    await store.init();
    let summary: RuntimeDefaultsResetSummary | ChangedRuntimeDefaultsSyncSummary;
    let currentValuesPushedAfterReset: boolean;
    if (options.changedOnly) {
      const changedSummary = await syncChangedSessionRuntimeDefaults({
        store,
        now: asTimestamp(Date.now()),
        pull: async () => syncSessionTableToLark("runtime-settings-pull", 180_000),
        pushCurrent: async () => syncSessionTableToLark("runtime-settings-push-current", 180_000),
      });
      summary = changedSummary;
      currentValuesPushedAfterReset = changedSummary.currentValuesPushedAfterReset;
    } else {
      if (options.apply) {
        await syncSessionTableToLark("runtime-settings-normalize-main-defaults", 180_000);
        await syncSessionTableToLark("runtime-settings-pull", 180_000);
      }
      summary = await resetSessionRuntimeDefaults({
        store,
        now: asTimestamp(Date.now()),
        dryRun: !options.apply,
      });
      if (options.apply) {
        await store.close();
        storeClosed = true;
        await syncSessionTableToLark("runtime-settings-push-current", 180_000);
      }
      currentValuesPushedAfterReset = options.apply;
    }
    if (!storeClosed) {
      await store.close();
      storeClosed = true;
    }
    const classification = classifyRuntimeDefaultsResetReceipt(summary, options.retryBusy);
    receipt = {
      runId,
      startedAt,
      finishedAt: Date.now(),
      dbPath: options.dbPath,
      summary: runtimeDefaultsResetSummaryText(summary, options.changedOnly),
      defaultsNormalizedBeforeReset: options.apply && !options.changedOnly,
      settingsPulledBeforeReset: options.apply,
      ...summary,
      currentValuesPushedAfterReset,
      ...classification,
    };
    process.exitCode = runtimeDefaultsResetExitCode(classification);
  } catch (err) {
    receipt = {
      ok: false,
      runId,
      startedAt,
      finishedAt: Date.now(),
      dbPath: options.dbPath,
      outcome: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
    process.exitCode = 1;
  } finally {
    if (!storeClosed) await store.close().catch(() => undefined);
  }
  mkdirSync(options.receiptDir, { recursive: true });
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/gu, "-");
  const safeRunId = runId.replace(/[^A-Za-z0-9._:-]/gu, "_");
  const receiptPath = join(options.receiptDir, `${stamp}-${safeRunId}.json`);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ receiptPath, ...receipt })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
