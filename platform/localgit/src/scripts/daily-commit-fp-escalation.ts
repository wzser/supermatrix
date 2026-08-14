import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { SM_RUNTIME_ROOT } from "./localgit-context.js";

const SPAWN2_URL = "http://localhost:3501/api/spawn2.0";
const FP_DISCIPLINE_DOC = process.env.LOCALGIT_FP_DISCIPLINE_DOC
  ?? join(SM_RUNTIME_ROOT, "workspaces/first-principle/templates/console-principles.md");

type SpawnClosure = {
  kind: "message";
  target: {
    type: "todo_pool";
  };
};

type SpawnVerificationPredicate = {
  type: "inbox-message";
  session_name: "first-principle";
  field: "prompt";
  contains_all: string[];
  expected_window_sec: 600;
};

export type FpIdentityDocEscalationPayload = {
  target: "first-principle";
  from: "localgit";
  prompt: string;
  client_request_id: string;
  closure: SpawnClosure;
  verification_predicate: SpawnVerificationPredicate;
};

export type FpIdentityDocEscalation = {
  dispatchId: string;
  clientRequestId: string;
  verificationToken: string;
  payload: FpIdentityDocEscalationPayload;
};

export type FpIdentityDocEscalationReceipt = {
  accepted: boolean;
  statusCode: number;
  body: unknown;
  receiptSummary: string;
};

export type SpawnCommandRunner = {
  runCommand(command: string, args: string[]): string;
};

function repoKey(repo: string): string {
  return repo.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function verificationTokenFor(dispatchId: string): string {
  return `comm_identity_doc_major_${dispatchId.replace(/[^A-Za-z0-9]+/g, "_")}`;
}

export function buildFpIdentityDocEscalation(input: {
  date: string;
  repo: string;
  skippedReason: string;
  dispatchId: string;
  dirtyFingerprint?: string;
}): FpIdentityDocEscalation {
  const clientRequestId = `${input.date}:localgit:first-principle:identity-doc-major-${repoKey(input.repo)}`;
  const verificationToken = verificationTokenFor(input.dispatchId);
  const prompt = [
    `[verification: ${verificationToken}] Daily-commit found identity_doc_major_change in ${input.repo}.`,
    `关联ID：${input.dispatchId}`,
    `Dirty-Fingerprint：${input.dirtyFingerprint ?? "unknown"}`,
    `Skipped reason: ${input.skippedReason}`,
    `Read ${FP_DISCIPLINE_DOC} section "Session Identity Document Change Discipline", then inspect ${input.repo} identity-doc diff.`,
    "Acceptance: decide whether this is T2 session-owned self-evolution, T3 baseline-template change request, T4 forbidden new identity doc, or FP-orchestrated rollout; either commit with the correct identity prefix or tell localgit the exact safe next action.",
    "Localgit must not auto-commit this dirty set without your decision.",
  ].join("\n");

  return {
    dispatchId: input.dispatchId,
    clientRequestId,
    verificationToken,
    payload: {
      target: "first-principle",
      from: "localgit",
      prompt,
      client_request_id: clientRequestId,
      closure: { kind: "message", target: { type: "todo_pool" } },
      verification_predicate: {
        type: "inbox-message",
        session_name: "first-principle",
        field: "prompt",
        contains_all: [verificationToken],
        expected_window_sec: 600,
      },
    },
  };
}

function defaultRunner(): SpawnCommandRunner {
  return {
    runCommand(command, args) {
      return execFileSync(command, args, { encoding: "utf-8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    },
  };
}

function parseCurlResponse(raw: string): { body: unknown; statusCode: number } {
  const trimmed = raw.trimEnd();
  const newline = trimmed.lastIndexOf("\n");
  if (newline < 0) {
    throw new Error("spawn2.0 FP escalation failed: missing HTTP status code");
  }
  const statusCode = Number(trimmed.slice(newline + 1));
  if (!Number.isInteger(statusCode)) {
    throw new Error(`spawn2.0 FP escalation failed: invalid HTTP status code ${trimmed.slice(newline + 1)}`);
  }

  const bodyText = trimmed.slice(0, newline).trim();
  let body: unknown = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = bodyText;
    }
  }
  return { body, statusCode };
}

function getStringField(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object" || !(key in body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function getBooleanField(body: unknown, key: string): boolean | undefined {
  if (!body || typeof body !== "object" || !(key in body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function getExistingField(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object" || !("existing" in body)) return undefined;
  const existing = (body as Record<string, unknown>).existing;
  if (!existing || typeof existing !== "object" || !(key in existing)) return undefined;
  const value = (existing as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function isTodoPoolAccepted(body: unknown, statusCode: number): boolean {
  return statusCode === 202
    && getBooleanField(body, "ok") === true
    && getStringField(body, "mode") === "async_kickoff"
    && getStringField(body, "closure") === "todo_pool"
    && Boolean(getStringField(body, "ref"))
    && Boolean(getStringField(body, "spawnCommId"));
}

function isAuditableDuplicate(body: unknown, statusCode: number): boolean {
  return statusCode === 409
    && getBooleanField(body, "duplicate") === true
    && Boolean(getExistingField(body, "commId"))
    && Boolean(getExistingField(body, "status"));
}

export function spawnFpIdentityDocEscalation(
  escalation: FpIdentityDocEscalation,
  runner: SpawnCommandRunner = defaultRunner(),
): FpIdentityDocEscalationReceipt {
  const raw = runner.runCommand("curl", [
    "-sS",
    "-X", "POST",
    SPAWN2_URL,
    "-H", "Content-Type: application/json",
    "-d", JSON.stringify(escalation.payload),
    "-w", "\n%{http_code}",
  ]);
  const { body, statusCode } = parseCurlResponse(raw);
  const accepted = isTodoPoolAccepted(body, statusCode) || isAuditableDuplicate(body, statusCode);
  if (!accepted) {
    throw new Error(`spawn2.0 FP escalation failed with HTTP ${statusCode}: ${JSON.stringify(body).slice(0, 500)}`);
  }

  const receiptSummary = statusCode === 409
    ? `spawn2.0 duplicate accepted existingCommId=${getExistingField(body, "commId")} existingStatus=${getExistingField(body, "status")}`
    : `spawn2.0 todo_pool accepted ref=${getStringField(body, "ref")} spawnCommId=${getStringField(body, "spawnCommId")}`;
  return { accepted: true, statusCode, body, receiptSummary };
}
