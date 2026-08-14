import Database from "better-sqlite3";
import pino from "pino";
import { loadConfig } from "./config.js";
import { applyMigrations } from "./db/schema.js";
import { createIssueStore } from "./db/issueStore.js";
import { createNotifier } from "./notify/feishu.js";
import { createBitableSync } from "./sync/bitable.js";
import { syncWeeklyReviewClosureStatuses } from "./scripts/weekly-review-closure.js";

const config = loadConfig(process.env as Record<string, string>);
const db = new Database(config.dbPath);
applyMigrations(db);
const store = createIssueStore(db);
const notifier = createNotifier({
  enabled: config.notifyEnabled,
});
const logger = pino({ level: config.logLevel }, pino.destination(2));
const bitable = createBitableSync({
  larkCliPath: config.larkCliPath,
  db,
  baseToken: config.bitableBaseToken,
  tableId: config.bitableTableId,
});

const command = process.argv[2];

function output(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function parseFlags(start: number) {
  const raw = process.argv.slice(start);
  const flags: Record<string, string> = {};
  let i = 0;
  while (i < raw.length) {
    const key = raw[i].replace(/^--/, "");
    const next = raw[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = "";
      i += 1;
    } else {
      flags[key] = next;
      i += 2;
    }
  }
  return flags;
}

function requiredEvidenceFromFlags(
  flags: Record<string, string>,
  requireExplicit: boolean,
): {
  requiredOwner: string | null;
  requiredCompletionMarker: string | null;
  requiredEvidenceState: "canonical" | "unclassified" | null;
} {
  const owner = flags["required-owner"]?.trim() || null;
  const completionMarker = flags["required-completion-marker"]?.trim() || null;
  const unclassified = "unclassified" in flags;
  if (unclassified) {
    if (owner || completionMarker) {
      throw new Error("--unclassified cannot be combined with canonical owner or marker");
    }
    return {
      requiredOwner: null,
      requiredCompletionMarker: null,
      requiredEvidenceState: "unclassified",
    };
  }
  if (owner || completionMarker) {
    if (!owner || !completionMarker) {
      throw new Error("--required-owner and --required-completion-marker must be provided together");
    }
    return {
      requiredOwner: owner,
      requiredCompletionMarker: completionMarker,
      requiredEvidenceState: "canonical",
    };
  }
  if (requireExplicit) {
    throw new Error(
      "weekly-review issues require --required-owner with --required-completion-marker, or --unclassified",
    );
  }
  return {
    requiredOwner: null,
    requiredCompletionMarker: null,
    requiredEvidenceState: null,
  };
}

function weeklyReviewDate(issue: ReturnType<typeof store.getIssue>): string {
  const explicitDate = `${issue.title}\n${issue.description}`.match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0];
  if (explicitDate) return explicitDate;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(issue.createdAt));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function syncWeeklyReviewClosureIfNeeded(issue: ReturnType<typeof store.getIssue>): void {
  if (issue.source !== "weekly-review-watchdog") return;
  syncWeeklyReviewClosureStatuses(db, {
    onlyDate: weeklyReviewDate(issue),
    createReceipts: true,
  });
}

