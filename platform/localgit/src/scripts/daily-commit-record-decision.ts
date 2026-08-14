import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
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

  const actor = getArg("--actor") ?? process.env.SM_SESSION_NAME ?? "localgit";
  const reason = getArg("--reason") ?? "";
  const scope = getArg("--scope") ?? "fingerprint";
  const dispatchId = getArg("--dispatch-id");
  const expiresAt = getArg("--expires-at");
  const recordedAt = new Date().toISOString();
  const decisionIdHash = createHash("sha256")
    .update(repo)
    .update("\0")
    .update(dirtyFingerprint)
    .update("\0")
    .update(decision)
    .update("\0")
    .update(recordedAt)
    .digest("hex")
    .slice(0, 12);
  const decisionId = `dcd-${repo}-${decisionIdHash}`.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
  const record = {
    recorded_at: recordedAt,
    decision_id: decisionId,
    dispatch_id: dispatchId,
    repo,
    dirty_fingerprint: dirtyFingerprint,
    decision,
    actor,
    scope,
    reason,
    expires_at: expiresAt,
  };

  appendFileSync(DECISION_LOG_FILE, JSON.stringify(record) + "\n");
  console.log(JSON.stringify({ ok: true, decision_id: decisionId, record }, null, 2));
} catch (err) {
  console.error((err as Error).message);
  printHelp();
  process.exit(1);
}
