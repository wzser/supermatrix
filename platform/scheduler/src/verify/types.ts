export type VerificationStatus = "pending" | "done";

export type PendingVerification = {
  id: string;
  runId: string;
  dueAt: number;
  attempts: number;
  status: VerificationStatus;
  createdAt: number;
};
