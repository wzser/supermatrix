import type {
  CallerInvocation,
  CapabilityPayload,
  ChildSessionType,
  ContinuationHook,
  PostIdentity,
  TriggerKind,
} from "./childCapabilities.ts";
import type { AbsolutePath, SessionId, Timestamp } from "./ids.ts";
import type { Scope } from "./scope.ts";

export type SessionStatus =
  | "initializing"
  | "idle"
  | "busy"
  | "waiting"
  | "error"
  | "deleted";

// `waiting` is reserved for `event_awaited_worker` child sessions that have
// finished their first run and are holding open a TopicBus subscription until
// either the gating event arrives or maxRuntime expires. It's distinct from
// `busy` (a backend stream is actively running) and `idle` (the row is
// re-runnable for ephemeral conversations). The DB column is TEXT so no
// migration is needed — only restart reconciliation needed to handle it
// (see store-sqlite.resetBusySessionsOnBoot).

export type BackendKind = "claude" | "codex" | "kimi";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

// Closed enum for `sessions.category` per FP v1.1 contract
// (workspaces/first-principle/rules/session-meta-fields.md §3). Empty string is
// the "not categorised" state, allowed for child sessions and pre-categorisation
// transient state. Any other value is rejected at write time.
// "外部" added in v1.1 for external-group sessions with strict non-owner trust boundary.
export const SESSION_CATEGORIES = ["", "业务", "平台", "工具", "知识", "外部"] as const;
export type SessionCategory = (typeof SESSION_CATEGORIES)[number];

export type Session = {
  id: SessionId;
  name: string;
  alias: string;
  avatar: string;
  category: SessionCategory;
  // FP-governance scope flag, sourced from the Feishu Bitable 'FP管辖' checkbox
  // (FP's sync-session-table.sh, pull direction). null = unmarked, treated as
  // in-scope; false = explicitly out of FP governance scope; true = in scope.
  fpManaged: boolean | null;
  scope: Scope;
  backend: BackendKind;
  model: string | null;
  effort: EffortLevel | null;
  thinking: boolean;
  modelLocked: boolean;
  workdir: AbsolutePath;
  backendSessionId: string | null;
  chatName: string | null;
  purpose: string;
  status: SessionStatus;
  parentId: SessionId | null;
  depth: number;
  inactivityTimeoutS: number | null;
  maxRuntimeS: number | null;
  childType: ChildSessionType | null;
  triggerKind: TriggerKind | null;
  postIdentity: PostIdentity | null;
  callerInvocation: CallerInvocation | null;
  continuationHook: ContinuationHook | null;
  capabilityPayload: CapabilityPayload | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
