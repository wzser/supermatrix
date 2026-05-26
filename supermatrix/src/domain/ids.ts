export type SessionId = string & { readonly __brand: "SessionId" };
export type LarkGroupId = string & { readonly __brand: "LarkGroupId" };
export type AbsolutePath = string & { readonly __brand: "AbsolutePath" };
export type Timestamp = number & { readonly __brand: "Timestamp" };
export type CardId = string & { readonly __brand: "CardId" };
export type MessageRunId = string & { readonly __brand: "MessageRunId" };

export function asSessionId(value: string): SessionId {
  if (!value) throw new Error("SessionId must be non-empty");
  return value as SessionId;
}

export function asLarkGroupId(value: string): LarkGroupId {
  if (!value) throw new Error("LarkGroupId must be non-empty");
  return value as LarkGroupId;
}

export function asAbsolutePath(value: string): AbsolutePath {
  if (!value.startsWith("/")) throw new Error(`AbsolutePath must start with /: ${value}`);
  return value as AbsolutePath;
}

export function asTimestamp(value: number): Timestamp {
  if (!Number.isFinite(value)) throw new Error("Timestamp must be a finite number");
  return value as Timestamp;
}

export function asCardId(value: string): CardId {
  if (!value) throw new Error("CardId must be non-empty");
  return value as CardId;
}

export function asMessageRunId(value: string): MessageRunId {
  if (!value) throw new Error("MessageRunId must be non-empty");
  return value as MessageRunId;
}
