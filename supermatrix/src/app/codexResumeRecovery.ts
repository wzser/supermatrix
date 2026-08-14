import { isCodexArrayParamResumeError } from "../domain/backendResumeErrors.ts";
import type { MessageRun } from "../ports/BindingStore.ts";
import type { BindingStore } from "../ports/BindingStore.ts";
import type { SessionId, Timestamp } from "../domain/ids.ts";
import { MAIN_BRANCH_NAME } from "../domain/sessionBranch.ts";

export type CodexResumeRecoveryBackupInput = {
  sessionId: SessionId;
  branchName: string;
  failedRunId: string;
  errorClass: "array_above_max_length";
};

export type CodexResumeRecoveryBackup = (
  input: CodexResumeRecoveryBackupInput,
) => Promise<{ snapshotPath: string; receiptPath: string }>;

export type CodexResumeRecoveryResult =
  | { status: "not_eligible"; reason: "not_codex" | "not_main_branch" | "no_persisted_resume" | "not_poison_error" }
  | { status: "not_repeated"; recentRuns: MessageRun[] }
  | { status: "backup_unavailable" }
  | { status: "backup_failed"; error: unknown }
  | { status: "cleared"; snapshotPath: string; receiptPath: string }
  | { status: "clear_failed"; error: unknown; snapshotPath: string; receiptPath: string };

/**
 * Clear a poisoned Codex main resume only after two consecutive persisted
 * runs prove the same pre-tool history error. The backup callback is required
 * for this recovery class: if it is not wired or fails, the resume pointer is
 * preserved and the caller can surface the original failure.
 */
export async function recoverRepeatedCodexResume(input: {
  store: BindingStore;
  sessionId: SessionId;
  branchName: string;
  backend: string;
  persistedBackendSessionId: string | null;
  failedRunId: string;
  error: string | undefined;
  now: Timestamp;
  backup?: CodexResumeRecoveryBackup;
}): Promise<CodexResumeRecoveryResult> {
  if (input.backend !== "codex") return { status: "not_eligible", reason: "not_codex" };
  if (input.branchName !== MAIN_BRANCH_NAME) return { status: "not_eligible", reason: "not_main_branch" };
  if (!input.persistedBackendSessionId) {
    return { status: "not_eligible", reason: "no_persisted_resume" };
  }
  if (!isCodexArrayParamResumeError(input.error)) {
    return { status: "not_eligible", reason: "not_poison_error" };
  }

  const recentRuns = await input.store.listRecentMessageRuns(input.sessionId, 2, input.branchName);
  if (
    recentRuns.length < 2
    || recentRuns[0]?.id !== input.failedRunId
    || !isCodexArrayParamResumeError(recentRuns[0]?.errorMessage)
    || !isCodexArrayParamResumeError(recentRuns[1]?.errorMessage)
  ) {
    return { status: "not_repeated", recentRuns };
  }
  if (!input.backup) return { status: "backup_unavailable" };

  let snapshot: { snapshotPath: string; receiptPath: string };
  try {
    snapshot = await input.backup({
      sessionId: input.sessionId,
      branchName: input.branchName,
      failedRunId: input.failedRunId,
      errorClass: "array_above_max_length",
    });
  } catch (error) {
    return { status: "backup_failed", error };
  }

  try {
    // SqliteBindingStore implements this as one transaction: the session row
    // and the main-branch mirror are cleared together.
    await input.store.clearSessionBranchBackendSessionId(input.sessionId, input.branchName, input.now);
    const session = await input.store.findSessionById(input.sessionId);
    const branch = await input.store.findSessionBranch(input.sessionId, input.branchName);
    if (session?.backendSessionId !== null || branch?.backendSessionId !== null) {
      throw new Error("Codex resume recovery read-back found a non-null backend session id");
    }
  } catch (error) {
    return {
      status: "clear_failed",
      error,
      snapshotPath: snapshot.snapshotPath,
      receiptPath: snapshot.receiptPath,
    };
  }

  return { status: "cleared", ...snapshot };
}
