import { UserError } from "../../domain/errors.ts";
import { canonicalizeToken } from "../../domain/canonicalizeToken.ts";
import { resolveBackendAlias } from "./backendAliases.ts";
import { assertBackendAllowedForCategory } from "../../domain/sessionMeta.ts";
import type { BackendKind, EffortLevel, SessionCategory } from "../../domain/session.ts";
import { asTimestamp, type LarkGroupId, type SessionId } from "../../domain/ids.ts";
import type { SessionRuntimeConfigMutation } from "../../ports/BindingStore.ts";
import type { CodexModelAvailability } from "../../ports/CodexModelAvailability.ts";
import { getCodexModelCatalogFingerprint, getCodexModelCatalogSnapshot, getCodexModelCatalogSource } from "../../ports/CodexModelCatalog.ts";
import { resolveSessionRuntimeConfig } from "../sessionRuntimeConfigPolicy.ts";
import type { SessionRuntimeSettingsSyncScope } from "../sessionRuntimeSettings.ts";
import type { CommandHandler } from "../commandRegistry.ts";
import { errorMessage } from "../errorMessage.ts";
import {
  formatChildSessionDefaultsReceipt,
  mutateChildSessionDefaults,
  type ChildSessionDefaultsCommandStore,
} from "./childSessionDefaults.ts";

export type ScheduledTaskSummary = {
  id: string;
  cronExpression: string;
  prompt: string;
};

export type ScheduledTaskReviewRequest = {
  sessionName: string;
  previousBackend: BackendKind;
  newBackend: BackendKind;
  backendSwitchAuditId: string;
  backendSwitchAuditCreatedAt: number;
};

export type SetBackendHandlerDeps = {
  store: {
    findSessionByName(name: string): Promise<{
      id: SessionId;
      backend: BackendKind;
      category: SessionCategory;
      status: string;
      model: string | null;
      effort: EffortLevel | null;
      backendSessionId: string | null;
    } | null>;
    findBySession(sessionId: SessionId): Promise<{ groupId: LarkGroupId } | null>;
    applySessionRuntimeConfigMutations(mutations: readonly SessionRuntimeConfigMutation[]): Promise<{ updated: number }>;
  } & ChildSessionDefaultsCommandStore;
  availability?: CodexModelAvailability;
  renameGroup?: (groupId: LarkGroupId, newName: string) => Promise<void>;
  resolveUserGroupSession?: (groupId: LarkGroupId) => Promise<{ name: string; id: SessionId } | null>;
  // Optional cascade dependencies (wired by bootstrap; tests may omit).
  //
  // listScheduledTasks returns enabled cron tasks owned by the session being
  // switched. This is visibility-only; scheduler owns review and mutation.
  listScheduledTasks?: (sessionName: string) => Promise<ScheduledTaskSummary[]>;
  // Dispatches an asynchronous scheduler-owned compatibility review after a
  // successful backend switch. Scheduler remains the only task mutation owner.
  requestScheduledTaskReview?: (request: ScheduledTaskReviewRequest) => Promise<void>;
  // regenerateCatalog rebuilds the global session-catalog.json so its entry
  // for this session reflects the new backend.
  regenerateCatalog?: (reason: string) => Promise<void>;
  syncSessionTable?: (scope: SessionRuntimeSettingsSyncScope) => void;
};

