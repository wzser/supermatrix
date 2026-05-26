import { UserError } from "../../domain/errors.ts";
import type { LarkGroupId, SessionId } from "../../domain/ids.ts";
import type { Session } from "../../domain/session.ts";
import type { CommandHandler } from "../commandRegistry.ts";

export type HeartbeatHandlerDeps = {
  store: {
    findSessionByName(name: string): Promise<Session | null>;
    getSessionHeartbeatEnabled(id: SessionId): Promise<boolean>;
    updateSessionHeartbeatEnabled(id: SessionId, enabled: boolean): Promise<void>;
  };
  resolveUserGroupSession?: (groupId: LarkGroupId) => Promise<{ name: string; id: SessionId } | null>;
  heartbeatControl?: (input: HeartbeatControlInput) => Promise<HeartbeatControlResult>;
};

export type HeartbeatControlInput =
  | { action: "pause"; sessionName: string; minutes?: number; permanent?: boolean; reason: string }
  | { action: "resume"; sessionName: string; reason: string }
  | { action: "status"; sessionName: string };

export type HeartbeatControlResult = {
  status?: string;
  expires_at?: string;
};

function formatState(enabled: boolean): "on" | "off" {
  return enabled ? "on" : "off";
}

export function createHeartbeatHandler(deps: HeartbeatHandlerDeps): CommandHandler {
  return async ({ args, scope, msg }) => {
    let sessionName = args.name;
    const state = args.state;
    const duration = args.duration;

    if (scope === "user" && deps.resolveUserGroupSession) {
      const resolved = await deps.resolveUserGroupSession(msg.groupId);
      if (!resolved) throw new UserError("当前群未绑定 session");
      sessionName = resolved.name;
    }

    if (!sessionName || !state) {
      throw new UserError(
        scope === "root"
          ? "用法：/heartbeat <session-name> on|off|status"
          : "用法：/heartbeat on|off|status",
      );
    }

    if (!["on", "off", "status", "stop", "resume"].includes(state)) {
      throw new UserError("heartbeat 状态必须是 on、off、status、stop 或 resume");
    }

    const session = await deps.store.findSessionByName(sessionName);
    if (!session) throw new UserError(`session 不存在：${sessionName}`);
    if (session.scope === "child") throw new UserError("child session 不支持 heartbeat");
    if (session.status === "deleted") throw new UserError(`session 已删除：${sessionName}`);
    if (session.name === "heartbeat" && state === "on") {
      throw new UserError("heartbeat session 自身不支持开启 heartbeat");
    }

    const enabled = await deps.store.getSessionHeartbeatEnabled(session.id);

    if (state === "status") {
      const pause = await deps.heartbeatControl?.({ action: "status", sessionName: session.name });
      if (enabled && pause?.status === "paused" && pause.expires_at) {
        return { replyText: `heartbeat「${session.name}」当前：on，暂停至 ${pause.expires_at}` };
      }
      return { replyText: `heartbeat「${session.name}」当前：${formatState(enabled)}` };
    }

    if (state === "stop") {
      const parsed = parseStopDuration(duration);
      if (parsed.permanent) {
        await deps.store.updateSessionHeartbeatEnabled(session.id, false);
        await deps.heartbeatControl?.({
          action: "pause",
          sessionName: session.name,
          permanent: true,
          reason: "manual permanent stop",
        });
        return { replyText: `✓ heartbeat「${session.name}」已永久停止` };
      }
      await deps.store.updateSessionHeartbeatEnabled(session.id, true);
      const result = await deps.heartbeatControl?.({
        action: "pause",
        sessionName: session.name,
        minutes: parsed.minutes,
        reason: `manual temporary stop ${parsed.minutes} minutes`,
      });
      return { replyText: `✓ heartbeat「${session.name}」已暂停 ${parsed.minutes} 分钟${result?.expires_at ? `，到 ${result.expires_at}` : ""}` };
    }

    if (state === "resume") {
      await deps.store.updateSessionHeartbeatEnabled(session.id, true);
      await deps.heartbeatControl?.({ action: "resume", sessionName: session.name, reason: "manual resume" });
      return { replyText: `✓ heartbeat「${session.name}」已恢复` };
    }

    const next = state === "on";
    if (enabled === next) {
      return { replyText: `✓ heartbeat「${session.name}」已经${next ? "开启" : "关闭"}` };
    }

    await deps.store.updateSessionHeartbeatEnabled(session.id, next);
    if (next) {
      await deps.heartbeatControl?.({ action: "resume", sessionName: session.name, reason: "manual on" });
    } else {
      await deps.heartbeatControl?.({
        action: "pause",
        sessionName: session.name,
        permanent: true,
        reason: "manual off",
      });
    }
    return { replyText: `✓ heartbeat「${session.name}」已${next ? "开启" : "关闭"}` };
  };
}

function parseStopDuration(value: string | undefined): { permanent: boolean; minutes: number } {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return { permanent: false, minutes: 60 };
  if (["permanent", "forever", "永久"].includes(normalized)) {
    return { permanent: true, minutes: 0 };
  }
  if (!/^\d+$/u.test(normalized)) {
    throw new UserError("stop heartbeat 参数必须是分钟数或 permanent/永久");
  }
  const minutes = Number(normalized);
  if (!Number.isSafeInteger(minutes) || minutes < 1) {
    throw new UserError("stop heartbeat 分钟数必须大于 0");
  }
  return { permanent: false, minutes };
}
