export type HealAction = "RETRY" | "SKIP" | "DISABLE" | "ADJUST" | "REJECT";

export type HealProposalStatus = "pending" | "replied" | "default_applied" | "pending_retry";

export type HealProposal = {
  id: string;
  taskId: string;
  runId: string;
  reason: string;
  spawnedAt: number;
  childSessionId: string | null;
  status: HealProposalStatus;
  spawnRetryCount: number;
  replyAction: HealAction | null;
  replyRaw: string | null;
  repliedAt: number | null;
  defaultAppliedAt: number | null;
};
