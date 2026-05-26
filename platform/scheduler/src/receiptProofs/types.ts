export type ProofContext = {
  exitCode?: number | null;
  httpStatus?: number;
  sessionReply?: unknown;
  childSessionId?: string | null;
  asyncRef?: string | null;
  smBaseUrl?: string;
  fetchImpl?: typeof fetch;
  taskId: string;
  runId: string;
  triggeredAt: number;
};

export type ProofResult = {
  passed: boolean;
  retriable: boolean;
  evidence: Record<string, unknown>;
};
