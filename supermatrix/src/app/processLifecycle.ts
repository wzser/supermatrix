import type { Logger } from "../ports/Logger.ts";
import { errorMessage } from "./errorMessage.ts";

export type ProcessLifecycleOptions = {
  onExit: (reason: string, source: string | undefined) => Promise<void>;
  logger: Logger;
};

export type ProcessLifecycle = {
  runStarted(): void;
  runFinished(): void;
  requestRestart(reason: string, opts?: { force?: boolean; source?: string }): void;
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

  function maybeExit(): void {
    if (exiting) return;
    if (pendingReason === undefined) return;
    if (!pendingForce && inFlight > 0) {
      log.debug("restart pending but runs in flight", { inFlight, reason: pendingReason });
      return;
    }
    exiting = true;
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
      if (reqOpts?.force) {
        pendingForce = true;
        pendingReason = reason;
        pendingSource = reqOpts.source ?? pendingSource;
      } else if (pendingReason !== undefined) {
        return;
      } else {
        pendingReason = reason;
        pendingSource = reqOpts?.source;
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
