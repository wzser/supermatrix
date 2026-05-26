import { UserError } from "../../domain/errors.ts";
import type { LarkGroupId } from "../../domain/ids.ts";
import type { BindingStore } from "../../ports/BindingStore.ts";
import type { CommandHandler } from "../commandRegistry.ts";

export type NextHandlerDeps = {
  store: BindingStore;
  resolveUserGroupSession(groupId: LarkGroupId): Promise<{ name: string; id: string } | null>;
  enqueuePendingNext(
    sessionId: string,
    pending: { text: string; groupId: LarkGroupId; userId: string },
  ): void;
};

export function createNextHandler(deps: NextHandlerDeps): CommandHandler {
  return async ({ args, msg }) => {
    const resolved = await deps.resolveUserGroupSession(msg.groupId);
    if (!resolved) throw new UserError("当前群未绑定 session");

    const session = await deps.store.findSessionByName(resolved.name);
    if (!session) throw new UserError("session 不存在");
    if (session.status === "deleted" || session.status === "error") {
      throw new UserError("session 状态异常，无法使用 /next");
    }

    const text = args.text;

    const pending = { text, groupId: msg.groupId, userId: msg.userId };
    deps.enqueuePendingNext(session.id, pending);
    if (session.status !== "busy") {
      return { handled: true };
    }

    return { replyText: "✓ 已排队，将在当前任务完成后执行" };
  };
}
