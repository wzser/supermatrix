#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Db } from "../src/adapters/store-sqlite/db.ts";
import type { CapabilityPayload, ImmutableIngressDeclaration } from "../src/domain/childCapabilities.ts";

export const HDQ_RECEIVER_SESSION_NAME = "huodaiduijie" as const;
export const WCA_NON_RECEIVER_SESSION_NAME = "private_workflow_6d0060b18f1258cc" as const;

export const HDQ_RECEIVER_DECLARATION: ImmutableIngressDeclaration = {
  protocol: "supermatrix-immutable-ingress/v1",
  completionMode: "receiver_terminal",
  startMarker: "WECHAT_HDQ_INGRESS_V1:",
  endMarker: "WECHAT_HDQ_INGRESS_END_V1",
  command: ".venv/bin/python",
  args: [
    "scripts/wechat_subscription_intake.py",
    "--ingress-prompt-file",
    "{prompt_file}",
  ],
  receipt: {
    terminalPointer: "/terminal",
    acceptedPointer: "/transport/target_accepted",
    identity: {
      receivedEnvelopeSha256: {
        receiptPointer: "/transport/received_envelope_sha256",
        carrierPointer: "/raw_object_sha256",
      },
      dedupeKey: {
        receiptPointer: "/correlation/dedupe_key",
        carrierPointer: "/binding/dedupe_key",
      },
      anchorHash: {
        receiptPointer: "/correlation/anchor_hash",
        carrierPointer: "/binding/anchor_hash",
      },
    },
  },
};

type SessionRow = {
  id: string;
  name: string;
  status: string;
  capability_payload: string | null;
};

