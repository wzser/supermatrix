import type { CreationReviewStore } from "./creationReviewStore.js";
import type { buildProposalText } from "./proposalText.js";
import type { InboxPredicate } from "../spawn/predicate.js";
import { inboxPredicate, DECISION_TOKENS } from "../spawn/predicate.js";

export type SpawnFn = (params: {
  target: string;
  from: string;
  prompt: string;
  verification_predicate: InboxPredicate;
}) => Promise<{ ok: boolean; error?: string }>;

export type RunCreationReviewTickOpts = {
  store: CreationReviewStore;
  spawnFn: SpawnFn;
  proposalTextBuilder: typeof buildProposalText;
  batchThreshold: number;
  maxAgeMs: number;
  nowMs?: number;
  selfTarget?: string;
  fromSession?: string;
};

export type TickResult = {
  dispatched: number;
  reviewIds: string[];
  skipReason?: "below_threshold" | "spawn_failed" | "empty";
};

export async function runCreationReviewTick(
  opts: RunCreationReviewTickOpts,
): Promise<TickResult> {
  const {
    store,
    spawnFn,
    proposalTextBuilder,
    batchThreshold,
    maxAgeMs,
    nowMs = Date.now(),
    selfTarget = "scheduler",
    fromSession = "scheduler",
  } = opts;

  const pending = store.listPending(50);
  if (pending.length === 0) {
    return { dispatched: 0, reviewIds: [], skipReason: "empty" };
  }

  const oldest = pending[0];
  const oldestAge = nowMs - oldest.createdAt;
  const shouldDispatch =
    pending.length >= batchThreshold || oldestAge >= maxAgeMs;

  const reviewIds = pending.map((r) => r.id);

  if (!shouldDispatch) {
    return { dispatched: 0, reviewIds, skipReason: "below_threshold" };
  }

  const prompt = proposalTextBuilder({ reviews: pending });
  const result = await spawnFn({
    target: selfTarget,
    from: fromSession,
    prompt,
    verification_predicate: inboxPredicate({
      sessionName: selfTarget,
      tokens: DECISION_TOKENS,
    }),
  });

  if (!result.ok) {
    return { dispatched: 0, reviewIds, skipReason: "spawn_failed" };
  }

  for (const r of pending) {
    store.markDispatched(r.id);
  }

  return { dispatched: pending.length, reviewIds };
}
