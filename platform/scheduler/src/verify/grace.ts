import type { ProofResult } from "../receiptProofs/types.js";

export const GRACE_MAX_ATTEMPTS = 3;
export const GRACE_INTERVAL_MS = 30 * 60 * 1000;

export type GraceAction =
  | { kind: "finalize_success" }
  | { kind: "finalize_evidence_missing" }
  | { kind: "reschedule"; dueAt: number };

export function computeGraceAction(
  proof: ProofResult,
  currentAttempts: number,
  now: number
): GraceAction {
  if (proof.passed) return { kind: "finalize_success" };
  if (!proof.retriable) return { kind: "finalize_evidence_missing" };
  if (currentAttempts >= GRACE_MAX_ATTEMPTS) return { kind: "finalize_evidence_missing" };
  return { kind: "reschedule", dueAt: now + GRACE_INTERVAL_MS };
}