export type ImmutableIngressDeploymentReceipt = {
  schema: "supermatrix-immutable-ingress-deployment/v1";
  operationId: string;
  appliedAt: number;
  targetSessionName: typeof HDQ_RECEIVER_SESSION_NAME;
  targetSessionId: string;
  changed: boolean;
  beforeCapabilityPayloadSha256: string;
  afterCapabilityPayloadSha256: string;
  capabilityPayload: CapabilityPayload;
  nonReceiver: {
    sessionName: typeof WCA_NON_RECEIVER_SESSION_NAME;
    sessionId: string;
    capabilityPayloadSha256: string;
    unchanged: true;
    immutableIngressAbsent: true;
  };
  source: {
    repository: "SuperMatrix";
    script: "scripts/install-immutable-ingress-receiver.ts";
    commit: string;
    declarationSha256: string;
  };
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseCapabilityPayload(raw: string | null, sessionName: string): CapabilityPayload {
  if (raw === null) return { resultSinks: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${sessionName} capability_payload is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray((parsed as Record<string, unknown>).resultSinks)) {
    throw new Error(`${sessionName} capability_payload is invalid: resultSinks must be an array`);
  }
  return parsed as CapabilityPayload;
}

function readSession(db: Db, name: string): SessionRow {
  const row = db.prepare(
    "SELECT id, name, status, capability_payload FROM sessions WHERE name = ? AND status != 'deleted' LIMIT 1",
  ).get(name) as SessionRow | undefined;
  if (!row) throw new Error(`active session not found: ${name}`);
  return row;
}

function sameDeclaration(left: unknown, right: ImmutableIngressDeclaration): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function declarationWithoutCompletionMode(declaration: ImmutableIngressDeclaration): Record<string, unknown> {
  return Object.fromEntries(Object.entries(declaration).filter(([key]) => key !== "completionMode"));
}

function isTrackedHdqDeclaration(declaration: unknown): boolean {
  if (sameDeclaration(declaration, HDQ_RECEIVER_DECLARATION)) return true;
  return Boolean(
    declaration && typeof declaration === "object" && !Array.isArray(declaration) &&
    !Object.hasOwn(declaration, "completionMode") &&
    canonicalJson(declaration) === canonicalJson(declarationWithoutCompletionMode(HDQ_RECEIVER_DECLARATION)),
  );
}

function deploymentReceiptPath(receiptDir: string, operationId: string): string {
  return join(receiptDir, `${operationId}.json`);
}

function deploymentReceiptTempPath(receiptDir: string, operationId: string): string {
  return join(receiptDir, `${operationId}.json.tmp`);
}

function receiptBytes(receipt: ImmutableIngressDeploymentReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function readReceiptSync(path: string): { bytes: string; receipt: ImmutableIngressDeploymentReceipt } {
  const bytes = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch (error) {
    throw new Error(`deployment receipt at ${path} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`deployment receipt at ${path} is invalid`);
  }
  return { bytes, receipt: parsed as ImmutableIngressDeploymentReceipt };
}

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function stageReceiptSync(receiptDir: string, operationId: string, receipt: ImmutableIngressDeploymentReceipt): string {
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const path = deploymentReceiptTempPath(receiptDir, operationId);
  const bytes = receiptBytes(receipt);
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o400 });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    const existing = readFileSync(path, "utf8");
    if (existing !== bytes) throw new Error(`deployment temp receipt already exists with different content: ${path}`);
  }
  syncFile(path);
  return path;
}

function publishReceiptSync(receiptDir: string, operationId: string, tempPath: string): string {
  const finalPath = deploymentReceiptPath(receiptDir, operationId);
  if (existsSync(finalPath)) throw new Error(`deployment final receipt appeared before publication: ${finalPath}`);
  renameSync(tempPath, finalPath);
  syncDirectory(receiptDir);
  return finalPath;
}

function validateReceiptForState(
  receipt: ImmutableIngressDeploymentReceipt,
  input: { operationId: string },
  target: SessionRow,
  targetPayload: CapabilityPayload,
  nonReceiver: SessionRow,
): void {
  const targetPayloadCanonical = canonicalJson(targetPayload);
  const nonReceiverPayloadSha256 = sha256(nonReceiver.capability_payload ?? canonicalJson({ resultSinks: [] }));
  const receiptPayload = receipt.capabilityPayload;
  const beforeHash = receipt.beforeCapabilityPayloadSha256;
  const afterHash = receipt.afterCapabilityPayloadSha256;
  const source = receipt.source;
  if (
    receipt.schema !== "supermatrix-immutable-ingress-deployment/v1" ||
    receipt.operationId !== input.operationId ||
    receipt.targetSessionName !== HDQ_RECEIVER_SESSION_NAME ||
    receipt.targetSessionId !== target.id ||
    !Number.isSafeInteger(receipt.appliedAt) ||
    receipt.appliedAt < 0 ||
    typeof receipt.changed !== "boolean" ||
    !receiptPayload ||
    typeof receiptPayload !== "object" ||
    Array.isArray(receiptPayload) ||
    !Array.isArray(receiptPayload.resultSinks) ||
    !sameDeclaration(targetPayload.immutableIngress, HDQ_RECEIVER_DECLARATION) ||
    !sameDeclaration(receiptPayload.immutableIngress, HDQ_RECEIVER_DECLARATION) ||
    canonicalJson(receiptPayload) !== targetPayloadCanonical ||
    !/^[a-f0-9]{64}$/u.test(beforeHash) ||
    !/^[a-f0-9]{64}$/u.test(afterHash) ||
    afterHash !== sha256(targetPayloadCanonical) ||
    receipt.changed !== (beforeHash !== afterHash) ||
    receipt.nonReceiver?.sessionName !== WCA_NON_RECEIVER_SESSION_NAME ||
    receipt.nonReceiver?.sessionId !== nonReceiver.id ||
    receipt.nonReceiver?.immutableIngressAbsent !== true ||
    receipt.nonReceiver?.unchanged !== true ||
    !/^[a-f0-9]{64}$/u.test(receipt.nonReceiver?.capabilityPayloadSha256 ?? "") ||
    receipt.nonReceiver.capabilityPayloadSha256 !== nonReceiverPayloadSha256 ||
    source?.repository !== "SuperMatrix" ||
    source?.script !== "scripts/install-immutable-ingress-receiver.ts" ||
    typeof source?.commit !== "string" ||
    source.commit.trim().length === 0 ||
    !/^[a-f0-9]{64}$/u.test(source?.declarationSha256 ?? "") ||
    source.declarationSha256 !== sha256(canonicalJson(HDQ_RECEIVER_DECLARATION))
  ) {
    throw new Error("deployment receipt is stale or does not match the committed database state");
  }
}

export function installImmutableIngressReceiver(input: {
  db: Db;
  operationId: string;
  sourceCommit: string;
  targetSessionName?: string;
  nowMs?: number;
  receiptDir?: string;
  beforeReceiptCommit?: () => void;
  publishReceipt?: (input: { tempPath: string; finalPath: string }) => void;
}): ImmutableIngressDeploymentReceipt {
  if ((input.targetSessionName ?? HDQ_RECEIVER_SESSION_NAME) !== HDQ_RECEIVER_SESSION_NAME) {
    throw new Error(`only receiver target ${HDQ_RECEIVER_SESSION_NAME} is supported; WCA is not a receiver`);
  }
  const nowMs = input.nowMs ?? Date.now();
  const target = readSession(input.db, HDQ_RECEIVER_SESSION_NAME);
  const nonReceiver = readSession(input.db, WCA_NON_RECEIVER_SESSION_NAME);
  const targetBefore = parseCapabilityPayload(target.capability_payload, target.name);
  const nonReceiverPayload = parseCapabilityPayload(nonReceiver.capability_payload, nonReceiver.name);
  if (Object.hasOwn(nonReceiverPayload, "immutableIngress") && nonReceiverPayload.immutableIngress != null) {
    throw new Error("refusing to activate immutable ingress for private_workflow_6d0060b18f1258cc: session is not a receiver");
  }

  const receiptPaths = input.receiptDir
    ? {
        finalPath: deploymentReceiptPath(input.receiptDir, input.operationId),
        tempPath: deploymentReceiptTempPath(input.receiptDir, input.operationId),
      }
    : undefined;
  if (receiptPaths) {
    mkdirSync(input.receiptDir!, { recursive: true, mode: 0o700 });
    const finalExists = existsSync(receiptPaths.finalPath);
    const tempExists = existsSync(receiptPaths.tempPath);
    if (finalExists && tempExists) {
      throw new Error("deployment final and temp receipts both exist; refusing ambiguous recovery");
    }
    if (finalExists || tempExists) {
      const existing = readReceiptSync(finalExists ? receiptPaths.finalPath : receiptPaths.tempPath);
      validateReceiptForState(existing.receipt, input, target, targetBefore, nonReceiver);
      if (finalExists) return existing.receipt;
      publishReceiptSync(input.receiptDir!, input.operationId, receiptPaths.tempPath);
      return existing.receipt;
    }
  }

  const existingDeclaration = targetBefore.immutableIngress;
  if (existingDeclaration !== undefined && !isTrackedHdqDeclaration(existingDeclaration)) {
    throw new Error("huodaiduijie already has a different immutable ingress declaration");
  }
  const targetAfter = existingDeclaration !== undefined && sameDeclaration(existingDeclaration, HDQ_RECEIVER_DECLARATION)
    ? targetBefore
    : { ...targetBefore, immutableIngress: HDQ_RECEIVER_DECLARATION };
  const beforeCanonical = canonicalJson(targetBefore);
  const afterCanonical = canonicalJson(targetAfter);
  const update = input.db.prepare(
    "UPDATE sessions SET capability_payload = ? WHERE id = ? AND name = ? AND capability_payload IS ?",
  );
  const apply = input.db.transaction(() => {
    // Always CAS, including the idempotent path. A declaration that was
    // identical when read must still prove that no concurrent writer changed
    // the payload before this activation.
    const result = update.run(afterCanonical, target.id, target.name, target.capability_payload);
    if (result.changes !== 1) throw new Error("huodaiduijie capability_payload changed concurrently");
    const readback = readSession(input.db, HDQ_RECEIVER_SESSION_NAME);
    const readbackPayload = parseCapabilityPayload(readback.capability_payload, readback.name);
    if (!sameDeclaration(readbackPayload.immutableIngress, HDQ_RECEIVER_DECLARATION)) {
      throw new Error("huodaiduijie capability_payload readback does not contain the required declaration");
    }
    const nonReceiverReadback = readSession(input.db, WCA_NON_RECEIVER_SESSION_NAME);
    if (nonReceiverReadback.capability_payload !== nonReceiver.capability_payload) {
      throw new Error("private_workflow_6d0060b18f1258cc capability_payload changed unexpectedly");
    }
    const declarationSha256 = sha256(canonicalJson(HDQ_RECEIVER_DECLARATION));
    const receipt: ImmutableIngressDeploymentReceipt = {
      schema: "supermatrix-immutable-ingress-deployment/v1",
      operationId: input.operationId,
      appliedAt: nowMs,
      targetSessionName: HDQ_RECEIVER_SESSION_NAME,
      targetSessionId: readback.id,
      changed: beforeCanonical !== afterCanonical,
      beforeCapabilityPayloadSha256: sha256(beforeCanonical),
      afterCapabilityPayloadSha256: sha256(canonicalJson(readbackPayload)),
      capabilityPayload: readbackPayload,
      nonReceiver: {
        sessionName: WCA_NON_RECEIVER_SESSION_NAME,
        sessionId: nonReceiverReadback.id,
        capabilityPayloadSha256: sha256(nonReceiverReadback.capability_payload ?? canonicalJson({ resultSinks: [] })),
        unchanged: true,
        immutableIngressAbsent: true,
      },
      source: {
        repository: "SuperMatrix",
        script: "scripts/install-immutable-ingress-receiver.ts",
        commit: input.sourceCommit,
        declarationSha256,
      },
    };
    if (input.receiptDir) {
      stageReceiptSync(input.receiptDir, input.operationId, receipt);
      input.beforeReceiptCommit?.();
    }
    return receipt;
  });
  const receipt = apply();
  if (receiptPaths) {
    input.publishReceipt?.({ tempPath: receiptPaths.tempPath, finalPath: receiptPaths.finalPath });
    publishReceiptSync(input.receiptDir!, input.operationId, receiptPaths.tempPath);
  }
  return receipt;
}

function requiredFlag(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes("--apply")) {
    throw new Error("refusing to mutate without --apply");
  }
  const target = requiredFlag(args, "--target");
  if (target !== HDQ_RECEIVER_SESSION_NAME) {
    throw new Error(`only receiver target ${HDQ_RECEIVER_SESSION_NAME} is supported; WCA is not a receiver`);
  }
  const runtimeRoot = resolve(process.env.SM_RUNTIME_ROOT?.trim() || "/Users/LOCAL_USER/SuperMatrixRuntime");
  const dbPath = resolve(process.env.SM_DB_PATH?.trim() || join(runtimeRoot, "data", "supermatrix.db"));
  const operationId = args.includes("--operation-id")
    ? requiredFlag(args, "--operation-id")
    : `immutable-ingress-${Date.now()}`;
  if (!/^[A-Za-z0-9._-]+$/u.test(operationId)) throw new Error("operation id contains unsafe characters");
  const receiptDir = resolve(process.env.SM_IMMUTABLE_INGRESS_RECEIPT_DIR?.trim() || join(runtimeRoot, "data", "immutable-ingress-deployments"));
  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = resolve(dirname(scriptPath), "..");
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const db = new Database(dbPath, { fileMustExist: true, timeout: 5_000 });
  db.pragma("foreign_keys = ON");
  try {
    const receipt = installImmutableIngressReceiver({ db: db as unknown as Db, operationId, sourceCommit, receiptDir });
    const receiptPath = deploymentReceiptPath(receiptDir, operationId);
    console.log(JSON.stringify({ ...receipt, receiptPath }, null, 2));
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
