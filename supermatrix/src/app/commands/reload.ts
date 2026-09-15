import { canonicalizeToken } from "../../domain/canonicalizeToken.ts";
import { UserError } from "../../domain/errors.ts";
import type { SessionId } from "../../domain/ids.ts";
import type { CommandHandler } from "../commandRegistry.ts";
import type { ProcessLifecycle } from "../processLifecycle.ts";

// Exact match after stripping leading dashes and canonicalizing. This accepts
// only explicit force tokens; near-misses must not silently become reloads.
function isForceToken(token: string | undefined): boolean {
  if (!token) return false;
  const canonical = canonicalizeToken(token.replace(/^-+/, ""));
  return canonical === "force" || canonical === "强制";
}

const MAX_RELOAD_MESSAGE_AGE_MS = 5 * 60_000;
const SCHEDULED_DAILY_SOURCE = "scheduled-daily";
const CODEXROOT_MAINTENANCE_SOURCE = "codexroot-maintenance";
const ALLOWED_RELOAD_SOURCES = new Set([
  SCHEDULED_DAILY_SOURCE,
  CODEXROOT_MAINTENANCE_SOURCE,
]);
const RELOAD_PERMIT_RE = /^smrp_[a-f0-9]{32}$/;

export type ReloadPermitClaim = {
  nonce: string;
  source: string;
  force: boolean;
  receivedAtMs: number;
};

export type ReloadHandlerDeps = {
  lifecycle: ProcessLifecycle;
  store: {
    listActiveSessions(): Promise<Array<{ id: string; name: string; status: string }>>;
  };
  consumePermit(input: ReloadPermitClaim): Promise<false | {
    callerRunId: string;
    callerSessionId: string;
  }>;
  cancelBackend?: (sessionId: SessionId) => Promise<void>;
  // Legacy force-reload nudge injection knobs are intentionally ignored while
  // that feature is paused.
  dbPath?: string;
  now?: () => number;
  writeNudge?: (dbPath: string, record: unknown) => void;
};

/**
 * PLATFORM LIFECYCLE SAFETY / 平台生命周期红线：this handler is the only
 * SuperMatrix reload path after codexroot's one-shot permit is consumed.
 * Never replace or supplement it with kill -9/SIGKILL, pkill, launchctl, or a
 * direct process exit; those bypass drain checks and can kill other sessions.
 */
export function createReloadHandler(deps: ReloadHandlerDeps): CommandHandler {
  return async ({ scope, args, msg }) => {
    if (scope !== "root") {
      throw new UserError("/reload 只能在 root 群使用");
    }

    // /reload accepts no positional argument (safe reload) or an explicit
    // force token. Reject every other non-empty positional token before any
    // session lookup or restart signal.
    const positional = args.name?.trim();
    if (positional && !isForceToken(positional)) {
      throw new UserError(
        `未知的 /reload 参数「${positional}」。全局 reload 只能由 codexroot maintenance gate 发起。`,
      );
    }
    const force = args.force === "true" || isForceToken(positional);
    const requestedSource = args.source?.trim();
    if (!requestedSource) {
      throw new UserError(
        "全局 reload 已收口到 codexroot；请通过 spawn2.0 target=codexroot 提交维护申请。",
      );
    }
    if (!ALLOWED_RELOAD_SOURCES.has(requestedSource)) {
      throw new UserError(
        "全局 reload 已收口到 codexroot maintenance gate；当前来源未获准。",
      );
    }
    if (force && requestedSource === SCHEDULED_DAILY_SOURCE) {
      throw new UserError("scheduled-daily 只能安全排空，不能与 force 一起使用。");
    }
    const source = requestedSource;
    const now = deps.now?.() ?? Date.now();
    const messageAgeMs = now - msg.receivedAtMs;
    if (msg.receivedAtMs > 0 && messageAgeMs > MAX_RELOAD_MESSAGE_AGE_MS) {
      return {
        replyText: `⚠️ 已忽略过期重启命令（来源：${source}，延迟 ${Math.floor(messageAgeMs / 60_000)} 分钟）。`,
      };
    }
    const permitNonce = args.permit?.trim();
    if (!permitNonce || !RELOAD_PERMIT_RE.test(permitNonce)) {
      throw new UserError("全局 reload 缺少 codexroot maintenance gate 的一次性 permit。");
    }
    const permitGrant = await deps.consumePermit({
      nonce: permitNonce,
      source,
      force,
      receivedAtMs: msg.receivedAtMs,
    });
    if (!permitGrant) {
      throw new UserError("全局 reload permit 无效、过期或已消费；请重新交由 codexroot 裁决。");
    }
    const sessions = await deps.store.listActiveSessions();
    // The permit caller is necessarily busy while it dispatches this command;
    // exclude only that session-status echo. The exact-run lifecycle counter
    // below still blocks every other run, including one in the same session.
    const busySessions = sessions.filter(
      (s) => s.status === "busy" && s.id !== permitGrant.callerSessionId,
    );
    // The actual restart gate is the in-flight run counter, not just top-level
    // session status. Child-session work and runs mid-startup raise inFlight but
    // never appear in listActiveSessions (which excludes scope='child'), so a
    // status-only check would accept the restart and then silently hang on the
    // lifecycle gate. Consult both and report the truth.
    const inFlight = deps.lifecycle.inFlightCountExcluding(permitGrant.callerRunId);

    if (force) {
      deps.lifecycle.requestRestart("/reload --force", {
        force: true,
        source,
        ignoreInFlightRunId: permitGrant.callerRunId,
      });
      const skipped = [
        busySessions.length > 0 ? `${busySessions.length} 个 busy session` : "",
        inFlight > 0 ? `${inFlight} 个在飞 run` : "",
      ]
        .filter(Boolean)
        .join("、");
      return {
        replyText: `✓ 强制重启（来源：${source}）${skipped ? `：跳过 ${skipped}` : ""}，进程即将退出。`,
      };
    }

    if (busySessions.length > 0 || inFlight > 0) {
      const blocking = [
        inFlight > 0 ? `${inFlight} 个 run 在飞` : "",
        busySessions.length > 0 ? `busy session：${busySessions.map((s) => s.name).join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("；");
      return {
        replyText:
          `⚠️ 已拒绝重启（来源：${source}）：${blocking}。` +
          "本次 permit 已消费，未登记 pending reload；需要时请由 codexroot 重新裁决。",
      };
    }

    // The handler repeats the executor's idle check to close the dispatch race.
    // Safe reload never leaves a future restart armed behind newly-started work.
    deps.lifecycle.requestRestart("/reload", {
      force: false,
      source,
      ignoreInFlightRunId: permitGrant.callerRunId,
    });
    return { replyText: `✓ 重启中（来源：${source}），进程即将退出。` };
  };
}
