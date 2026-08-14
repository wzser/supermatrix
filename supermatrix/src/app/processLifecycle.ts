import type { Logger } from "../ports/Logger.ts";
import { errorMessage } from "./errorMessage.ts";

export type ProcessLifecycleOptions = {
  onExit: (reason: string, source: string | undefined) => Promise<void>;
  logger: Logger;
};

export type ProcessLifecycle = {
  runStarted(): void;
  runFinished(): void;
  requestRestart(
    reason: string,
    opts?: { force?: boolean; source?: string; drainTimeoutMs?: number },
  ): void;
  isPending(): boolean;
  isForce(): boolean;
  reason(): string | undefined;
  source(): string | undefined;
  inFlightCount(): number;
};

export function createProcessLifecycle(opts: ProcessLifecycleOptions): ProcessLifecycle {
  const log = opts.logger.child({ mod: "lifecycle" });
  let inFlight = 0;
  let pendingReason: string | undefined;
  let pendingForce = false;
  let pendingSource: string | undefined;
  let exiting = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  function clearDrainTimer(): void {
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = undefined;
    }
  }

  // Bounded drain: a non-force restart normally waits for in-flight runs to
  // finish (maybeExit defers while inFlight > 0). On a busy host that window can
  // never open, so a requested restart would hang indefinitely. Arm a timer that
  // escalates to a forced exit once the window elapses.
  function armDrain(drainTimeoutMs: number): void {
    if (drainTimer || exiting) return;
    drainTimer = setTimeout(() => {
      drainTimer = undefined;
      if (exiting || pendingReason === undefined) return;
      if (inFlight > 0) {
        log.info("restart drain window elapsed; forcing exit", {
          inFlight,
          reason: pendingReason,
          drainTimeoutMs,
        });
        pendingForce = true;
      }
      maybeExit();
    }, drainTimeoutMs);
    drainTimer.unref?.();
  }

  function maybeExit(): void {
    if (exiting) return;
    if (pendingReason === undefined) return;
    if (!pendingForce && inFlight > 0) {
      log.debug("restart pending but runs in flight", { inFlight, reason: pendingReason });
      return;
    }
    exiting = true;
    clearDrainTimer();
    log.info("restart: exiting", { reason: pendingReason, force: pendingForce, source: pendingSource, inFlight });
    opts.onExit(pendingReason, pendingSource).catch((err) => {
      log.error("onExit threw", { err: errorMessage(err) });
    });
  }

  return {
    runStarted() {
      inFlight++;
      log.debug("run started", { inFlight });
    },
    runFinished() {
      inFlight = Math.max(0, inFlight - 1);
      log.debug("run finished", { inFlight });
      maybeExit();
    },
    requestRestart(reason, reqOpts) {
      const drainTimeoutMs =
        reqOpts?.drainTimeoutMs && reqOpts.drainTimeoutMs > 0 ? reqOpts.drainTimeoutMs : undefined;
      if (reqOpts?.force) {
        pendingForce = true;
        pendingReason = reason;
        pendingSource = reqOpts.source ?? pendingSource;
      } else if (pendingReason !== undefined) {
        // A restart is already pending (e.g. from the source watcher). Still
        // honor a drain window so an in-flight-blocked restart can't defer
        // forever once a bounded request (e.g. /reload) arrives.
        if (drainTimeoutMs !== undefined) armDrain(drainTimeoutMs);
        return;
      } else {
        pendingReason = reason;
        pendingSource = reqOpts?.source;
        if (drainTimeoutMs !== undefined) armDrain(drainTimeoutMs);
      }
      log.info("restart pending", { reason });
      setImmediate(() => maybeExit());
    },
    isPending() { return pendingReason !== undefined; },
    isForce() { return pendingForce; },
    reason() { return pendingReason; },
    source() { return pendingSource; },
    inFlightCount() { return inFlight; },
  };
}
