import type { TaskClass, DimensionValues } from "./types.js";

export const CLASS_DEFAULTS: Record<TaskClass, DimensionValues> = {
  sync_job: {
    kind: "script",
    weight: "heavy",
    idempotency: "pure",
    receiptProof: { kind: "external_evidence", engine: "sqlite", target: {}, expectation: ">= 1" },
    notify: {
      trigger_failed: { channel: "ownerDM" },
      receipt_missing: { channel: "ownerDM" },
      succeeded: { channel: "none" },
    },
  },
  publication: {
    kind: "script",
    weight: "heavy",
    idempotency: "non",
    receiptProof: { kind: "external_evidence", engine: "sqlite", target: {}, expectation: ">= 1" },
    notify: {
      trigger_failed: { channel: "ownerDM" },
      receipt_missing: { channel: "ownerDM" },
      succeeded: { channel: "none" },
    },
  },
  monitoring: {
    kind: "script",
    weight: "light",
    idempotency: "conditional",
    receiptProof: { kind: "exit_zero" },
    notify: {
      trigger_failed: { channel: "ownerDM" },
      receipt_missing: { channel: "none" },
      succeeded: { channel: "none" },
    },
  },
  delegation: {
    kind: "session",
    weight: "heavy",
    idempotency: "non",
    receiptProof: { kind: "session_reply_content_check", pattern: "REPORT:", patternType: "contains", timeoutMs: 300000 },
    notify: {
      trigger_failed: { channel: "ownerDM" },
      receipt_missing: { channel: "ownerDM" },
      succeeded: { channel: "none" },
    },
  },
  notification: {
    kind: "session",
    weight: "light",
    idempotency: "non",
    receiptProof: { kind: "session_reply_present", timeoutMs: 300000 },
    notify: {
      trigger_failed: { channel: "ownerDM" },
      receipt_missing: { channel: "none" },
      succeeded: { channel: "none" },
    },
  },
};
