import type { CommandHandler } from "../commandRegistry.ts";
import { UserError } from "../../domain/errors.ts";
import { formatIso, formatRelativeChinese } from "../../domain/format.ts";
import type { BindingStore } from "../../ports/BindingStore.ts";
import type { Clock } from "../../ports/Clock.ts";
import type { LarkGroupId } from "../../domain/ids.ts";
import { computeWindowCutoffs, formatSummary } from "../tokenUsageFormat.ts";

export type StatusHandlerDeps = {
  store: BindingStore;
  clock: Clock;
  resolveUserGroupSession?(groupId: LarkGroupId): Promise<{ name: string; id: string } | null>;
};

function formatModel(model: string | null): string {
  if (!model) return "default";
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return `Opus (${model})`;
  if (lower.includes("sonnet")) return `Sonnet (${model})`;
  return model;
}

export function createStatusHandler(deps: StatusHandlerDeps): CommandHandler {
  return async ({ args, scope, msg }) => {
    let targetName = args.name;
    if (scope === "user" && deps.resolveUserGroupSession) {
      const resolved = await deps.resolveUserGroupSession(msg.groupId);
      if (!resolved) throw new UserError("当前群未绑定 session");
      targetName = resolved.name;
    }
    if (!targetName) {
      const sessions = await deps.store.listActiveSessions();
      const active = sessions.length;
      const busy = sessions.filter((s) => s.status === "busy").length;
      return { replyText: `console: ${active} active sessions, ${busy} busy.` };
    }
    const s = await deps.store.findSessionByName(targetName);
    if (!s) throw new UserError(`session 不存在：${targetName}`);
    const now = deps.clock.now();
    const cutoffs = computeWindowCutoffs(now);
    const usage = await deps.store.getTokenUsageSummary(s.id, cutoffs);
    const lines = [
      `session 「${s.name}」`,
      `  backend: ${s.backend}`,
      `  model:   ${formatModel(s.model)}`,
      `  effort:  ${s.effort ?? "default"}`,
      `  thinking: ${s.thinking ? "on" : "off"}`,
      `  status:  ${s.status}`,
      `  workdir: ${s.workdir}`,
      `  backend session id: ${s.backendSessionId ?? "(none)"}`,
      `  created: ${formatIso(s.createdAt)} (${formatRelativeChinese(s.createdAt, now)})`,
      `  purpose: ${s.purpose || "(none)"}`,
      `  tokens:  ${formatSummary(usage)}`,
    ];
    return { replyText: lines.join("\n") };
  };
}