switch (command) {
  case "add": {
    const flags = parseFlags(3);
    const requiredEvidence = requiredEvidenceFromFlags(
      flags,
      flags.source === "weekly-review-watchdog",
    );
    const issue = store.createIssue({
      title: flags.title,
      source: flags.source,
      description: flags.description,
      verification: flags.verification ?? null,
      ...requiredEvidence,
    });
    logger.info({ issueId: issue.id, title: issue.title }, "issue created");
    output(issue);
    await bitable.syncIssue(issue);
    break;
  }

  case "get": {
    const id = process.argv[3];
    output(store.getIssue(id));
    break;
  }

  case "list": {
    const subarg = process.argv[3];
    const days = process.argv[4];
    let issues;
    if (subarg === "recent") {
      issues = store.listRecent(days ? parseInt(days, 10) : 7);
    } else if (subarg) {
      issues = store.listByStatus(subarg as "open" | "in_progress" | "done" | "failed");
    } else {
      issues = store.listAll();
    }
    output(issues);
    break;
  }

  case "next": {
    const issue = store.nextOpen();
    if (!issue) {
      console.log("No open issues.");
    } else {
      output(issue);
    }
    break;
  }

  case "start": {
    const id = process.argv[3];
    const startedIssue = store.updateStatus(id, "in_progress");
    syncWeeklyReviewClosureIfNeeded(startedIssue);
    output(startedIssue);
    await bitable.syncIssue(startedIssue);
    break;
  }

  case "pending": {
    const id = process.argv[3];
    const pendingIssue = store.updateStatus(id, "pending");
    syncWeeklyReviewClosureIfNeeded(pendingIssue);
    logger.info({ issueId: pendingIssue.id, title: pendingIssue.title }, "issue pending");
    output(pendingIssue);
    await bitable.syncIssue(pendingIssue);
    break;
  }

  case "done": {
    const id = process.argv[3];
    const flags = parseFlags(4);
    const issue = store.markDone(id, flags.result ?? "");
    syncWeeklyReviewClosureIfNeeded(issue);
    logger.info({ issueId: issue.id, title: issue.title }, "issue completed");
    output(issue);
    if (!("no-notify" in flags)) {
      await notifier.notifyDone(issue.title, flags.result ?? "").catch(() => {});
    }
    await bitable.syncIssue(issue);
    break;
  }

  case "failed": {
    const id = process.argv[3];
    const flags = parseFlags(4);
    const failedIssue = store.markFailed(id, flags.result ?? "");
    syncWeeklyReviewClosureIfNeeded(failedIssue);
    logger.info({ issueId: failedIssue.id, title: failedIssue.title }, "issue failed");
    output(failedIssue);
    await bitable.syncIssue(failedIssue);
    break;
  }

  case "verify": {
    const id = process.argv[3];
    const issue = store.getIssue(id);
    if (!issue.verification) {
      output({ success: false, issueId: id, error: "No verification command set for this issue" });
      process.exitCode = 1;
      break;
    }
    try {
      const { execFileSync } = await import("node:child_process");
      const stdout = execFileSync("/bin/sh", ["-c", issue.verification], {
        cwd: process.cwd(),
        encoding: "utf-8",
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
      logger.info({ issueId: id, success: true }, "verification passed");
      output({ success: true, issueId: id, output: stdout.trim() });
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      const stdout = (err as { stdout?: string }).stdout ?? "";
      const updated = store.incrementRetry(id);
      logger.info({ issueId: id, success: false, retryCount: updated.retryCount }, "verification failed");
      output({ success: false, issueId: id, output: stdout, error, retryCount: updated.retryCount });
      await bitable.syncIssue(updated);
      process.exitCode = 1;
    }
    break;
  }

  case "set-verification": {
    const id = process.argv[3];
    const flags = parseFlags(4);
    const verifiedIssue = store.setVerification(id, flags.verification);
    syncWeeklyReviewClosureIfNeeded(verifiedIssue);
    output(verifiedIssue);
    await bitable.syncIssue(verifiedIssue);
    break;
  }

  case "set-required-evidence": {
    const id = process.argv[3];
    const flags = parseFlags(4);
    const requiredEvidence = requiredEvidenceFromFlags(flags, true);
    const updatedIssue =
      requiredEvidence.requiredEvidenceState === "canonical"
        ? store.setRequiredEvidence(id, {
            state: "canonical",
            owner: requiredEvidence.requiredOwner as string,
            completionMarker: requiredEvidence.requiredCompletionMarker as string,
          })
        : store.setRequiredEvidence(id, { state: "unclassified" });
    syncWeeklyReviewClosureIfNeeded(updatedIssue);
    output(updatedIssue);
    await bitable.syncIssue(updatedIssue);
    break;
  }

  default: {
    console.log(`Usage: watchdog <command>

Commands:
  add --title <t> --source <s> --description <d> [--verification <v>] [--required-owner <o> --required-completion-marker <m> | --unclassified]
  get <id>
  list [status|recent [days]]
  next
  start <id>
  pending <id>
  done <id> --result <r>
  failed <id> --result <r>
  verify <id>
  set-verification <id> --verification <v>
  set-required-evidence <id> (--required-owner <o> --required-completion-marker <m> | --unclassified)
`);
  }
}

db.close();
