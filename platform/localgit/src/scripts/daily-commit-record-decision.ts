import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DailyCommitOwnerDecision } from "./daily-commit-owner-notify-gate.js";

const DECISION_LOG_FILE = join(process.cwd(), "data", "daily-commit-decisions.jsonl");

const VALID_DECISIONS = new Set<DailyCommitOwnerDecision>([
  "quiet_until_changed",
  "owner_will_commit",
  "owner_ignore_policy",
  "blocked",
  "localgit_retry",
  "resolved",
  "notify_again",
  "hold_merge",
  "hold_merged",
  "hold_merge_failed",
  "hold_archive",
  "hold_keep_until",
]);

export type DailyCommitDecisionLogRecord = {
  recorded_at: string;
  decision_id: string;
  dispatch_id?: string;
  repo: string;
  dirty_fingerprint: string;
  decision: DailyCommitOwnerDecision;
  actor: string;
  scope: string;
  reason: string;
  expires_at?: string;
};

export type RecordDailyCommitDecisionInput = {
  repo: string;
  decision: DailyCommitOwnerDecision;
  dirtyFingerprint?: string;
  actor?: string;
  reason?: string;
  scope?: string;
  dispatchId?: string;
  expiresAt?: string;
  // Stable-id path (e.g. dcd-<repo>-<yyyymmdd>-capacity-review): a repeat append
  // with the same decision_id is a no-op. Omit for the legacy timestamp-hash id.
  decisionId?: string;
  recordedAt?: string;
  logFile?: string;
};

function buildLegacyDecisionId(repo: string, dirtyFingerprint: string, decision: string, recordedAt: string): string {
  const hash = createHash("sha256")
    .update(repo)
    .update("\0")
    .update(dirtyFingerprint)
    .update("\0")
    .update(decision)
    .update("\0")
    .update(recordedAt)
    .digest("hex")
    .slice(0, 12);
  return `dcd-${repo}-${hash}`.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
}

export function recordDailyCommitDecision(
  input: RecordDailyCommitDecisionInput,
): { decisionId: string; record: DailyCommitDecisionLogRecord; appended: boolean } {
  const logFile = input.logFile ?? DECISION_LOG_FILE;
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const dirtyFingerprint = input.dirtyFingerprint ?? "";
  const decisionId = input.decisionId ?? buildLegacyDecisionId(input.repo, dirtyFingerprint, input.decision, recordedAt);

  // Idempotency: an existing row with the same decision_id already settles the
  // fact — re-runs must not stack duplicate audit rows.
  if (existsSync(logFile)) {
    for (const line of readFileSync(logFile, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const existing = JSON.parse(line) as DailyCommitDecisionLogRecord;
        if (existing.decision_id === decisionId) {
          return { decisionId, record: existing, appended: false };
        }
      } catch {
        // Tolerate a malformed historical row; the append-only log keeps going.
      }
    }
  }

  const record: DailyCommitDecisionLogRecord = {
    recorded_at: recordedAt,
    decision_id: decisionId,
    dispatch_id: input.dispatchId,
    repo: input.repo,
    dirty_fingerprint: dirtyFingerprint,
    decision: input.decision,
    actor: input.actor ?? process.env.SM_SESSION_NAME ?? "localgit",
    scope: input.scope ?? "fingerprint",
    reason: input.reason ?? "",
    expires_at: input.expiresAt,
  };
  appendFileSync(logFile, JSON.stringify(record) + "\n");
  return { decisionId, record, appended: true };
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function requireArg(name: string): string {
  const value = getArg(name);
  if (!value) {
    throw new Error(`missing required argument ${name}`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Usage:
  npm run daily-commit-decision -- \\
    --repo <repo> \\
    --dirty-fingerprint <fingerprint> \\
    --decision <quiet_until_changed|owner_will_commit|owner_ignore_policy|blocked|localgit_retry|resolved|notify_again> \\
    --actor <session-or-user> \\
    --reason <reason> \\
    [--dispatch-id <dispatch-id>] \\
    [--scope fingerprint|path_policy|repo_policy] \\
    [--expires-at <iso timestamp>]`);
}

function main(): void {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  try {
    const repo = requireArg("--repo");
    const dirtyFingerprint = requireArg("--dirty-fingerprint");
    const decision = requireArg("--decision") as DailyCommitOwnerDecision;
    if (!VALID_DECISIONS.has(decision)) {
      throw new Error(`invalid --decision ${decision}`);
    }

    const { decisionId, record, appended } = recordDailyCommitDecision({
      repo,
      dirtyFingerprint,
      decision,
      actor: getArg("--actor"),
      reason: getArg("--reason"),
      scope: getArg("--scope"),
      dispatchId: getArg("--dispatch-id"),
      expiresAt: getArg("--expires-at"),
    });
    console.log(JSON.stringify({ ok: true, decision_id: decisionId, appended, record }, null, 2));
  } catch (err) {
    console.error((err as Error).message);
    printHelp();
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
