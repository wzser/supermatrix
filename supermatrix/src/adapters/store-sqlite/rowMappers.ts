import type {
  CallerInvocation,
  CapabilityPayload,
  ChildSessionType,
  ContinuationHook,
  PostIdentity,
  TriggerKind,
} from "../../domain/childCapabilities.ts";
import {
  isCallerInvocation,
  isChildSessionType,
  isContinuationHook,
  isPostIdentity,
  isTriggerKind,
} from "../../domain/childCapabilities.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../domain/ids.ts";
import type { Session, SessionCategory } from "../../domain/session.ts";
import { SESSION_CATEGORIES } from "../../domain/session.ts";
import type { EffortLevel } from "../../domain/session.ts";
import type { Scope } from "../../domain/scope.ts";

export type SessionRow = {
  id: string;
  name: string;
  alias: string;
  avatar: string;
  category: string;
  fp_managed: number | null;
  scope: string;
  backend: string;
  model: string | null;
  effort: string | null;
  thinking: number;
  model_locked: number;
  workdir: string;
  backend_session_id: string | null;
  chat_name: string | null;
  purpose: string;
  status: string;
  parent_id: string | null;
  depth: number;
  inactivity_timeout_s: number | null;
  max_runtime_s: number | null;
  child_type: string | null;
  trigger_kind: string | null;
  post_identity: string | null;
  caller_invocation: string | null;
  continuation_hook: string | null;
  capability_payload: string | null;
  created_at: unknown;
  updated_at: unknown;
};

const warnedInvalidSessionTimestamps = new Set<string>();
const warnedInvalidCapabilityPayloads = new Set<string>();

function parseCapabilityPayload(raw: string | null, sessionId: string): CapabilityPayload | null {
  if (!raw) return null;
  const warn = (reason: string) => {
    const warnKey = `${sessionId}:${reason}:${raw.slice(0, 120)}`;
    if (warnedInvalidCapabilityPayloads.has(warnKey)) return;
    warnedInvalidCapabilityPayloads.add(warnKey);
    console.warn(
      `[store-sqlite] invalid sessions.capability_payload for session ${sessionId}; using null`,
      { sessionId, reason, valueLength: raw.length },
    );
  };
  try {
    const parsed = JSON.parse(raw) as CapabilityPayload;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.resultSinks)) {
      warn("missing resultSinks array");
      return null;
    }
    return parsed;
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
    return null;
  }
}

function coerceCategory(raw: string | null | undefined): SessionCategory {
  // Forward-compatible read: unknown values surface as '' so a stray DB row
  // can never crash readers. Write-time validation in the adapter is the
  // canonical guard against bad values getting in.
  const value = raw ?? "";
  return (SESSION_CATEGORIES as readonly string[]).includes(value)
    ? (value as SessionCategory)
    : "";
}

function coerceFpManaged(raw: number | null | undefined): boolean | null {
  // Only the explicit 0/1 SQLite booleans map to a verdict. NULL (unmarked) and
  // undefined (column absent — the optional migration degraded) both surface as
  // null so the session stays in-scope by default.
  if (raw === 1) return true;
  if (raw === 0) return false;
  return null;
}

function coerceSessionTimestamp(row: SessionRow, column: "created_at" | "updated_at") {
  const value = row[column];
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return asTimestamp(value);
  }

  const fallback = Date.now();
  const warnKey = `${row.id}:${column}:${String(value)}`;
  if (!warnedInvalidSessionTimestamps.has(warnKey)) {
    warnedInvalidSessionTimestamps.add(warnKey);
    console.warn(
      `[store-sqlite] invalid sessions.${column} for session ${row.id}; using Date.now() fallback`,
      { value, fallback },
    );
  }
  return asTimestamp(fallback);
}

export function rowToSession(row: SessionRow): Session {
  return {
    id: asSessionId(row.id),
    name: row.name,
    alias: row.alias ?? "",
    avatar: row.avatar ?? "",
    category: coerceCategory(row.category),
    fpManaged: coerceFpManaged(row.fp_managed),
    scope: row.scope as Scope,
    backend: row.backend as Session["backend"],
    model: row.model,
    effort: row.effort as EffortLevel | null,
    thinking: row.thinking === 1,
    modelLocked: row.model_locked === 1,
    workdir: asAbsolutePath(row.workdir),
    backendSessionId: row.backend_session_id,
    chatName: row.chat_name ?? null,
    purpose: row.purpose,
    status: row.status as Session["status"],
    parentId: row.parent_id ? asSessionId(row.parent_id) : null,
    depth: row.depth,
    inactivityTimeoutS: row.inactivity_timeout_s,
    maxRuntimeS: row.max_runtime_s,
    childType: isChildSessionType(row.child_type) ? (row.child_type as ChildSessionType) : null,
    triggerKind: isTriggerKind(row.trigger_kind) ? (row.trigger_kind as TriggerKind) : null,
    postIdentity: isPostIdentity(row.post_identity) ? (row.post_identity as PostIdentity) : null,
    callerInvocation: isCallerInvocation(row.caller_invocation)
      ? (row.caller_invocation as CallerInvocation)
      : null,
    continuationHook: isContinuationHook(row.continuation_hook)
      ? (row.continuation_hook as ContinuationHook)
      : null,
    capabilityPayload: parseCapabilityPayload(row.capability_payload, row.id),
    createdAt: coerceSessionTimestamp(row, "created_at"),
    updatedAt: coerceSessionTimestamp(row, "updated_at"),
  };
}
