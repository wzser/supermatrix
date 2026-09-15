import type { SessionId, Timestamp } from "./ids.ts";

export const MAIN_BRANCH_NAME = "main";

const BRANCH_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/u;

export type SessionBranchRecord = {
  sessionId: SessionId;
  name: string;
  backendSessionId: string | null;
  sourceBranchName: string | null;
  sourceBackendSessionId: string | null;
  forkPending: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type NewSessionBranchInput = {
  sessionId: SessionId;
  name: string;
  backendSessionId?: string | null;
  sourceBranchName?: string | null;
  sourceBackendSessionId?: string | null;
  forkPending?: boolean;
  createdAt: Timestamp;
};

export function validateBranchName(name: string): string {
  const normalized = name.trim();
  if (!BRANCH_NAME_RE.test(normalized)) {
    throw new Error("branch name must match /^[a-z0-9][a-z0-9_-]{0,39}$/");
  }
  return normalized;
}
