import { UserError } from "../../domain/errors.ts";
import type { LarkGroupId, SessionId } from "../../domain/ids.ts";
import type { BindingStore } from "../../ports/BindingStore.ts";
import type { CommandHandler } from "../commandRegistry.ts";

export type WorkspaceLockHandlerDeps = {
  store: Pick<BindingStore, "updateSessionWorkspaceLocked">;
  resolveUserGroupSession(
    groupId: LarkGroupId,
  ): Promise<{ name: string; id: SessionId } | null>;
};

export function createWorkspaceLockHandler(
  deps: WorkspaceLockHandlerDeps,
  locked: boolean,
): CommandHandler {
  return async ({ msg }) => {
    const session = await deps.resolveUserGroupSession(msg.groupId);
    if (!session) throw new UserError("当前群未绑定 session");

    await deps.store.updateSessionWorkspaceLocked(session.id, locked);
    return { replyText: locked ? "✓ 工作区已锁定" : "✓ 工作区已解锁" };
  };
}
