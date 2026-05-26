import type { SessionId } from "./ids.ts";

export const CHILD_SESSION_TYPES = [
  "one_shot_delegation",
  "ephemeral_conversation",
  "event_awaited_worker",
  "user_voice_reporter",
  "event_publisher",
] as const;
export type ChildSessionType = (typeof CHILD_SESSION_TYPES)[number];

export const TRIGGER_KINDS = [
  "session",
  "human",
  "watchdog",
  "scheduler",
  "skill_master",
  "eventbus_subscriber",
  "self_curl",
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const POST_IDENTITIES = ["bot", "user", "caller_default"] as const;
export type PostIdentity = (typeof POST_IDENTITIES)[number];

export const CALLER_INVOCATIONS = ["sync_inline", "async_kickoff", "fire_and_forget"] as const;
export type CallerInvocation = (typeof CALLER_INVOCATIONS)[number];

export const CONTINUATION_HOOKS = ["none", "inject_result"] as const;
export type ContinuationHook = (typeof CONTINUATION_HOOKS)[number];

export type ChatRef =
  | { kind: "parent" }
  | { kind: "requester" }
  | { kind: "reply_to" }
  | { kind: "explicit"; chatId: string };

export type ResultSink =
  | { kind: "http_response" }
  | { kind: "pollable_endpoint" }
  | { kind: "chat_post"; chatRef: ChatRef; identity: "bot" | "user" }
  | { kind: "eventbus_publish"; topic: string }
  | { kind: "parent_continuation_inject"; parentSessionId: SessionId }
  | { kind: "audit_only" };

export type EventBusContract = {
  subscribe: string | null;
  subscribeGatesCompletion: boolean;
};

export type CapabilityPayload = {
  resultSinks: ResultSink[];
  eventBusContract?: EventBusContract;
};

export function isChildSessionType(value: unknown): value is ChildSessionType {
  return typeof value === "string" && (CHILD_SESSION_TYPES as readonly string[]).includes(value);
}

export function isTriggerKind(value: unknown): value is TriggerKind {
  return typeof value === "string" && (TRIGGER_KINDS as readonly string[]).includes(value);
}

export function isPostIdentity(value: unknown): value is PostIdentity {
  return typeof value === "string" && (POST_IDENTITIES as readonly string[]).includes(value);
}

export function isCallerInvocation(value: unknown): value is CallerInvocation {
  return typeof value === "string" && (CALLER_INVOCATIONS as readonly string[]).includes(value);
}

export function isContinuationHook(value: unknown): value is ContinuationHook {
  return typeof value === "string" && (CONTINUATION_HOOKS as readonly string[]).includes(value);
}
