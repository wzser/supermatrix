import type { CreationReviewStore, CreationReview } from "./creationReviewStore.js";

export type RunDecisionPollTickOpts = {
  store: CreationReviewStore;
  staleAfterMs: number;
  nowMs?: number;
  notifyOwnerFn?: (expired: CreationReview[]) => Promise<void>;
};

export type DecisionPollResult = {
  expired: number;
  expiredReviewIds: string[];
};

export async function runDecisionPollTick(
  opts: RunDecisionPollTickOpts,
): Promise<DecisionPollResult> {
  const now = opts.nowMs ?? Date.now();
  const dispatched = opts.store.listByStatus("dispatched");
  const expired: CreationReview[] = [];

  for (const review of dispatched) {
    const dispatchedAt = review.dispatchedAt;
    if (dispatchedAt === null) continue;
    if (now - dispatchedAt >= opts.staleAfterMs) {
      opts.store.decide(review.id, {
        status: "expired",
        reason: `scheduler session did not reply within ${opts.staleAfterMs}ms`,
      });
      expired.push(review);
    }
  }

  if (opts.notifyOwnerFn && expired.length > 0) {
    try {
      await opts.notifyOwnerFn(expired);
    } catch {
      // best-effort: swallow notification errors
    }
  }

  return {
    expired: expired.length,
    expiredReviewIds: expired.map((r) => r.id),
  };
}
