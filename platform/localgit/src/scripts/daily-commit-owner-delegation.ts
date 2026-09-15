import { execFileSync } from "node:child_process";
import { DAILY_COMMIT_IGNORE_POLICY_ABSOLUTE_PATH } from "./daily-commit-ignore-policy.js";
import {
  OWNER_DECISION_RUBRIC_PATH,
  OWNER_DECISION_RUBRIC_VERSION,
} from "./daily-commit-judgment-matrix.js";
import { LOCALGIT_ROOT, resolveSpawn2Endpoint } from "./localgit-context.js";

type OwnerDelegationPayload = {
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

export type OwnerDecisionDelegation = {
  clientRequestId: string;
  verificationToken: string;
  payload: OwnerDelegationPayload;
};

export type OwnerDelegationSpawnRunner = {
  runCommand(command: string, args: string[]): string;
};

function repoKey(repo: string): string {
  return repo.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "boolean" ? field : undefined;
}

function existingStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return stringField((value as Record<string, unknown>).existing, key);
}

export function buildOwnerDecisionDelegation(input: {
  date: string;
  repo: string;
  repoPath: string;
  dispatchId: string;
  dirtyFingerprint?: string;
  skippedReason: string;
  defaultSuggestion: string;
}): OwnerDecisionDelegation {
  const key = repoKey(input.repo);
  const fingerprint = input.dirtyFingerprint?.slice(0, 12) || input.dispatchId.slice(-12);
  const clientRequestId = `${input.date}:localgit:${key}:owner-decision-${fingerprint}`;
  const verificationToken = `comm_daily_commit_owner_${key}_${fingerprint}`.replace(/[^A-Za-z0-9_]/g, "_");
  const decisionCommand = [
    `cd ${LOCALGIT_ROOT}`,
    "&& npm run daily-commit-decision --",
    `--repo ${input.repo}`,
    `--dirty-fingerprint ${input.dirtyFingerprint ?? "unknown"}`,
    "--decision <resolved|owner_ignore_policy|quiet_until_changed>",
    `--actor ${input.repo}`,
    `--dispatch-id ${input.dispatchId}`,
    "--scope fingerprint",
    '--reason "<one-sentence reason>"',
  ].join(" ");
  const prompt = [
    `[verification: ${verificationToken}] You are the owner session for repository ${input.repo}.`,
    `关联ID：${input.dispatchId}`,
    `Dirty-Fingerprint：${input.dirtyFingerprint ?? "unknown"}`,
    `Workspace：${input.repoPath}`,
    `Skipped reason：${input.skippedReason}`,
    `裁决准则：${OWNER_DECISION_RUBRIC_PATH}（${OWNER_DECISION_RUBRIC_VERSION}）。`,
    `localgit 预判默认项：${input.defaultSuggestion}。`,
    "Handle this repo-local decision yourself; do not ask the human operator to choose unless an actual business decision remains.",
    "Inspect the current dirty files, then choose exactly one action per unresolved path: commit, ignore, or keep_dirty.",
    "- commit: precise-stage and commit only approved files.",
    "- ignore: only add a narrow repo-local .gitignore rule when allowed; never use it for secrets, DBs, or unverified behavior changes.",
    "- keep_dirty: retain only with a concrete reason.",
    `After the repo-local action, append the matching audit decision with: ${decisionCommand}`,
    "Use resolved after a completed commit, owner_ignore_policy after an allowed ignore rule, or quiet_until_changed only for a justified keep_dirty result.",
    `Ignore-policy boundary: ${DAILY_COMMIT_IGNORE_POLICY_ABSOLUTE_PATH}`,
    "Return the exact action, commit SHA or decision id, and any blocker.",
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

function defaultRunner(): OwnerDelegationSpawnRunner {
  return {
    runCommand(command, args) {
      return execFileSync(command, args, {
        encoding: "utf-8",
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
      });
    },
  };
}

function parseResponse(raw: string): { body: unknown; statusCode: number } {
  const trimmed = raw.trimEnd();
  const newline = trimmed.lastIndexOf("\n");
  if (newline < 0) throw new Error("spawn2.0 owner delegation missing HTTP status code");
  const statusCode = Number(trimmed.slice(newline + 1));
  if (!Number.isInteger(statusCode)) throw new Error("spawn2.0 owner delegation returned invalid HTTP status code");
  const text = trimmed.slice(0, newline).trim();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { body, statusCode };
}

function isAcceptedQueued(body: unknown, statusCode: number): boolean {
  return statusCode === 202
    && booleanField(body, "ok") === true
    && stringField(body, "status") === "queued"
    && Boolean(stringField(body, "ref"))
    && Boolean(stringField(body, "spawnCommId") ?? stringField(body, "comm_id"));
}

function isAcceptedTodoPool(body: unknown, statusCode: number): boolean {
  return statusCode === 202
    && booleanField(body, "ok") === true
    && stringField(body, "mode") === "async_kickoff"
    && stringField(body, "closure") === "todo_pool"
    && Boolean(stringField(body, "ref"))
    && Boolean(stringField(body, "spawnCommId"));
}

function isAcceptedDuplicate(body: unknown, statusCode: number): boolean {
  const accepted = new Set(["pending", "in_flight", "dispatched", "waiting_child", "queued", "completed", "delivered"]);
  return statusCode === 409
    && booleanField(body, "duplicate") === true
    && Boolean(existingStringField(body, "commId"))
    && Boolean(existingStringField(body, "status"))
    && accepted.has(existingStringField(body, "status") ?? "");
}

export function spawnOwnerDecisionDelegation(
  delegation: OwnerDecisionDelegation,
  runner: OwnerDelegationSpawnRunner = defaultRunner(),
): { accepted: true; statusCode: number; body: unknown; receiptSummary: string } {
  const raw = runner.runCommand("curl", [
    "-sS",
    "-X", "POST", resolveSpawn2Endpoint(),
    "-H", "Content-Type: application/json",
    "-d", JSON.stringify(delegation.payload),
    "-w", "\n%{http_code}",
  ]);
  const { body, statusCode } = parseResponse(raw);
  if (!isAcceptedQueued(body, statusCode) && !isAcceptedTodoPool(body, statusCode) && !isAcceptedDuplicate(body, statusCode)) {
    throw new Error(`spawn2.0 owner delegation failed with HTTP ${statusCode}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  const receiptSummary = statusCode === 409
    ? `spawn2.0 duplicate accepted existingCommId=${existingStringField(body, "commId")} existingStatus=${existingStringField(body, "status")}`
    : `spawn2.0 accepted ref=${stringField(body, "ref")} spawnCommId=${stringField(body, "spawnCommId") ?? stringField(body, "comm_id")}`;
  return { accepted: true, statusCode, body, receiptSummary };
}
