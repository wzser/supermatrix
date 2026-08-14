import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "../config.js";
import { applyMigrations } from "../db/schema.js";
import { createIssueStore, type Issue } from "../db/issueStore.js";
import { createNotifyClient, type NotifyClient, type NotifyRequest } from "../notify/console.js";

const STANDING_SWEEP_SPAWN_API = "http://localhost:3501/api/spawn2.0";

export type WeeklyReviewClosureInput = {
  issue: Pick<Issue, "id" | "status" | "source"> | null;
  receiptsText: string;
  requiredEvidence: string[];
  receiptsPath?: string;
  now?: Date;
};

export type WeeklyReviewClosureResult = {
  purpose_met: "met" | "not_met";
  purposeMet: "met" | "not_met";
  issueId?: string;
  missing: string[];
  evidence: string[];
};

export type WeeklyReviewStandingSweepOptions = {
  reportsRoot?: string;
  now?: Date;
  orphanSlaHours?: number;
};

export type WeeklyReviewOwnerRetryRequest = {
  target: string;
  from: "watchdog";
  prompt: string;
  client_request_id: string;
  closure: {
    kind: "message";
    target: { type: "todo_pool" };
  };
};

export type WeeklyReviewOwnerRetryDispatch = {
  status: "accepted" | "already_registered" | "failed";
  childSessionId?: string;
  ref?: string;
  error?: string;
};

export type WeeklyReviewStandingOwnerRetry = WeeklyReviewOwnerRetryDispatch & {
  issueId: string;
  owner: string;
  clientRequestId: string;
  retryRecorded: boolean;
};

export type WeeklyReviewStandingNotification = {
  status: "sent" | "failed" | "skipped";
  attempts: number;
  messageId?: string;
  error?: string;
};

export type WeeklyReviewStandingSweepEscalationOptions = WeeklyReviewStandingSweepOptions & {
  /** `null` explicitly disables the notification channel for a local dry run. */
  notifier?: Pick<NotifyClient, "notify"> | null;
  redispatch?: (request: WeeklyReviewOwnerRetryRequest) => Promise<WeeklyReviewOwnerRetryDispatch>;
  escalate?: boolean;
};

export type WeeklyReviewStandingSweepEscalationResult = {
  result: WeeklyReviewStandingSweepResult;
  notification?: WeeklyReviewStandingNotification;
  ownerRetries: WeeklyReviewStandingOwnerRetry[];
};

const VERIFIED_MARKER_PATTERN = /\brg\s+-q\s+(['"])([^'"]+:\s*verified)\1/g;

function verifiedMarkerPattern(marker: string): RegExp {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`^\\s*(?:[-*]\\s*)?${escapedMarker}\\s*(?:$|[.;])`, "im");
}

function waiverMarkerPattern(marker: string): RegExp | null {
  const owner = marker.match(/^(.+?)\s+completion:\s+verified$/)?.[1]?.trim();
  if (!owner) return null;
  const escapedOwner = owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`^\\s*(?:[-*]\\s*)?${escapedOwner}\\s+waive-with-expiry:\\s*(\\d{4}-\\d{2}-\\d{2})\\s*(?:$|[.;])`, "im");
}

function waiverEvidence(marker: string, receiptsText: string, now: Date): string | null {
  const pattern = waiverMarkerPattern(marker);
  if (!pattern) return null;
  const match = receiptsText.match(pattern);
  if (!match) return null;
  const expiry = match[1];
  const expiryTime = Date.parse(`${expiry}T23:59:59.999Z`);
  if (!Number.isFinite(expiryTime) || expiryTime < now.getTime()) return null;
  const owner = marker.match(/^(.+?)\s+completion:\s+verified$/)?.[1]?.trim();
  return owner ? `${owner} waive-with-expiry: ${expiry}` : null;
}

export function extractRequiredEvidenceFromVerification(verification: string | null | undefined): string[] {
  if (!verification) return [];
  const markers: string[] = [];
  for (const match of verification.matchAll(VERIFIED_MARKER_PATTERN)) {
    markers.push(match[2].replace(/\s+/g, " ").trim());
  }
  return Array.from(new Set(markers));
}

