import { UserError } from "../../domain/errors.ts";
import type { LarkGroupId, SessionId } from "../../domain/ids.ts";
import type { CommandHandler } from "../commandRegistry.ts";

export type SetTimeoutHandlerDeps = {
  store: {
    findSessionByName(name: string): Promise<{ id: SessionId; name: string; inactivityTimeoutS: number | null; maxRuntimeS: number | null } | null>;
    findSessionById(id: SessionId): Promise<{ id: SessionId; name: string; inactivityTimeoutS: number | null; maxRuntimeS: number | null } | null>;
    updateSessionInactivityTimeout(id: SessionId, seconds: number | null): Promise<void>;
    updateSessionMaxRuntime(id: SessionId, seconds: number | null): Promise<void>;
  };
  resolveUserGroupSession?: (groupId: LarkGroupId) => Promise<{ name: string; id: SessionId } | null>;
};

function formatInactivity(val: number | null): string {
  if (val === null) return "默认 (900s)";
  if (val === 0) return "已禁用";
  return `${val}s`;
}

function formatMaxRuntime(val: number | null): string {
  if (val === null || val === 0) return "无限制";
  return `${val}s`;
}

export function createSetTimeoutHandler(deps: SetTimeoutHandlerDeps): CommandHandler {
  return async ({ args, scope, msg }) => {
    let sessionName = args["name"];
    const timeoutArg = args["timeout"];
    const maxrunArg = args["maxrun"];

    if (scope === "user" && deps.resolveUserGroupSession) {
      const resolved = await deps.resolveUserGroupSession(msg.groupId);
      if (!resolved) throw new UserError("当前群未绑定 session");
      sessionName = resolved.name;
    }

    if (!sessionName) {
      throw new UserError(
        scope === "root"
          ? "用法：/timeout <session-name> [<seconds>] [--maxrun <seconds>]"
          : "用法：/timeout [<seconds>] [--maxrun <seconds>]",
      );
    }

    const session = await deps.store.findSessionByName(sessionName);
    if (!session) throw new UserError(`session 不存在：${sessionName}`);

    // No args: show current config
    if (!timeoutArg && !maxrunArg) {
      return {
        replyText:
          `${session.name} 超时配置:\n` +
          `  不活动超时: ${formatInactivity(session.inactivityTimeoutS)}\n` +
          `  最大运行时间: ${formatMaxRuntime(session.maxRuntimeS)}`,
      };
    }

    if (timeoutArg) {
      if (timeoutArg === "default") {
        await deps.store.updateSessionInactivityTimeout(session.id, null);
      } else {
        const seconds = Number(timeoutArg);
        if (!Number.isFinite(seconds) || seconds < 0 || !Number.isInteger(seconds)) {
          throw new UserError(`无效的超时值: ${timeoutArg}，需要正整数秒数、0（禁用）或 default`);
        }
        await deps.store.updateSessionInactivityTimeout(session.id, seconds);
      }
    }

    if (maxrunArg) {
      if (maxrunArg === "off" || maxrunArg === "0") {
        await deps.store.updateSessionMaxRuntime(session.id, null);
      } else {
        const seconds = Number(maxrunArg);
        if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isInteger(seconds)) {
          throw new UserError(`无效的最大运行时间: ${maxrunArg}，需要正整数秒数或 off`);
        }
        await deps.store.updateSessionMaxRuntime(session.id, seconds);
      }
    }

    const updated = await deps.store.findSessionById(session.id);
    const inact = updated!.inactivityTimeoutS;
    const maxr = updated!.maxRuntimeS;
    return {
      replyText:
        `✅ ${session.name} 超时已更新:\n` +
        `  不活动超时: ${formatInactivity(inact)}\n` +
        `  最大运行时间: ${formatMaxRuntime(maxr)}`,
    };
  };
}