export function createSetBackendHandler(deps: SetBackendHandlerDeps): CommandHandler {
  return async ({ args, scope, msg }) => {
    let sessionName = args.name;
    const backendArg = args.backend;

    if (scope === "user" && deps.resolveUserGroupSession) {
      const resolved = await deps.resolveUserGroupSession(msg.groupId);
      if (!resolved) throw new UserError("当前群未绑定 session");
      sessionName = resolved.name;
    }

    if (
      scope === "root" &&
      sessionName === "global" &&
      canonicalizeToken(backendArg ?? "") === "child"
    ) {
      const result = await setChildBackendDefaults(deps.store, args.value);
      if (args.value) deps.syncSessionTable?.("current");
      return result;
    }

    if (!sessionName || !backendArg) {
      throw new UserError(
        scope === "root"
          ? "用法：/backend <session-name> <claude|codex|kimi>"
          : "用法：/backend <claude|codex|kimi>",
      );
    }

    const newBackend = resolveBackendAlias(backendArg);
    if (!newBackend) {
      throw new UserError(`无效的 backend：${backendArg}，可选值：claude、codex、kimi`);
    }

    const session = await deps.store.findSessionByName(sessionName);
    if (!session) throw new UserError(`session 不存在：${sessionName}`);

    if (session.backend === newBackend) {
      return { replyText: `session「${sessionName}」已经在使用 ${newBackend}，无需切换` };
    }

    if (session.status === "busy") {
      throw new UserError("session 正在运行，请等待完成或先 /cancel");
    }

    assertBackendAllowedForCategory(newBackend, session.category);

    // Config admission validates catalog/policy only. No generative Codex
    // availability probe on this synchronous hot path — the first real Codex
    // execution stays authoritative (before-work recovery handles a confirmed
    // unavailable model). The `availability` seam is retained so tests can
    // prove this path never probes.
    const catalog = getCodexModelCatalogSnapshot();
    const current = { backend: session.backend, model: session.model, effort: session.effort, backendSessionId: session.backendSessionId };
    const decision = resolveSessionRuntimeConfig({ current, intent: { kind: "set-backend", backend: newBackend }, catalog });
    const backendSwitchAuditId = `cfg_${crypto.randomUUID()}`;
    const backendSwitchAuditCreatedAt = asTimestamp(Date.now());
    await deps.store.applySessionRuntimeConfigMutations([{
      sessionId: session.id,
      expected: current,
      after: decision.after,
      guard: { kind: "idle" },
      audit: { id: backendSwitchAuditId, trigger: "backend", requested: { backend: newBackend }, decision: decision.action, reason: decision.reason, catalogSource: getCodexModelCatalogSource(), catalogFingerprint: getCodexModelCatalogFingerprint(), createdAt: backendSwitchAuditCreatedAt },
    }]);

    const warnings: string[] = [];
    deps.syncSessionTable?.("backend-switch");
    // 5. Scheduler owns recurring task mutations. Dispatch its compatibility
    // review first so unrelated best-effort side effects cannot delay it.
    let scheduledTaskReviewDispatched = false;
    if (deps.requestScheduledTaskReview) {
      try {
        await deps.requestScheduledTaskReview({
          sessionName,
          previousBackend: session.backend,
          newBackend,
          backendSwitchAuditId,
          backendSwitchAuditCreatedAt,
        });
        scheduledTaskReviewDispatched = true;
      } catch (err) {
        warnings.push(`定时任务自动核查派发失败：${errorMessage(err)}`);
      }
    }

    // 6. Update Lark group name suffix
    if (deps.renameGroup) {
      try {
        const binding = await deps.store.findBySession(session.id);
        if (binding) {
          // Fetch current group name via lark-cli is not available here,
          // so we use the convention: if name ends with old backend suffix, replace it;
          // otherwise append new backend suffix.
          // Since we can't read the current group name from here, we use session name
          // as the base and let renameGroup do the actual API call.
          // The caller (bootstrap) can provide a smarter renameGroup that reads current name.
          await deps.renameGroup(binding.groupId, newBackend);
        }
      } catch (err) {
        warnings.push(`群名更新失败：${errorMessage(err)}`);
      }
    }

    // 7. List related cron tasks for visibility; scheduler owns any mutation.
    let taskBlock = "";
    if (deps.listScheduledTasks) {
      try {
        const tasks = await deps.listScheduledTasks(sessionName);
        taskBlock = formatTaskBlock(tasks, scheduledTaskReviewDispatched);
      } catch (err) {
        warnings.push(`查询定时任务失败：${errorMessage(err)}`);
      }
    }

    // 8. Regenerate the global session-catalog.json so this session's entry
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
      "（对话上下文与当前 model / effort 已清空；不兼容的飞书每日默认值将自动迁移）",
    ];
    if (taskBlock) {
      parts.push(`\n\n${taskBlock}`);
    }
    if (scheduledTaskReviewDispatched) {
      parts.push("\n\n已交 scheduler 自动核查相关定时任务并按需适配。");
    }
    if (warnings.length > 0) {
      parts.push(`\n\n⚠ ${warnings.join("\n⚠ ")}`);
    }
    return { replyText: parts.join("") };
  };
}

async function setChildBackendDefaults(
  store: ChildSessionDefaultsCommandStore,
  value: string | undefined,
) {
  if (!value) {
    return { replyText: await formatChildSessionDefaultsReceipt(store) };
  }

  if (canonicalizeToken(value) === "inherit") {
    await mutateChildSessionDefaults(store, () => ({
      backend: { configured: false, value: null },
      model: { configured: false, value: null },
      effort: { configured: false, value: null },
    }));
    return { replyText: await formatChildSessionDefaultsReceipt(store) };
  }

  const backend = resolveBackendAlias(value);
  if (!backend) {
    throw new UserError(`无效的 child backend：${value}，可选值：claude、codex、kimi、inherit`);
  }

  await mutateChildSessionDefaults(store, () => ({
    backend: { configured: true, value: backend },
    model: { configured: false, value: null },
    effort: { configured: false, value: null },
  }));
  return { replyText: await formatChildSessionDefaultsReceipt(store) };
}

function formatTaskBlock(tasks: ScheduledTaskSummary[], automatedReview: boolean): string {
  if (tasks.length === 0) {
    return "相关定时任务：无相关定时任务";
  }
  const header = automatedReview
    ? "相关定时任务（scheduler 将自动核查 prompt 是否仍适用新 backend）："
    : "相关定时任务（请自行检查 prompt 是否仍适用新 backend）：";
  const lines = tasks.map((t) => {
    const promptSnippet = (t.prompt ?? "").slice(0, 50);
    return `  • ${t.id}  ${t.cronExpression}  ${promptSnippet}`;
  });
  return [header, ...lines].join("\n");
}
