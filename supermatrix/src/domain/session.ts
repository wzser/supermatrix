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

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "ultracode";

export const CLAUDE_FABLE_5_MODEL = "claude-fable-5";

/** `fable` is retained only for pre-canonicalized local session rows. */
export function isVerifiedClaudeFableModel(model: string | null | undefined): boolean {
  const normalized = model?.trim();
  return normalized === CLAUDE_FABLE_5_MODEL || normalized === "fable";
}

// Closed enum for `sessions.category` per FP v1.1 contract
// (workspaces/first-principle/rules/session-meta-fields.md §3). Empty string is
// the "not categorised" state, allowed for child sessions and pre-categorisation
// transient state. Any other value is rejected at write time.
// "外部" added in v1.1 for external-group sessions with strict non-owner trust boundary.
// "员工" is for employee daily-work sessions; init marks them out of FP and heartbeat.
export const SESSION_CATEGORIES = ["", "业务", "平台", "工具", "知识", "外部", "员工"] as const;
export type SessionCategory = (typeof SESSION_CATEGORIES)[number];

/**
 * Resolves `child_<parent>_<suffix>` back to the top-level owner session name,
 * recursively for nested children. Non-child names pass through unchanged.
 *
 * Lives in domain because several boundaries need the identical rule (notify
 * default-chat resolution, caller provenance); a second copy that drifts would
 * attribute work to the wrong owner.
 */
export function resolveOwnerSessionName(name: string): string {
  let owner = name;
  while (owner.startsWith("child_")) {
    const rest = owner.slice("child_".length);
    const suffixSeparator = rest.lastIndexOf("_");
    if (suffixSeparator <= 0) break;
    owner = rest.slice(0, suffixSeparator);
  }
  return owner;
}

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
  effortLocked?: boolean;
  workdir: AbsolutePath;
  backendSessionId: string | null;
  /** Last time the current main backend thread itself was extended. */
  backendSessionUpdatedAt?: Timestamp | null;
  chatName: string | null;
  purpose: string;
  status: SessionStatus;
  // Governance ownership for addressable user sessions. This is distinct from
  // parentId, which is reserved for runtime child-session lifecycle/cascade.
  affiliatedTo?: string | null;
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
