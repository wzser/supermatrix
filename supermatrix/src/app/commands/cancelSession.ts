import { UserError } from "../../domain/errors.ts";
import type { BindingStore } from "../../ports/BindingStore.ts";
import type { LarkGroupId } from "../../domain/ids.ts";
import type { CommandHandler } from "../commandRegistry.ts";

export type CancelHandlerDeps = {
  store: BindingStore;
  cancel(sessionId: string): Promise<void>;
  clearPendingNext?: (sessionId: string) => number;
  resolveUserGroupSession(groupId: LarkGroupId): Promise<{ name: string; id: string } | null>;
};

export function createCancelHandler(deps: CancelHandlerDeps): CommandHandler {
  return async ({ args, scope, msg }) => {
    const targetSpec = (args.target ?? args.name ?? "").trim();
    let targetName = "";
    let nextOnly = false;
    if (scope === "user") {
      const resolved = await deps.resolveUserGroupSession(msg.groupId);
      if (!resolved) throw new UserError("当前群未绑定 session");
      if (targetSpec && targetSpec !== "next") {
        throw new UserError("用法：/cancel 或 /cancel next");
      }
      targetName = resolved.name;
      nextOnly = targetSpec === "next";
    } else {
      if (!targetSpec) throw new UserError("用法：/cancel <name> 或 /cancel next <name>");
      if (targetSpec === "next") throw new UserError("用法：/cancel next <name>");
      if (targetSpec.startsWith("next ")) {
        targetName = targetSpec.slice("next ".length).trim();
        nextOnly = true;
      } else {
        targetName = targetSpec;
      }
    }
    if (!targetName) throw new UserError("用法：/cancel <name> 或 /cancel next <name>");
    const session = await deps.store.findSessionByName(targetName);
    if (!session) throw new UserError(`session 不存在：${targetName}`);
    const clearedPendingNext = deps.clearPendingNext?.(session.id) ?? 0;
    if (nextOnly) {
      return { replyText: `✓ 已清空 ${clearedPendingNext} 条排队消息` };
    }
    await deps.cancel(session.id);
    return { replyText: `✓ 已请求取消 session 「${targetName}」，已清空 ${clearedPendingNext} 条排队消息` };
  };
}
