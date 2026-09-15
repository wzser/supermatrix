import { UserError } from "../../domain/errors.ts";
import type { LarkGroupId } from "../../domain/ids.ts";
import type { CommandHandler } from "../commandRegistry.ts";

export type ResetHandlerDeps = {
  lifecycle: { reset(input: { name: string }): Promise<void> };
  resolveUserGroupSession(groupId: LarkGroupId): Promise<{ name: string; id: string } | null>;
};

export function createResetHandler(deps: ResetHandlerDeps): CommandHandler {
  return async ({ args, scope, msg }) => {
    let targetName = args.name;
    if (scope === "user") {
      const resolved = await deps.resolveUserGroupSession(msg.groupId);
      if (!resolved) throw new UserError("当前群未绑定 session");
      targetName = resolved.name;
    }
    if (!targetName) throw new UserError("用法：/reset <name>");
    await deps.lifecycle.reset({ name: targetName });
    return { replyText: `✓ session 「${targetName}」上下文已清空` };
  };
}