export function assessWeeklyReviewClosure(input: WeeklyReviewClosureInput): WeeklyReviewClosureResult {
  const missing: string[] = [];
  const evidence: string[] = [];
  const now = input.now ?? new Date();

  if (!input.issue) {
    missing.push("weekly-review issue is missing from watchdog issue DB");
  } else {
    evidence.push(`issue:${input.issue.id}`);
    if (input.issue.source !== "weekly-review-watchdog") {
      missing.push(`issue source is ${input.issue.source}, expected weekly-review-watchdog`);
    }
    if (input.issue.status !== "done") {
      missing.push(`issue status is ${input.issue.status}, expected done`);
    } else {
      evidence.push("issue status: done");
    }
  }

  if (!input.receiptsText.trim()) {
    missing.push(input.receiptsPath ? `receipts file is missing or empty: ${input.receiptsPath}` : "receipts text is empty");
  }

  if (input.requiredEvidence.length === 0) {
    missing.push("no required completion evidence markers were provided");
  }

  for (const marker of input.requiredEvidence) {
    if (verifiedMarkerPattern(marker).test(input.receiptsText)) {
      evidence.push(marker);
    } else if (waiverEvidence(marker, input.receiptsText, now)) {
      evidence.push(waiverEvidence(marker, input.receiptsText, now) as string);
    } else {
      missing.push(marker);
    }
  }

  const purposeMet = missing.length === 0 ? "met" : "not_met";
  return {
    purpose_met: purposeMet,
    purposeMet,
    issueId: input.issue?.id,
    missing,
    evidence,
  };
}

export function renderWeeklyReviewClosureStatus(result: WeeklyReviewClosureResult, generatedAt = new Date()): string {
  const lines = [
    "# Weekly Review Follow-Up Closure Status",
    "",
    `Generated: ${generatedAt.toISOString()}`,
    `Purpose met: ${result.purpose_met}`,
    result.issueId ? `Issue: ${result.issueId}` : "Issue: missing",
    "",
    "## Missing",
    "",
  ];
  if (result.missing.length === 0) {
    lines.push("- none");
  } else {
    for (const item of result.missing) lines.push(`- ${item}`);
  }
  lines.push("", "## Evidence", "");
  if (result.evidence.length === 0) {
    lines.push("- none");
  } else {
    for (const item of result.evidence) lines.push(`- ${item}`);
  }
  lines.push(
    "",
    "## Closure Rule",
    "",
    "- Verifier PASS, report freshness, dispatch receipts, and async refs are not closure evidence.",
    "- Closure requires watchdog issue status `done` plus every required owner receipt marker, or a dated `waive-with-expiry` receipt that has not expired.",
  );
  return `${lines.join("\n")}\n`;
}

function formatReviewDate(createdAt: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(createdAt));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export type WeeklyReviewEvidenceClassification = {
  state: "canonical" | "legacy_inferred" | "unclassified";
  requiredOwners: string[];
  requiredCompletionMarkers: string[];
};

function ownerFromCompletionMarker(marker: string): string | null {
  const owner = marker.match(/^(.+?)\s+completion:\s+verified$/i)?.[1]?.trim();
  return owner || null;
}

function classifyRequiredEvidence(
  issue: Pick<
    Issue,
    | "id"
    | "title"
    | "description"
    | "verification"
    | "requiredOwner"
    | "requiredCompletionMarker"
    | "requiredEvidenceState"
  >,
): WeeklyReviewEvidenceClassification {
  if (issue.requiredEvidenceState === "canonical") {
    if (issue.requiredOwner && issue.requiredCompletionMarker) {
      return {
        state: "canonical",
        requiredOwners: [issue.requiredOwner],
        requiredCompletionMarkers: [issue.requiredCompletionMarker],
      };
    }
    return {
      state: "unclassified",
      requiredOwners: [],
      requiredCompletionMarkers: [],
    };
  }
  if (issue.requiredEvidenceState === "unclassified") {
    return {
      state: "unclassified",
      requiredOwners: [],
      requiredCompletionMarkers: [],
    };
  }

  const fromVerification = extractRequiredEvidenceFromVerification(issue.verification);
  if (fromVerification.length > 0) {
    const requiredOwners = Array.from(new Set(
      fromVerification
        .map(ownerFromCompletionMarker)
        .filter((owner): owner is string => Boolean(owner)),
    ));
    return {
      state: requiredOwners.length > 0 ? "legacy_inferred" : "unclassified",
      requiredOwners,
      requiredCompletionMarkers: fromVerification,
    };
  }

  const text = `${issue.title}\n${issue.description}`.toLowerCase();
  const owners: string[] = [];
  if (text.includes("after-sales")) owners.push("after-sales");
  if (text.includes("wendangwang")) owners.push("wendangwang");
  if (text.includes("budiansha")) owners.push("budiansha");
  if (text.includes("autobitable")) owners.push("autobitable");
  if (text.includes("codexroot")) owners.push("codexroot");
  if (text.includes("supermatrix") || text.includes("spawn/reload") || text.includes("/reload")) {
    owners.push("supermatrix-root");
  }
  const requiredOwners = Array.from(new Set(owners));
  return {
    state: requiredOwners.length > 0 ? "legacy_inferred" : "unclassified",
    requiredOwners,
    requiredCompletionMarkers: requiredOwners.map((owner) => `${owner} completion: verified`),
  };
}

