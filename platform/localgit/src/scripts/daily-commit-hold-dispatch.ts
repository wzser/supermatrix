import { execFileSync } from "node:child_process";

const SPAWN2_URL = "http://localhost:3501/api/spawn2.0";

export type HoldReviewDispatch = {
  clientRequestId: string;
  verificationToken: string;
  payload: {
    target: string;
    from: "localgit";
    prompt: string;
    client_request_id: string;
    closure: { kind: "message"; target: { type: "todo_pool" } };
    verification_predicate: {
      type: "inbox-message";
      session_name: string;
      field: "prompt";
      contains_all: string[];
      expected_window_sec: 600;
    };
  };
};

export type SpawnRunner = { runCommand(command: string, args: string[]): string };

export function buildHoldReviewDispatch(input: {
  date: string;
  repo: string;
  repoPath: string;
  originalBranch: string;
  holdBranch: string;
  holdCommit: string;
  dirtyFingerprint: string;
  files: string[];
}): HoldReviewDispatch {
  const repoKey = input.repo.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  const fingerprint = input.dirtyFingerprint.slice(0, 12);
  const clientRequestId = `${input.date}:localgit:${repoKey}:hold-review-${fingerprint}`;
  const verificationToken = `comm_hold_review_${repoKey}_${fingerprint}`.replace(/[^A-Za-z0-9_]/g, "_");
  const decisionBase = [
    "npm run hold-decision --",
    `--repo ${input.repo}`,
    `--repo-path ${input.repoPath}`,
    `--original-branch ${input.originalBranch}`,
    `--hold-branch ${input.holdBranch}`,
    `--hold-commit ${input.holdCommit}`,
    `--dirty-fingerprint ${input.dirtyFingerprint}`,
    `--actor ${input.repo}`,
  ].join(" ");
  const prompt = [
    `[verification: ${verificationToken}] localgit preserved a non-sensitive disputed working set for ${input.repo}.`,
    `Original branch: ${input.originalBranch}`,
    `Hold branch: ${input.holdBranch}`,
    `Hold commit: ${input.holdCommit}`,
    `Dirty fingerprint: ${input.dirtyFingerprint}`,
    `Files: ${input.files.join(", ")}`,
    "Inspect the commit and choose exactly one owner decision:",
    `- merge: ${decisionBase} --decision merge`,
    `- archive: ${decisionBase} --decision archive`,
    `- keep_until: ${decisionBase} --decision keep_until --expires-at <future-ISO>`,
    "Do not push, force-delete, rebase, or auto-resolve conflicts.",
  ].join("\n");
  return {
    clientRequestId,
    verificationToken,
    payload: {
      target: input.repo,
      from: "localgit",
      prompt,
      client_request_id: clientRequestId,
      closure: { kind: "message", target: { type: "todo_pool" } },
      verification_predicate: {
        type: "inbox-message",
        session_name: input.repo,
        field: "prompt",
        contains_all: [verificationToken],
        expected_window_sec: 600,
      },
    },
  };
}

function defaultRunner(): SpawnRunner {
  return {
    runCommand(command, args) {
      return execFileSync(command, args, { encoding: "utf-8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    },
  };
}

export function spawnHoldReview(dispatch: HoldReviewDispatch, runner: SpawnRunner = defaultRunner()): {
  accepted: true;
  statusCode: number;
  body: unknown;
  receiptSummary: string;
} {
  const raw = runner.runCommand("curl", [
    "-sS", "-X", "POST", SPAWN2_URL,
    "-H", "Content-Type: application/json",
    "-d", JSON.stringify(dispatch.payload),
    "-w", "\n%{http_code}",
  ]).trimEnd();
  const newline = raw.lastIndexOf("\n");
  if (newline < 0) throw new Error("spawn2.0 hold review missing HTTP status code");
  const statusCode = Number(raw.slice(newline + 1));
  const body = JSON.parse(raw.slice(0, newline)) as Record<string, unknown>;
  const existing = body.existing as Record<string, unknown> | undefined;
  const accepted202 = statusCode === 202 && body.ok === true && body.mode === "async_kickoff"
    && body.closure === "todo_pool" && typeof body.ref === "string" && typeof body.spawnCommId === "string";
  const acceptedDuplicateStatuses = new Set(["pending", "in_flight", "dispatched", "completed", "delivered"]);
  const accepted409 = statusCode === 409 && body.duplicate === true
    && typeof existing?.commId === "string" && typeof existing?.status === "string"
    && acceptedDuplicateStatuses.has(existing.status);
  if (!accepted202 && !accepted409) {
    throw new Error(`spawn2.0 hold review failed with HTTP ${statusCode}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  const receiptSummary = accepted409
    ? `duplicate accepted commId=${existing?.commId} status=${existing?.status}`
    : `todo_pool accepted ref=${body.ref} spawnCommId=${body.spawnCommId}`;
  return { accepted: true, statusCode, body, receiptSummary };
}
