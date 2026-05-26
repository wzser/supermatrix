export type TaskClass = "sync_job" | "publication" | "monitoring" | "delegation" | "notification";
export type Kind = "script" | "session";
export type Weight = "heavy" | "light";
export type Idempotency = "pure" | "non" | "conditional";

export type ReceiptProof =
  | { kind: "exit_zero" }
  | { kind: "http_2xx" }
  | { kind: "session_reply_present"; timeoutMs: number }
  | { kind: "session_reply_content_check"; pattern: string; patternType: "contains" | "regex" | "json_path"; timeoutMs: number }
  | { kind: "external_evidence"; engine: "sqlite" | "bitable" | "file" | "http_get"; target: Record<string, unknown>; expectation: string };

export type NotifyChannel = "none" | "ownerDM" | "userDM" | "customChat";
export type NotifyRule = {
  channel: NotifyChannel;
  target?: string;
  dedup?: { key: string; windowMin: number };
};

export type NotifyEvent = "trigger_failed" | "receipt_missing" | "succeeded";

export type DimensionValues = {
  kind: Kind;
  weight: Weight;
  idempotency: Idempotency;
  receiptProof: ReceiptProof;
  notify: Record<NotifyEvent, NotifyRule>;
};
