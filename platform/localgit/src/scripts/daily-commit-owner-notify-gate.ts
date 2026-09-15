import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { forEachGitLedgerEntry } from "./git-ledger.js";

export type DailyCommitOwnerDecision =
  | "quiet_until_changed"
  | "owner_will_commit"
  | "owner_ignore_policy"
  | "blocked"
  | "localgit_retry"
  | "resolved"
  | "notify_again"
  | "hold_merge"
  | "hold_merged"
  | "hold_merge_failed"
  | "hold_archive"
  | "hold_keep_until";

export type DailyCommitDispatchRecord = {
  dispatch_id?: string;
  dispatchId?: string;
  run_id?: string;
  repo?: string;
  targetSession?: string;
  kind?: string;
  status?: string;
  dirty_fingerprint?: string;
  dirtyFingerprint?: string;
};

export type DailyCommitDecisionRecord = {
  decision_id?: string;
  repo?: string;
  dirty_fingerprint?: string;
  decision?: DailyCommitOwnerDecision;
  expires_at?: string;
};

export type GitLedgerRecord = {
  run_id?: string;
  repo?: string;
  operation?: string;
  dirty_fingerprint?: string;
};

export type OwnerNotificationHistory = {
  dispatches: DailyCommitDispatchRecord[];
  decisions: DailyCommitDecisionRecord[];
  ledger: GitLedgerRecord[];
};

export type OwnerNotificationGateDecision =
  | { kind: "notify"; dispatchId: string }
  | { kind: "suppress"; reason: string; priorDispatchId?: string; priorRunId?: string; decisionId?: string };

function safeParseJsonlFile<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8").trim();
  if (!raw) return [];
  const parsed: T[] = [];
  for (const line of raw.split("\n")) {
    try {
      parsed.push(JSON.parse(line) as T);
    } catch {
      // Ignore corrupt historical lines; daily-commit should keep running.
    }
  }
  return parsed;
}

export function loadOwnerNotificationHistory(paths: {
  dispatchLogFile: string;
  decisionLogFile: string;
  gitLedgerFile: string;
}): OwnerNotificationHistory {
  return {
    // appendDispatchLog historically wrote camelCase while the decision/ledger
    // writers use snake_case. Normalize both on read so a real owner delegation
    // cannot be re-issued just because the audit serializer changed conventions.
    dispatches: safeParseJsonlFile<DailyCommitDispatchRecord>(paths.dispatchLogFile).map((record) => ({
      ...record,
      dispatch_id: record.dispatch_id ?? record.dispatchId,
      dirty_fingerprint: record.dirty_fingerprint ?? record.dirtyFingerprint,
    })),
    decisions: safeParseJsonlFile<DailyCommitDecisionRecord>(paths.decisionLogFile),
    // Fingerprint dedup needs full history (a prior skip may live in a rotated
    // shard), but only these four fields — streamed into a compact index instead
    // of materializing every heavy entry (per_file_dispositions megabytes).
    ledger: (() => {
      const records: GitLedgerRecord[] = [];
      forEachGitLedgerEntry(paths.gitLedgerFile, (entry) => {
        records.push({
          run_id: entry.run_id,
          repo: entry.repo,
          operation: entry.operation,
          dirty_fingerprint: entry.dirty_fingerprint,
        });
      });
      return records;
    })(),
  };
}

export function buildDailyCommitDispatchId(input: {
  date: string;
  repo: string;
  dirtyFingerprint?: string;
  skippedReason?: string;
}): string {
  const hash = createHash("sha256")
    .update(input.repo)
    .update("\0")
    .update(input.dirtyFingerprint ?? "")
    .update("\0")
    .update(input.skippedReason ?? "")
    .digest("hex")
    .slice(0, 12);
  return `dc-${input.date}-${input.repo}-${hash}`.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
}

function isUnexpired(expiresAt: string | undefined, nowIso: string): boolean {
  if (!expiresAt) return true;
  const expires = Date.parse(expiresAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(expires) || !Number.isFinite(now)) return true;
  return expires > now;
}

function dispatchFingerprint(record: DailyCommitDispatchRecord): string | undefined {
  return record.dirty_fingerprint ?? record.dirtyFingerprint;
}

function dispatchRecordId(record: DailyCommitDispatchRecord): string | undefined {
  return record.dispatch_id ?? record.dispatchId;
}

export function shouldNotifyOwner(input: {
  date: string;
  repo: string;
  dirtyFingerprint?: string;
  skippedReason?: string;
  currentRunId: string;
  nowIso?: string;
  history: OwnerNotificationHistory;
}): OwnerNotificationGateDecision {
  const dispatchId = buildDailyCommitDispatchId({
    date: input.date,
    repo: input.repo,
    dirtyFingerprint: input.dirtyFingerprint,
    skippedReason: input.skippedReason,
  });
  const fingerprint = input.dirtyFingerprint;
  if (!fingerprint) return { kind: "notify", dispatchId };

  const nowIso = input.nowIso ?? new Date().toISOString();
  const matchingDecisions = input.history.decisions
    .filter((record) => record.repo === input.repo && record.dirty_fingerprint === fingerprint)
    .filter((record) => isUnexpired(record.expires_at, nowIso));
  const latestDecision = matchingDecisions.at(-1);
  if (latestDecision?.decision && latestDecision.decision !== "notify_again") {
    return {
      kind: "suppress",
      reason: `owner decision already recorded: ${latestDecision.decision}`,
      decisionId: latestDecision.decision_id,
    };
  }
  if (latestDecision?.decision === "notify_again") {
    return { kind: "notify", dispatchId };
  }

  const priorDispatch = input.history.dispatches.find(
    (record) =>
      record.kind === "owner_delegation" &&
      record.status === "sent" &&
      (record.repo === input.repo || record.targetSession === input.repo) &&
      dispatchFingerprint(record) === fingerprint,
  );
  if (priorDispatch) {
    return {
      kind: "suppress",
      reason: "owner delegation already dispatched for the same dirty fingerprint",
      priorDispatchId: dispatchRecordId(priorDispatch),
    };
  }

  const priorLedger = input.history.ledger.find(
    (record) =>
      record.repo === input.repo &&
      record.dirty_fingerprint === fingerprint &&
      record.run_id !== input.currentRunId &&
      record.operation === "skip",
  );
  if (priorLedger) {
    return {
      kind: "suppress",
      reason: "same dirty fingerprint already recorded by an earlier daily-commit run",
      priorRunId: priorLedger.run_id,
    };
  }

  return { kind: "notify", dispatchId };
}
