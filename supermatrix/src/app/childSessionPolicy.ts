import type { ChildSessionType } from "../domain/childCapabilities.ts";

/**
 * Per-type policy values for child sessions.
 *
 * Step 4 of the scenario-driven redesign plan centralizes what used to be
 * scattered hardcoded constants. Existing values for the two live types are
 * preserved exactly — refactor, not behavior change. New types (step 8 / 9)
 * will read their policy from this table once they start running.
 */
export type ChildSessionPolicy = {
  /** Max simultaneously busy children per parent for this type. Default 5. */
  maxBusyChildrenPerParent: number;
  /**
   * Max idle children per parent for this type. Only meaningful for types
   * with runCardinality=multi_run (ephemeral_conversation). 0 = no idle
   * bucket (one_shot_delegation terminates on first completion).
   */
  maxIdleChildrenPerParent: number;
  /** Single-run hard timeout in seconds. */
  maxRuntimeSec: number;
  /**
   * Cutoff (seconds since updated_at) beyond which idle/error rows are
   * cleaned up by the periodic cleanup path. Used by
   * `cleanupStaleChildSessions`.
   */
  staleIdleTtlSec: number;
  /** Max chain depth from root. Default 3. */
  maxDepth: number;
};

const DEFAULT_POLICY: ChildSessionPolicy = {
  maxBusyChildrenPerParent: 5,
  maxIdleChildrenPerParent: 0,
  maxRuntimeSec: 30 * 60,
  staleIdleTtlSec: 60 * 60,
  maxDepth: 3,
};

// Step 4 mandate: behavior for existing two types stays byte-equivalent to
// pre-refactor. The tighter caps decisions.md D8 calls for
// (ephemeral.maxBusy=2, maxIdle=10, maxDepth=1) are deferred to a later
// change so that anyone currently running >2 concurrent /btw or nested /btw
// is not silently rejected during this refactor. New types get fresh values.
const POLICY_TABLE: Record<ChildSessionType, ChildSessionPolicy> = {
  one_shot_delegation: {
    ...DEFAULT_POLICY,
  },
  ephemeral_conversation: {
    ...DEFAULT_POLICY,
    // DEFERRED from decisions.md D8: maxBusy 5→2, maxIdle 0→10, maxDepth 3→1,
    // staleIdleTtl 60m→10m, maxRuntime 30m→10m. Land as its own change with
    // migration notes.
  },
  event_awaited_worker: {
    ...DEFAULT_POLICY,
    maxRuntimeSec: 60 * 60,
  },
  user_voice_reporter: {
    ...DEFAULT_POLICY,
    maxRuntimeSec: 10 * 60,
  },
  event_publisher: {
    ...DEFAULT_POLICY,
    maxRuntimeSec: 10 * 60,
  },
};

// D8: DEFAULT_POLICY.maxRuntimeSec is env-tunable via SM_CHILD_MAX_RUNTIME_SEC.
// Types that explicitly override maxRuntimeSec (event_awaited_worker,
// user_voice_reporter, event_publisher) keep their explicit values; only
// types inheriting DEFAULT_POLICY.maxRuntimeSec pick up the env override.
// Read on every call so tests can set env and observe without module reload.
function readMaxRuntimeEnvOverride(): number | null {
  const raw = process.env.SM_CHILD_MAX_RUNTIME_SEC;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function applyEnvOverride(base: ChildSessionPolicy): ChildSessionPolicy {
  if (base.maxRuntimeSec !== DEFAULT_POLICY.maxRuntimeSec) return base;
  const override = readMaxRuntimeEnvOverride();
  if (override === null) return base;
  return { ...base, maxRuntimeSec: override };
}

export function policyForType(type: ChildSessionType): ChildSessionPolicy {
  return applyEnvOverride(POLICY_TABLE[type]);
}

/**
 * When we only know the type string may or may not be set (e.g. historical
 * rows pre-migration), fall back to the default policy.
 */
export function policyForTypeOrDefault(
  type: ChildSessionType | null | undefined,
): ChildSessionPolicy {
  return applyEnvOverride(type ? POLICY_TABLE[type] : DEFAULT_POLICY);
}
