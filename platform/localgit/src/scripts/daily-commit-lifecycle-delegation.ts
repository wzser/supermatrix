import { execFileSync } from "node:child_process";
import { resolveSpawn2Endpoint } from "./localgit-context.js";

type SpawnPayload = {
  target: "codexroot";
  from: "localgit";
  prompt: string;
  client_request_id: string;
  closure: { kind: "message"; target: { type: "todo_pool" } };
  verification_predicate: {
    type: "inbox-message";
    session_name: "codexroot";
    field: "prompt";
    contains_all: string[];
    expected_window_sec: 600;
  };
};

export type LifecycleMaintenanceDelegation = {
  clientRequestId: string;
  verificationToken: string;
  payload: SpawnPayload;
};

export type LifecycleMaintenanceSpawnRunner = {
  runCommand(command: string, args: string[]): string;
};

export type LifecycleMaintenanceReceipt = {
  accepted: true;
  statusCode: number;
  body: unknown;
  receiptSummary: string;
};

function safeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
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

function existingField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return stringField((value as Record<string, unknown>).existing, key);
}

export function buildLifecycleMaintenanceDelegation(input: {
  date: string;
  runId: string;
  committed: number;
}): LifecycleMaintenanceDelegation {
  const key = safeKey(input.runId);
  const clientRequestId = `${input.date}:localgit:codexroot:lifecycle-maintenance-${key}`;
  const verificationToken = `comm_localgit_lifecycle_${key}`;
  const prompt = [
    `[verification: ${verificationToken}] localgit detected ${input.committed} committed non-hold repository result(s).`,
    `Run-ID：${input.runId}`,
    "This is a maintenance request only. localgit performed no global lifecycle command and must not reload, restart, stop, or kill any live process.",
    "codexroot owns the runtime/framework decision: inspect current state read-only first, then use only an approved root-owned maintenance path if one is actually required.",
    "Return the accepted request/result URL or a concrete blocker; do not treat dispatch acceptance as maintenance completion.",
  ].join("\n");

  return {
    clientRequestId,
    verificationToken,
    payload: {
      target: "codexroot",
      from: "localgit",
      prompt,
      client_request_id: clientRequestId,
      closure: { kind: "message", target: { type: "todo_pool" } },
      verification_predicate: {
        type: "inbox-message",
        session_name: "codexroot",
        field: "prompt",
        contains_all: [verificationToken],
        expected_window_sec: 600,
      },
    },
  };
}

function defaultRunner(): LifecycleMaintenanceSpawnRunner {
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
  if (newline < 0) throw new Error("spawn2.0 lifecycle maintenance missing HTTP status code");
  const statusCode = Number(trimmed.slice(newline + 1));
  if (!Number.isInteger(statusCode)) throw new Error("spawn2.0 lifecycle maintenance returned invalid HTTP status code");
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

function isQueued(body: unknown, statusCode: number): boolean {
  return statusCode === 202
    && booleanField(body, "ok") === true
    && stringField(body, "status") === "queued"
    && Boolean(stringField(body, "ref"))
    && Boolean(stringField(body, "resultUrl"))
    && Boolean(stringField(body, "spawnCommId") ?? stringField(body, "comm_id"));
}

function isAuditableDuplicate(body: unknown, statusCode: number): boolean {
  return statusCode === 409
    && booleanField(body, "duplicate") === true
    && Boolean(existingField(body, "commId"))
    && Boolean(existingField(body, "status"));
}

export function spawnLifecycleMaintenance(
  delegation: LifecycleMaintenanceDelegation,
  runner: LifecycleMaintenanceSpawnRunner = defaultRunner(),
): LifecycleMaintenanceReceipt {
  const raw = runner.runCommand("curl", [
    "-sS",
    "-X", "POST",
    resolveSpawn2Endpoint(),
    "-H", "Content-Type: application/json",
    "-d", JSON.stringify(delegation.payload),
    "-w", "\n%{http_code}",
  ]);
  const { body, statusCode } = parseResponse(raw);
  if (!isQueued(body, statusCode) && !isAuditableDuplicate(body, statusCode)) {
    throw new Error(`spawn2.0 lifecycle maintenance failed with HTTP ${statusCode}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  const receiptSummary = statusCode === 409
    ? `spawn2.0 duplicate accepted existingCommId=${existingField(body, "commId")} existingStatus=${existingField(body, "status")}`
    : `spawn2.0 queued ref=${stringField(body, "ref")} resultUrl=${stringField(body, "resultUrl")} spawnCommId=${stringField(body, "spawnCommId") ?? stringField(body, "comm_id")}`;
  return { accepted: true, statusCode, body, receiptSummary };
}
