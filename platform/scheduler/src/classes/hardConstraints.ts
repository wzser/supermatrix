import type { TaskClass, DimensionValues } from "./types.js";

export type ConstraintResult = { ok: true } | { ok: false; reason: string };

export function checkHardConstraints(
  taskClass: TaskClass,
  overrides: Partial<DimensionValues> | null | undefined
): ConstraintResult {
  if (!overrides) return { ok: true };

  // monitoring: receipt_missing notification must not be ownerDM
  // Reason: business-level alerts are the script's responsibility, not scheduler's.
  if (taskClass === "monitoring" && overrides.notify?.receipt_missing?.channel === "ownerDM") {
    return {
      ok: false,
      reason: "class=monitoring cannot override notify.receipt_missing to ownerDM; business alerts are the script's responsibility, not scheduler's",
    };
  }

  // delegation: receiptProof must be session-reply based (the whole point of delegation
  // is verifying session reply content, not exit_zero / external_evidence)
  if (taskClass === "delegation" && overrides.receiptProof) {
    const kind = overrides.receiptProof.kind;
    if (kind !== "session_reply_present" && kind !== "session_reply_content_check") {
      return {
        ok: false,
        reason: `class=delegation requires receiptProof.kind to be session_reply_present or session_reply_content_check; got ${kind}`,
      };
    }
  }

  return { ok: true };
}
