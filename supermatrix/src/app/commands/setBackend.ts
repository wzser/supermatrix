import { UserError } from "../../domain/errors.ts";
import type { BackendKind } from "../../domain/session.ts";
import type { LarkGroupId, SessionId } from "../../domain/ids.ts";
import type { CommandHandler } from "../commandRegistry.ts";
import { errorMessage } from "../errorMessage.ts";

export type ScheduledTaskSummary = {
  id: string;
  cronExpression: string;
  prompt: string;
};

export type SetBackendHandlerDeps = {
  store: {
    findSessionByName(name: string): Promise<{
      id: SessionId;
      backend: BackendKind;
      status: string;
    } | null>;
    findBySession(sessionId: SessionId): Promise<{ groupId: LarkGroupId } | null>;
    updateSessionBackend(id: SessionId, backend: BackendKind): Promise<void>;
    updateSessionBackendSessionId(id: SessionId, backendSessionId: string | null): Promise<void>;
    updateSessionModel(id: SessionId, model: string | null): Promise<void>;
  };
  renameGroup?: (groupId: LarkGroupId, newName: string) => Promise<void>;
  resolveUserGroupSession?: (groupId: LarkGroupId) => Promise<{ name: string; id: SessionId } | null>;
  // Optional cascade dependencies (wired by bootstrap; tests may omit).
  //
  // listScheduledTasks returns enabled cron tasks whose sessionName matches
  // the session being switched. Only display — users decide whether the
  // prompt still fits the new backend.
  listScheduledTasks?: (sessionName: string) => Promise<ScheduledTaskSummary[]>;
  // regenerateCatalog rebuilds the global session-catalog.json so its entry
  // for this session reflects the new backend.
  regenerateCatalog?: (reason: string) => Promise<void>;
};

const VALID_BACKENDS: BackendKind[] = ["claude", "codex", "kimi"];

export function createSetBackendHandler(deps: SetBackendHandlerDeps): CommandHandler {
  return async ({ args, scope, msg }) => {
    let sessionName = args.name;
    const backendArg = args.backend;

    if (scope === "user" && deps.resolveUserGroupSession) {
      const resolved = await deps.resolveUserGroupSession(msg.groupId);
      if (!resolved) throw new UserError("当前群未绑定 session");
      sessionName = resolved.name;
    }

    if (!sessionName || !backendArg) {
      throw new UserError(
        scope === "root"
          ? "用法：/backend <session-name> <claude|codex|kimi>"
          : "用法：/backend <claude|codex|kimi>",
      );
    }

    if (!VALID_BACKENDS.includes(backendArg as BackendKind)) {
      throw new UserError(`无效的 backend：${backendArg}，可选值：claude、codex、kimi`);
    }
    const newBackend = backendArg as BackendKind;

    const session = await deps.store.findSessionByName(sessionName);
    if (!session) throw new UserError(`session 不存在：${sessionName}`);

    if (session.backend === newBackend) {
      return { replyText: `session「${sessionName}」已经在使用 ${newBackend}，无需切换` };
    }

    if (session.status === "busy") {
      throw new UserError("session 正在运行，请等待完成或先 /cancel");
    }

    // 1. Clear backend session ID (old provider's resume token is useless)
    await deps.store.updateSessionBackendSessionId(session.id, null);
    // 2. Reset model (cross-backend model IDs are incompatible)
    await deps.store.updateSessionModel(session.id, null);
    // 3. Switch backend
    await deps.store.updateSessionBackend(session.id, newBackend);

    // 4. Update Lark group name suffix
    const warnings: string[] = [];
    if (deps.renameGroup) {
      const binding = await deps.store.findBySession(session.id);
      if (binding) {
        try {
          // Fetch current group name via lark-cli is not available here,
          // so we use the convention: if name ends with old backend suffix, replace it;
          // otherwise append new backend suffix.
          // Since we can't read the current group name from here, we use session name
          // as the base and let renameGroup do the actual API call.
          // The caller (bootstrap) can provide a smarter renameGroup that reads current name.
          await deps.renameGroup(binding.groupId, newBackend);
        } catch (err) {
          warnings.push(`群名更新失败：${errorMessage(err)}`);
        }
      }
    }

    // 5. List related cron tasks — display only, don't touch. The user
    //    decides whether each prompt still makes sense on the new backend.
    let taskBlock = "";
    if (deps.listScheduledTasks) {
      try {
        const tasks = await deps.listScheduledTasks(sessionName);
        taskBlock = formatTaskBlock(tasks);
      } catch (err) {
        warnings.push(`查询定时任务失败：${errorMessage(err)}`);
      }
    }

    // 6. Regenerate the global session-catalog.json so this session's entry
    //    reflects the new backend. Failure is a warning, not a rollback.
    if (deps.regenerateCatalog) {
      try {
        await deps.regenerateCatalog(`backend switched: ${sessionName} ${session.backend}->${newBackend}`);
      } catch (err) {
        warnings.push(`session-catalog 重新生成失败：${errorMessage(err)}`);
      }
    }

    const parts = [
      `✓ session「${sessionName}」已从 ${session.backend} 切换为 ${newBackend}`,
      "（对话上下文已清空，model 已重置为默认）",
    ];
    if (taskBlock) {
      parts.push(`\n\n${taskBlock}`);
    }
    if (warnings.length > 0) {
      parts.push(`\n\n⚠ ${warnings.join("\n⚠ ")}`);
    }
    return { replyText: parts.join("") };
  };
}

function formatTaskBlock(tasks: ScheduledTaskSummary[]): string {
  if (tasks.length === 0) {
    return "相关定时任务：无相关定时任务";
  }
  const header = "相关定时任务（请自行检查 prompt 是否仍适用新 backend）：";
  const lines = tasks.map((t) => {
    const promptSnippet = (t.prompt ?? "").slice(0, 50);
    return `  • ${t.id}  ${t.cronExpression}  ${promptSnippet}`;
  });
  return [header, ...lines].join("\n");
}
