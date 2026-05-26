import { UserError } from "../../domain/errors.ts";
import type { SessionId } from "../../domain/ids.ts";
import type { CommandHandler } from "../commandRegistry.ts";
import type { ProcessLifecycle } from "../processLifecycle.ts";

export type ReloadHandlerDeps = {
  lifecycle: ProcessLifecycle;
  store: {
    listActiveSessions(): Promise<Array<{ name: string; status: string }>>;
  };
  cancelBackend?: (sessionId: SessionId) => Promise<void>;
};

export function createReloadHandler(deps: ReloadHandlerDeps): CommandHandler {
  return async ({ scope, args }) => {
    if (scope !== "root") {
      throw new UserError("/reload 只能在 root 群使用");
    }

    const force = args.force === "true" || args.name === "--force";
    const source = args.source ?? "user (console)";
    const sessions = await deps.store.listActiveSessions();
    const busySessions = sessions.filter((s) => s.status === "busy");

    if (busySessions.length > 0 && !force) {
      const names = busySessions.map((s) => s.name).join(", ");
      return {
        replyText: `❌ 无法重启：${busySessions.length} 个 session 正在运行（${names}）。\n使用 /reload --force 强制重启。`,
      };
    }

    deps.lifecycle.requestRestart(
      force ? "/reload --force" : "/reload",
      { force, source },
    );
    return {
      replyText: force
        ? `✓ 强制重启（来源：${source}）：跳过 ${busySessions.length} 个 busy session，进程即将退出。`
        : `✓ 重启中（来源：${source}），进程即将退出。`,
    };
  };
}
