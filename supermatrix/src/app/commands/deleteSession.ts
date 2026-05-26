import { UserError } from "../../domain/errors.ts";
import type { LarkGroupId } from "../../domain/ids.ts";
import type { CommandHandler } from "../commandRegistry.ts";

export type DeleteHandlerDeps = {
  lifecycle: { delete(input: { name: string }): Promise<void> };
  resolveUserGroupSession(groupId: LarkGroupId): Promise<{ name: string; id: string } | null>;
};

export function createDeleteHandler(deps: DeleteHandlerDeps): CommandHandler {
  return async ({ args, scope, msg }) => {
    let targetName = args.name;
    if (scope === "user") {
      const resolved = await deps.resolveUserGroupSession(msg.groupId);
      if (!resolved) throw new UserError("当前群未绑定 session");
      targetName = resolved.name;
    }
    if (!targetName) throw new UserError("用法：/delete <name>");
    await deps.lifecycle.delete({ name: targetName });
    return { replyText: `✓ 已删除 session 「${targetName}」` };
  };
}
