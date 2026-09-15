import { randomUUID } from "node:crypto";
import { readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  defaultCallerAttestationRegistry,
  type CallerAttestation,
} from "../domain/callerAttestation.ts";
import { resolveOwnerSessionName } from "../domain/session.ts";

const RELOAD_PERMIT_RE = /^smrp_[a-f0-9]{32}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
const MAX_PERMIT_AGE_MS = 120_000;
const MAX_CLOCK_SKEW_MS = 60_000;

type StoredReloadPermit = {
  version?: unknown;
  operation?: unknown;
  nonce?: unknown;
  requestedAtMs?: unknown;
  source?: unknown;
  force?: unknown;
  actorSessionName?: unknown;
  callerSessionId?: unknown;
  callerAttestationToken?: unknown;
};

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Atomically claims and validates the one-shot permit named by the reload
 * command. A wrong nonce addresses no file, so it cannot consume the real
 * permit. Once the exact file is claimed, every outcome is terminal.
 */
export async function consumePlatformReloadPermit(input: {
  dbPath: string;
  nonce: string;
  source: string;
  force: boolean;
  nowMs?: number;
  resolveCallerAttestation?: (token: string) => CallerAttestation | null;
}): Promise<false | { callerRunId: string; callerSessionId: string }> {
  if (!RELOAD_PERMIT_RE.test(input.nonce)) return false;

  const permitPath = join(dirname(input.dbPath), `.supermatrix-reload-permit.${input.nonce}.json`);
  const claimedPath = `${permitPath}.consumed.${process.pid}.${randomUUID()}`;
  try {
    await rename(permitPath, claimedPath);
  } catch (error) {
    if (isMissingFile(error)) return false;
    return false;
  }

  try {
    const raw = await readFile(claimedPath, "utf8");
    const permit = JSON.parse(raw) as StoredReloadPermit;
    const nowMs = input.nowMs ?? Date.now();
    const requestedAtMs = permit.requestedAtMs;
    const ageMs = typeof requestedAtMs === "number" ? nowMs - requestedAtMs : Number.NaN;
    const callerAttestationToken = permit.callerAttestationToken;
    const attestation = typeof callerAttestationToken === "string"
      ? (input.resolveCallerAttestation ?? defaultCallerAttestationRegistry.resolve)(callerAttestationToken)
      : null;

    const valid = permit.version === 1
      && permit.operation === "reload-supermatrix"
      && permit.nonce === input.nonce
      && permit.source === input.source
      && permit.force === input.force
      && permit.actorSessionName === "codexroot"
      && typeof permit.callerSessionId === "string"
      && SESSION_ID_RE.test(permit.callerSessionId)
      && attestation !== null
      && resolveOwnerSessionName(attestation.sessionName) === "codexroot"
      && attestation.sessionId === permit.callerSessionId
      && Number.isFinite(ageMs)
      && ageMs >= -MAX_CLOCK_SKEW_MS
      && ageMs <= MAX_PERMIT_AGE_MS;
    return valid
      ? {
          callerRunId: attestation.messageRunId,
          callerSessionId: attestation.sessionId,
        }
      : false;
  } catch {
    return false;
  } finally {
    await unlink(claimedPath).catch(() => undefined);
  }
}
