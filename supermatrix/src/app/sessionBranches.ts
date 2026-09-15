import { UserError } from "../domain/errors.ts";
import type { SessionId, Timestamp } from "../domain/ids.ts";
import {
  MAIN_BRANCH_NAME,
  validateBranchName,
  type SessionBranchRecord,
} from "../domain/sessionBranch.ts";
import type { BindingStore } from "../ports/BindingStore.ts";

export type SessionBranchServiceDeps = {
  store: Pick<
    BindingStore,
    | "getActiveBranch"
    | "findSessionBranch"
    | "createSessionBranch"
    | "setActiveBranch"
    | "listSessionBranches"
  >;
};

export function createSessionBranchService(deps: SessionBranchServiceDeps) {
  async function createBranchFromActive(input: {
    sessionId: SessionId;
    name: string;
    preparedBackendSessionId?: string | null;
    now: Timestamp;
  }): Promise<SessionBranchRecord> {
    const name = validateBranchName(input.name);
    if (name === MAIN_BRANCH_NAME) {
      throw new UserError("main branch already exists");
    }
    const existing = await deps.store.findSessionBranch(input.sessionId, name);
    if (existing) throw new UserError(`branch already exists: ${name}`);
    const active = await deps.store.getActiveBranch(input.sessionId);
    const sourceBackendSessionId = active.backendSessionId ?? active.sourceBackendSessionId;
    const preparedBackendSessionId = input.preparedBackendSessionId ?? null;
    const branch = await deps.store.createSessionBranch({
      sessionId: input.sessionId,
      name,
      backendSessionId: preparedBackendSessionId,
      sourceBranchName: active.name,
      sourceBackendSessionId,
      forkPending: Boolean(sourceBackendSessionId && !preparedBackendSessionId),
      createdAt: input.now,
    });
    await deps.store.setActiveBranch(input.sessionId, name, input.now);
    return branch;
  }

  async function switchBranch(input: {
    sessionId: SessionId;
    name: string;
    now: Timestamp;
  }): Promise<SessionBranchRecord> {
    const name = validateBranchName(input.name);
    const branch = await deps.store.findSessionBranch(input.sessionId, name);
    if (!branch) {
      throw new UserError(`branch not found: ${name}`);
    }
    await deps.store.setActiveBranch(input.sessionId, name, input.now);
    return await deps.store.getActiveBranch(input.sessionId);
  }

  async function listBranches(sessionId: SessionId): Promise<SessionBranchRecord[]> {
    return deps.store.listSessionBranches(sessionId);
  }

  return { createBranchFromActive, switchBranch, listBranches };
}