function inferRequiredEvidence(
  issue: Pick<
    Issue,
    | "id"
    | "title"
    | "description"
    | "verification"
    | "requiredOwner"
    | "requiredCompletionMarker"
    | "requiredEvidenceState"
  >,
): string[] {
  return classifyRequiredEvidence(issue).requiredCompletionMarkers;
}

function renderMissingReceiptsTemplate(date: string, issues: Issue[]): string {
  const lines = [
    "# Weekly Review Follow-Up Receipts",
    "",
    `Date: ${date}`,
    "Status: backfilled by weekly-review closure sync; pending owner verified receipt or explicit waive-with-expiry.",
    "",
  ];

  for (const issue of issues) {
    lines.push(`## Issue ${issue.id}: ${issue.title}`, "", `- DB status: ${issue.status}`);
    const required = inferRequiredEvidence(issue);
    if (required.length === 0) {
      lines.push("- Required terminal receipt: unresolved; add owner completion or waiver marker after owner classification.");
    } else {
      lines.push("- Required terminal receipts:");
      for (const marker of required) {
        const owner = marker.replace(/\s+completion:\s+verified$/, "");
        lines.push(`  - \`${marker}\` or \`${owner} waive-with-expiry: YYYY-MM-DD\``);
      }
    }
    lines.push("");
  }

  lines.push(
    "## Closure Rule",
    "",
    "Verifier PASS, report freshness, dispatch receipts, and async refs are not closure evidence.",
    "Use standalone receipt lines only after owner verification or an explicit waiver with expiry.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function renderAggregateClosureStatus(
  items: Array<{ issue: Issue; result: WeeklyReviewClosureResult }>,
  generatedAt = new Date(),
): string {
  const purposeMet = items.every((item) => item.result.purpose_met === "met") ? "met" : "not_met";
  const lines = [
    "# Weekly Review Follow-Up Closure Status",
    "",
    `Generated: ${generatedAt.toISOString()}`,
    `Purpose met: ${purposeMet}`,
    "",
  ];

  for (const item of items) {
    lines.push(`## Issue ${item.issue.id}`, "", `Title: ${item.issue.title}`, `DB status: ${item.issue.status}`, `Purpose met: ${item.result.purpose_met}`, "", "### Missing", "");
    if (item.result.missing.length === 0) {
      lines.push("- none");
    } else {
      for (const missing of item.result.missing) lines.push(`- ${missing}`);
    }
    lines.push("", "### Evidence", "");
    if (item.result.evidence.length === 0) {
      lines.push("- none");
    } else {
      for (const evidence of item.result.evidence) lines.push(`- ${evidence}`);
    }
    lines.push("");
  }

  lines.push(
    "## Closure Rule",
    "",
    "- Verifier PASS, report freshness, dispatch receipts, and async refs are not closure evidence.",
    "- Closure requires watchdog issue status `done` plus every required owner receipt marker, or a dated `waive-with-expiry` receipt that has not expired.",
  );
  return `${lines.join("\n")}\n`;
}

function readWeeklyReviewIssues(db: Database.Database, statuses?: Issue["status"][]): Issue[] {
  const rows = db
    .prepare("SELECT * FROM issues WHERE source = 'weekly-review-watchdog' ORDER BY created_at ASC")
    .all() as Record<string, unknown>[];
  return rows
    .map((row) => ({
      id: row.id as string,
      title: row.title as string,
      source: row.source as string,
      description: row.description as string,
      verification: (row.verification as string) ?? null,
      status: row.status as Issue["status"],
      createdAt: row.created_at as number,
      finishedAt: (row.finished_at as number) ?? null,
      result: (row.result as string) ?? null,
      retryCount: (row.retry_count as number) ?? 0,
      requiredOwner: (row.required_owner as string) ?? null,
      requiredCompletionMarker: (row.required_completion_marker as string) ?? null,
      requiredEvidenceState: (row.required_evidence_state as Issue["requiredEvidenceState"]) ?? null,
    }))
    .filter((issue) => !statuses || statuses.includes(issue.status));
}

export type WeeklyReviewClosureSyncResult = {
  date: string;
  receiptsPath: string;
  statusPath: string;
  issueIds: string[];
  purposeMet: "met" | "not_met";
};

export type WeeklyReviewStandingIssue = {
  id: string;
  date: string;
  title: string;
  status: Issue["status"];
  ageHours: number;
  slaBreached: boolean;
  retryCount: number;
  evidenceClassification: WeeklyReviewEvidenceClassification["state"];
  requiredOwners: string[];
  requiredCompletionMarkers: string[];
  missingOwners: string[];
};

export type WeeklyReviewStandingVerifier = {
  date: string;
  verdict: "PASS" | "FAIL" | "UNKNOWN";
  verifierPath: string;
  ageHours: number;
  trackedIssueIds: string[];
  slaBreached: boolean;
};

export type WeeklyReviewStandingSweepResult = {
  generatedAt: string;
  orphanSlaHours: number;
  openIssues: WeeklyReviewStandingIssue[];
  strandedIssues: WeeklyReviewStandingIssue[];
  latestVerifiers: WeeklyReviewStandingVerifier[];
  packageFailures: WeeklyReviewStandingVerifier[];
  orphanedPackageFailures: WeeklyReviewStandingVerifier[];
  attentionRequired: boolean;
};

function standingEvidenceForIssue(
  issue: Issue,
  reportsRoot: string,
  now: Date,
): Pick<
  WeeklyReviewStandingIssue,
  "evidenceClassification" | "requiredOwners" | "requiredCompletionMarkers" | "missingOwners"
> {
  const classification = classifyRequiredEvidence(issue);
  const requiredEvidence = classification.requiredCompletionMarkers;
  if (classification.state === "unclassified" || requiredEvidence.length === 0) {
    return {
      evidenceClassification: "unclassified",
      requiredOwners: classification.requiredOwners,
      requiredCompletionMarkers: requiredEvidence,
      missingOwners: [],
    };
  }
  const date = issueReviewDate(issue);
  const receiptsPath = join(reportsRoot, date, "follow-up-receipts.md");
  const receiptsText = existsSync(receiptsPath) ? readFileSync(receiptsPath, "utf-8") : "";
  const closure = assessWeeklyReviewClosure({
    issue,
    receiptsText,
    receiptsPath,
    requiredEvidence,
    now,
  });
  const missingMarkers = requiredEvidence.filter((marker) => closure.missing.includes(marker));
  const missingOwners =
    classification.state === "canonical"
      ? missingMarkers.length > 0
        ? classification.requiredOwners
        : []
      : Array.from(new Set(
          missingMarkers
            .map(ownerFromCompletionMarker)
            .filter((owner): owner is string => Boolean(owner)),
        ));
  return {
    evidenceClassification: classification.state,
    requiredOwners: classification.requiredOwners,
    requiredCompletionMarkers: requiredEvidence,
    missingOwners,
  };
}

export function syncWeeklyReviewClosureStatuses(
  db: Database.Database,
  options: { reportsRoot?: string; statuses?: Issue["status"][]; createReceipts?: boolean; onlyDate?: string } = {},
): WeeklyReviewClosureSyncResult[] {
  const reportsRoot = options.reportsRoot ?? "reports/weekly-review";
  const byDate = new Map<string, Issue[]>();
  for (const issue of readWeeklyReviewIssues(db, options.statuses)) {
    const date = issueReviewDate(issue);
    if (options.onlyDate && date !== options.onlyDate) continue;
    const issues = byDate.get(date) ?? [];
    issues.push(issue);
    byDate.set(date, issues);
  }

  const synced: WeeklyReviewClosureSyncResult[] = [];
  for (const [date, issues] of byDate) {
    const reportDir = join(reportsRoot, date);
    mkdirSync(reportDir, { recursive: true });
    const receiptsPath = join(reportDir, "follow-up-receipts.md");
    const statusPath = join(reportDir, "closure-status.md");
    if (options.createReceipts && !existsSync(receiptsPath)) {
      writeFileSync(receiptsPath, renderMissingReceiptsTemplate(date, issues), "utf-8");
    }

    const receiptsText = existsSync(receiptsPath) ? readFileSync(receiptsPath, "utf-8") : "";
    const items = issues.map((issue) => ({
      issue,
      result: assessWeeklyReviewClosure({
        issue,
        receiptsText,
        receiptsPath,
        requiredEvidence: inferRequiredEvidence(issue),
      }),
    }));
    const purposeMet = items.every((item) => item.result.purpose_met === "met") ? "met" : "not_met";
    writeFileSync(statusPath, renderAggregateClosureStatus(items), "utf-8");
    synced.push({ date, receiptsPath, statusPath, issueIds: issues.map((issue) => issue.id), purposeMet });
  }
  return synced;
}

function issueReviewDate(issue: Issue): string {
  const explicitDate = `${issue.title}\n${issue.description}`.match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0];
  return explicitDate ?? formatReviewDate(issue.createdAt);
}

