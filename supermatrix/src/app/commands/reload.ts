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

// Bounded wait before a non-force reload escalates to a forced exit. On a busy
// host the "no runs in flight" window may never open, so a plain /reload drains
// for this long then forces — it always makes progress instead of hanging.
const DEFAULT_RELOAD_DRAIN_TIMEOUT_MS = 20_000;
const MAX_RELOAD_MESSAGE_AGE_MS = 5 * 60_000;

export type ReloadHandlerDeps = {
  lifecycle: ProcessLifecycle;
  store: {
    listActiveSessions(): Promise<Array<{ name: string; status: string }>>;
  };
  cancelBackend?: (sessionId: SessionId) => Promise<void>;
  // Legacy force-reload nudge injection knobs are intentionally ignored while
  // that feature is paused.
  dbPath?: string;
  now?: () => number;
  writeNudge?: (dbPath: string, record: unknown) => void;
  /** Overridable for tests; defaults to DEFAULT_RELOAD_DRAIN_TIMEOUT_MS. */
  drainTimeoutMs?: number;
};

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
        `未知的 /reload 参数「${positional}」。用法：/reload（安全重启）或 /reload force（强制重启）。`,
      );
    }
    const force = args.force === "true" || isForceToken(positional);
    const source = args.source ?? "user (console)";
    const now = deps.now?.() ?? Date.now();
    const messageAgeMs = now - msg.receivedAtMs;
    if (msg.receivedAtMs > 0 && messageAgeMs > MAX_RELOAD_MESSAGE_AGE_MS) {
      return {
        replyText: `⚠️ 已忽略过期重启命令（来源：${source}，延迟 ${Math.floor(messageAgeMs / 60_000)} 分钟）。`,
      };
    }
    const sessions = await deps.store.listActiveSessions();
    const busySessions = sessions.filter((s) => s.status === "busy");
    // The actual restart gate is the in-flight run counter, not just top-level
    // session status. Child-session work and runs mid-startup raise inFlight but
    // never appear in listActiveSessions (which excludes scope='child'), so a
    // status-only check would accept the restart and then silently hang on the
    // lifecycle gate. Consult both and report the truth.
    const inFlight = deps.lifecycle.inFlightCount();

    if (force) {
      deps.lifecycle.requestRestart("/reload --force", { force: true, source });
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

    const drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_RELOAD_DRAIN_TIMEOUT_MS;
    deps.lifecycle.requestRestart("/reload", { force: false, source, drainTimeoutMs });

    if (busySessions.length > 0 || inFlight > 0) {
      const blocking = [
        inFlight > 0 ? `${inFlight} 个 run 在飞` : "",
        busySessions.length > 0 ? `busy session：${busySessions.map((s) => s.name).join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("；");
      return {
        replyText:
          `⏳ 已排队重启（来源：${source}）：${blocking}。` +
          `最多等 ${Math.round(drainTimeoutMs / 1000)}s 让其收尾，超时自动强制重启。\n` +
          `（要立即强制、跳过在飞任务：/reload force）`,
      };
    }
    return { replyText: `✓ 重启中（来源：${source}），进程即将退出。` };
  };
}
