import { CLASS_DEFAULTS } from "./defaults.js";
import type { TaskClass, DimensionValues, ReceiptProof } from "./types.js";

// Returns true when the class default sqlite proof has no target configured —
// the symptom of the known sync_job/publication footgun where a task is
// created without overrides.receiptProof, causing an evidence_missing retry loop.
function isUnconfiguredSqliteDefault(proof: ReceiptProof): boolean {
  return (
    proof.kind === "external_evidence" &&
    proof.engine === "sqlite" &&
    (typeof (proof.target as Record<string, unknown>).db !== "string" ||
      typeof (proof.target as Record<string, unknown>).sql !== "string")
  );
}

export function resolveOverrides(
  taskClass: TaskClass,
  overrides: Partial<DimensionValues> | null | undefined
): DimensionValues {
  const defaults = CLASS_DEFAULTS[taskClass];
  const ov = overrides ?? {};

  let receiptProof: ReceiptProof;
  if (ov.receiptProof != null) {
    receiptProof = { ...ov.receiptProof } as ReceiptProof;
  } else if (isUnconfiguredSqliteDefault(defaults.receiptProof)) {
    // No override provided and class default sqlite has no target — fall back
    // to exit_zero to prevent evidence_missing retry loops on unconfigured tasks.
    receiptProof = { kind: "exit_zero" };
  } else {
    receiptProof = { ...defaults.receiptProof } as ReceiptProof;
  }

  return {
    kind: ov.kind ?? defaults.kind,
    weight: ov.weight ?? defaults.weight,
    idempotency: ov.idempotency ?? defaults.idempotency,
    receiptProof,
    notify: {
      trigger_failed: { ...defaults.notify.trigger_failed, ...(ov.notify?.trigger_failed ?? {}) },
      receipt_missing: { ...defaults.notify.receipt_missing, ...(ov.notify?.receipt_missing ?? {}) },
      succeeded: { ...defaults.notify.succeeded, ...(ov.notify?.succeeded ?? {}) },
    },
  };
}