function isPackageFailureTrackingIssue(issue: Issue): boolean {
  return /package verifier\s+FAIL|reviewer-a-correction|verifier-retry/i.test(
    `${issue.title}\n${issue.description}\n${issue.verification ?? ""}`,
  );
}

function hoursSince(timestampMs: number, now: Date): number {
  return Math.max(0, (now.getTime() - timestampMs) / 3_600_000);
}

function parseVerifierVerdict(text: string): "PASS" | "FAIL" | "UNKNOWN" {
  const lines = text.split(/\r?\n/).slice(0, 30).map((line) => line.trim());
  for (const line of lines) {
    const direct = line.match(/^VERDICT:\s*(PASS|FAIL)\.?$/i);
    if (direct) return direct[1].toUpperCase() as "PASS" | "FAIL";
  }
  const headingIndex = lines.findIndex((line) => /^##\s*(?:Verdict|复核结论|结论)\s*$/i.test(line));
  if (headingIndex >= 0) {
    const value = lines.slice(headingIndex + 1).find(Boolean)?.match(/^(PASS|FAIL)\.?$/i);
    if (value) return value[1].toUpperCase() as "PASS" | "FAIL";
  }
  return "UNKNOWN";
}

function readLatestVerifiers(
  reportsRoot: string,
  issues: Issue[],
  now: Date,
  orphanSlaHours: number,
): WeeklyReviewStandingVerifier[] {
  if (!existsSync(reportsRoot)) return [];
  const packageTrackingIssues = issues.filter(isPackageFailureTrackingIssue);
  const latest: WeeklyReviewStandingVerifier[] = [];

  for (const dateEntry of readdirSync(reportsRoot, { withFileTypes: true })) {
    if (!dateEntry.isDirectory() || !/^20\d{2}-\d{2}-\d{2}$/.test(dateEntry.name)) continue;
    const reportDir = join(reportsRoot, dateEntry.name);
    const candidates = readdirSync(reportDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("verifier"))
      .map((entry) => join(reportDir, entry.name, "weekly-review-verification.md"))
      .filter(existsSync)
      .map((verifierPath) => ({ verifierPath, mtimeMs: statSync(verifierPath).mtimeMs }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    const current = candidates[0];
    if (!current) continue;

    const verdict = parseVerifierVerdict(readFileSync(current.verifierPath, "utf-8"));
    const ageHours = hoursSince(current.mtimeMs, now);
    latest.push({
      date: dateEntry.name,
      verdict,
      verifierPath: current.verifierPath,
      ageHours,
      trackedIssueIds: packageTrackingIssues
        .filter((issue) => issueReviewDate(issue) === dateEntry.name)
        .map((issue) => issue.id),
      // A passed package can naturally be older than the owner-follow-up SLA.
      // Only an unresolved FAIL is an actionable package-age breach.
      slaBreached: verdict === "FAIL" && ageHours >= orphanSlaHours,
    });
  }

  return latest.sort((left, right) => left.date.localeCompare(right.date));
}

export function runWeeklyReviewStandingSweep(
  db: Database.Database,
  options: WeeklyReviewStandingSweepOptions = {},
): WeeklyReviewStandingSweepResult {
  const reportsRoot = options.reportsRoot ?? "reports/weekly-review";
  const now = options.now ?? new Date();
  const orphanSlaHours = options.orphanSlaHours ?? 24;
  const issues = readWeeklyReviewIssues(db);
  const activeIssues = issues.filter(
    (issue) => issue.status === "open" || issue.status === "in_progress" || issue.status === "pending",
  );
  for (const date of new Set(activeIssues.map(issueReviewDate))) {
    syncWeeklyReviewClosureStatuses(db, { reportsRoot, onlyDate: date, createReceipts: true });
  }

  const openIssues = activeIssues.map((issue) => {
    const ageHours = hoursSince(issue.createdAt, now);
    return {
      id: issue.id,
      date: issueReviewDate(issue),
      title: issue.title,
      status: issue.status,
      ageHours,
      slaBreached: ageHours >= orphanSlaHours,
      retryCount: issue.retryCount,
      ...standingEvidenceForIssue(issue, reportsRoot, now),
    };
  });
  const strandedIssues = openIssues.filter((issue) => issue.slaBreached);
  const latestVerifiers = readLatestVerifiers(reportsRoot, issues, now, orphanSlaHours);
  const packageFailures = latestVerifiers.filter((verifier) => verifier.verdict === "FAIL");
  const orphanedPackageFailures = packageFailures.filter(
    (verifier) => verifier.slaBreached && verifier.trackedIssueIds.length === 0,
  );

  return {
    generatedAt: now.toISOString(),
    orphanSlaHours,
    openIssues,
    strandedIssues,
    latestVerifiers,
    packageFailures,
    orphanedPackageFailures,
    attentionRequired: packageFailures.length > 0 || strandedIssues.length > 0,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildStandingOwnerRetryRequest(
  issue: Issue,
  standingIssue: WeeklyReviewStandingIssue,
  owner: string,
): WeeklyReviewOwnerRetryRequest {
  const receiptMarker =
    standingIssue.evidenceClassification === "canonical"
      ? standingIssue.requiredCompletionMarkers[0]
      : standingIssue.requiredCompletionMarkers.find(
          (marker) => ownerFromCompletionMarker(marker)?.toLowerCase() === owner.toLowerCase(),
        );
  const requiredReceiptMarker = receiptMarker ?? `${owner} completion: verified`;
  return {
    target: owner,
    from: "watchdog",
    client_request_id: `${standingIssue.date}:watchdog:${owner}:weekly-review-standing-retry:${issue.id}`,
    closure: { kind: "message", target: { type: "todo_pool" } },
    prompt: [
      `[weekly-review standing-sweep re-dispatch] issue ${issue.id} has remained ${standingIssue.status} for ${standingIssue.ageHours.toFixed(1)}h (SLA ${standingIssue.date}).`,
      `Finding: ${issue.title}`,
      "Owner scope:",
      issue.description,
      `Required closure evidence remains the standalone receipt marker: ${requiredReceiptMarker}.`,
      `After successful verification, the final response must begin with this exact standalone line: ${requiredReceiptMarker}. If verification is incomplete or fails, do not emit that line.`,
      "Perform the owner-side correction and return the commit, red-to-green regression evidence, and any required live readback. Do not mark this watchdog issue done or fabricate the receipt; watchdog will independently verify it.",
    ].join("\n\n"),
  };
}

async function parseResponseBody(response: Response): Promise<{ parsed: Record<string, unknown> | null; text: string }> {
  const text = await response.text().catch(() => "");
  if (!text) return { parsed: null, text };
  try {
    const value = JSON.parse(text);
    return { parsed: value && typeof value === "object" ? value as Record<string, unknown> : null, text };
  } catch {
    return { parsed: null, text };
  }
}

async function redispatchStandingOwner(request: WeeklyReviewOwnerRetryRequest): Promise<WeeklyReviewOwnerRetryDispatch> {
  try {
    const response = await fetch(STANDING_SWEEP_SPAWN_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(15_000),
    });
    const { parsed, text } = await parseResponseBody(response);
    if (response.ok && parsed?.ok !== false) {
      return {
        status: "accepted",
        ...(optionalString(parsed?.childSessionId) ? { childSessionId: optionalString(parsed?.childSessionId) } : {}),
        ...(optionalString(parsed?.ref) ? { ref: optionalString(parsed?.ref) } : {}),
      };
    }
    const existing = parsed?.existing;
    const existingRecord = existing && typeof existing === "object" ? existing as Record<string, unknown> : null;
    if (response.status === 409 && parsed?.duplicate === true && optionalString(existingRecord?.status) !== "failed") {
      return {
        status: "already_registered",
        ...(optionalString(existingRecord?.childSessionId) ? { childSessionId: optionalString(existingRecord?.childSessionId) } : {}),
        ...(optionalString(existingRecord?.ref) ? { ref: optionalString(existingRecord?.ref) } : {}),
      };
    }
    return {
      status: "failed",
      error: `spawn2.0 HTTP ${response.status}: ${text.slice(0, 200)}`,
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    };
  }
}

function hasRecordedStandingOwnerRetry(db: Database.Database, issueId: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM weekly_review_standing_retries WHERE issue_id = ?").get(issueId),
  );
}

function recordOwnerRetryDispatch(
  db: Database.Database,
  issueId: string,
  dispatches: Array<{
    owner: string;
    request: WeeklyReviewOwnerRetryRequest;
    dispatchResult: WeeklyReviewOwnerRetryDispatch;
  }>,
): boolean {
  const record = db.transaction(() => {
    const active = db.prepare(`
      SELECT 1 FROM issues
      WHERE id = ?
        AND source = 'weekly-review-watchdog'
        AND status IN ('open', 'in_progress', 'pending')
    `).get(issueId);
    if (!active) return false;
    const inserted = db.prepare(`
      INSERT INTO weekly_review_standing_retries (issue_id, dispatches_json, recorded_at)
      VALUES (?, ?, ?)
      ON CONFLICT(issue_id) DO NOTHING
    `).run(
      issueId,
      JSON.stringify(dispatches.map(({ owner, request, dispatchResult }) => ({
        owner,
        clientRequestId: request.client_request_id,
        status: dispatchResult.status,
        childSessionId: dispatchResult.childSessionId,
        ref: dispatchResult.ref,
      }))),
      Date.now(),
    );
    if (inserted.changes !== 1) return false;
    const updated = db.prepare(`
      UPDATE issues
      SET retry_count = retry_count + 1
      WHERE id = ?
        AND source = 'weekly-review-watchdog'
        AND status IN ('open', 'in_progress', 'pending')
    `).run(issueId);
    if (updated.changes !== 1) throw new Error(`weekly-review issue ${issueId} stopped being active while recording E7 retry`);
    return true;
  });
  return record();
}

function renderStandingSweepAttention(
  result: WeeklyReviewStandingSweepResult,
  ownerRetries: WeeklyReviewStandingOwnerRetry[],
): NotifyRequest {
  const lines = [
    "standing-sweep detected attentionRequired:true. Scheduler trigger success is not acknowledgement or closure.",
    "",
    "## Stranded owner follow-up",
  ];
  if (result.strandedIssues.length === 0) {
    lines.push("- none");
  } else {
    for (const issue of result.strandedIssues) {
      const owners =
        issue.evidenceClassification === "unclassified"
          ? "unclassified"
          : issue.missingOwners.length > 0
            ? issue.missingOwners.join(", ")
            : `none (required: ${issue.requiredOwners.join(", ")})`;
      lines.push(`- ${issue.id} · ${issue.title} · ${issue.ageHours.toFixed(1)}h · retry_count=${issue.retryCount} · missing: ${owners}`);
    }
  }

  lines.push("", "## E7 action this run");
  if (ownerRetries.length === 0) {
    lines.push("- no new owner re-dispatch (already recorded, no owner marker, or no stranded issue)");
  } else {
    for (const retry of ownerRetries) {
      const receipt = retry.childSessionId ?? retry.ref ?? retry.error ?? "no receipt field";
      lines.push(`- ${retry.issueId} → ${retry.owner}: ${retry.status}; retry_count recorded=${retry.retryRecorded}; ${receipt}`);
    }
  }

  if (result.packageFailures.length > 0) {
    lines.push("", "## Current verifier FAIL packages");
    for (const verifier of result.packageFailures) {
      lines.push(`- ${verifier.date} · ${verifier.verifierPath} · tracked issues: ${verifier.trackedIssueIds.join(", ") || "none"}`);
    }
  }
  if (result.orphanedPackageFailures.length > 0) {
    lines.push("", "## Orphan package failures requiring issue registration");
    for (const verifier of result.orphanedPackageFailures) {
      lines.push(`- ${verifier.date} · ${verifier.verifierPath}`);
    }
  }

  lines.push(
    "",
    "Deadline: the named owner must acknowledge with owner-side evidence within 30 minutes. A retry dispatch is only follow-up delivery evidence; Charter closure still requires issue done plus independently verified owner receipt.",
  );
  return {
    source: "watchdog",
    title: `weekly-review standing sweep attention · ${result.strandedIssues.length} stranded`,
    body: lines.join("\n"),
    level: "warn",
    metadata: {
      runKind: "weekly-review-standing-sweep",
      attentionRequired: "true",
      strandedCount: result.strandedIssues.length,
      packageFailureCount: result.packageFailures.length,
      orphanedPackageFailureCount: result.orphanedPackageFailures.length,
    },
  };
}

async function notifyStandingSweepAttention(
  notifier: Pick<NotifyClient, "notify">,
  request: NotifyRequest,
): Promise<WeeklyReviewStandingNotification> {
  let error = "unknown notify failure";
  for (let attempts = 1; attempts <= 2; attempts += 1) {
    try {
      const response = await notifier.notify(request);
      if (!response.messageId) throw new Error("notify response missing messageId");
      return { status: "sent", attempts, messageId: response.messageId };
    } catch (caught) {
      error = caught instanceof Error ? caught.message.slice(0, 200) : String(caught).slice(0, 200);
    }
  }
  return { status: "failed", attempts: 2, error };
}

export async function runWeeklyReviewStandingSweepWithEscalation(
  db: Database.Database,
  options: WeeklyReviewStandingSweepEscalationOptions = {},
): Promise<WeeklyReviewStandingSweepEscalationResult> {
  const result = runWeeklyReviewStandingSweep(db, options);
  const ownerRetries: WeeklyReviewStandingOwnerRetry[] = [];
  const escalate = options.escalate !== false;
  if (escalate && result.attentionRequired) {
    const activeIssues = new Map(
      readWeeklyReviewIssues(db)
        .filter((issue) => issue.status === "open" || issue.status === "in_progress" || issue.status === "pending")
        .map((issue) => [issue.id, issue]),
    );
    const dispatch = options.redispatch ?? redispatchStandingOwner;
    for (const standingIssue of result.strandedIssues) {
      if (
        standingIssue.evidenceClassification === "unclassified"
        || standingIssue.missingOwners.length === 0
        || hasRecordedStandingOwnerRetry(db, standingIssue.id)
      ) continue;
      const issue = activeIssues.get(standingIssue.id);
      if (!issue) continue;
      const attempts = await Promise.all(standingIssue.missingOwners.map(async (owner) => {
        const request = buildStandingOwnerRetryRequest(issue, standingIssue, owner);
        const dispatchResult = await dispatch(request);
        return { owner, request, dispatchResult };
      }));
      const retryRecorded = attempts.length > 0
        && attempts.every((attempt) => attempt.dispatchResult.status !== "failed")
        && recordOwnerRetryDispatch(db, issue.id, attempts);
      if (retryRecorded) standingIssue.retryCount += 1;
      for (const attempt of attempts) {
        ownerRetries.push({
          issueId: issue.id,
          owner: attempt.owner,
          clientRequestId: attempt.request.client_request_id,
          ...attempt.dispatchResult,
          retryRecorded,
        });
      }
    }
  }

  if (!result.attentionRequired) return { result, ownerRetries };
  if (!escalate) {
    return {
      result,
      ownerRetries,
      notification: { status: "skipped", attempts: 0 },
    };
  }
  const notifier = options.notifier === undefined ? createNotifyClient() : options.notifier;
  if (!notifier) {
    return {
      result,
      ownerRetries,
      notification: { status: "skipped", attempts: 0 },
    };
  }
  return {
    result,
    ownerRetries,
    notification: await notifyStandingSweepAttention(notifier, renderStandingSweepAttention(result, ownerRetries)),
  };
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = "";
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

async function runCli(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const issueId = flags["issue-id"];
  const receiptsPath = flags.receipts;

  if ("standing-sweep" in flags) {
    const orphanSlaHours = Number(flags["orphan-sla-hours"] || "24");
    if (!Number.isFinite(orphanSlaHours) || orphanSlaHours <= 0) {
      console.error("--orphan-sla-hours must be a positive number");
      process.exit(2);
    }
    const config = loadConfig(process.env as Record<string, string>);
    const db = new Database(config.dbPath);
    applyMigrations(db);
    const reportsRoot = flags["reports-root"] || "reports/weekly-review";
    const escalation = await runWeeklyReviewStandingSweepWithEscalation(db, {
      reportsRoot,
      orphanSlaHours,
      notifier: config.notifyEnabled ? undefined : null,
      escalate: !("no-escalate" in flags),
    });
    const statusPath = flags["write-standing-status"] || join(reportsRoot, "standing-sweep.json");
    const status = {
      ...escalation.result,
      escalation: {
        notification: escalation.notification,
        ownerRetries: escalation.ownerRetries,
      },
    };
    mkdirSync(dirname(statusPath), { recursive: true });
    writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf-8");
    db.close();
    console.log(JSON.stringify({ ...status, statusPath }, null, 2));
    process.exit(escalation.result.attentionRequired ? 1 : 0);
  }

  if ("sync-open" in flags || "sync-all" in flags) {
    const config = loadConfig(process.env as Record<string, string>);
    const db = new Database(config.dbPath);
    applyMigrations(db);
    const reportsRoot = flags["reports-root"] || "reports/weekly-review";
    const synced =
      "sync-open" in flags
        ? syncWeeklyReviewClosureStatuses(db, {
            reportsRoot,
            statuses: ["open"],
            createReceipts: true,
          }).flatMap((item) =>
            syncWeeklyReviewClosureStatuses(db, {
              reportsRoot,
              onlyDate: item.date,
              createReceipts: true,
            }),
          )
        : syncWeeklyReviewClosureStatuses(db, {
            reportsRoot,
            createReceipts: true,
          });
    db.close();
    console.log(JSON.stringify({ synced }, null, 2));
    process.exit(synced.every((item) => item.purposeMet === "met") ? 0 : 1);
  }

  if (!issueId || !receiptsPath) {
    console.error(
      "Usage: tsx src/scripts/weekly-review-closure.ts --issue-id <id> --receipts <path> [--owners a,b] [--write-status <path>]\n       tsx src/scripts/weekly-review-closure.ts --sync-open|--sync-all [--reports-root <path>]",
      "       tsx src/scripts/weekly-review-closure.ts --standing-sweep [--orphan-sla-hours 24] [--reports-root <path>] [--write-standing-status <path>] [--no-escalate]",
    );
    process.exit(2);
  }

  const config = loadConfig(process.env as Record<string, string>);
  const db = new Database(config.dbPath);
  applyMigrations(db);
  const store = createIssueStore(db);
  let issue: Issue | null = null;
  try {
    issue = store.getIssue(issueId);
  } catch {
    issue = null;
  }
  const receiptsText = existsSync(receiptsPath) ? readFileSync(receiptsPath, "utf-8") : "";
  const requiredEvidence = flags.owners
    ? flags.owners
        .split(",")
        .map((owner) => owner.trim())
        .filter(Boolean)
        .map((owner) => `${owner} completion: verified`)
    : issue
      ? inferRequiredEvidence(issue)
      : [];
  const result = assessWeeklyReviewClosure({ issue, receiptsText, requiredEvidence, receiptsPath });
  if (flags["write-status"]) {
    mkdirSync(dirname(flags["write-status"]), { recursive: true });
    writeFileSync(flags["write-status"], renderWeeklyReviewClosureStatus(result), "utf-8");
  }
  db.close();

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.purposeMet === "met" ? 0 : 1);
}

if (process.argv[1] && /weekly-review-closure\.(?:ts|js)$/.test(process.argv[1])) {
  void runCli().catch((error) => {
    console.error("weekly-review-closure failed:", error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
