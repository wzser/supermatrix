import type { TaskClass } from "../classes/types.js";

export type MigrationAction = "CONFIRM" | "MODIFY" | "LATER" | "DISABLE" | "REJECT";

export type MigrationProposalStatus = "pending" | "replied" | "default_applied";

export type MigrationProposal = {
  id: string;
  taskId: string;
  ownerSession: string;
  status: MigrationProposalStatus;
  childSessionId: string | null;
  spawnedAt: number;
  repliedAt: number | null;
  replyAction: MigrationAction | null;
  replyRaw: string | null;
  defaultAppliedAt: number | null;
  suggestedClass: TaskClass;
  suggestedExpectedDurationMs: number;
};
