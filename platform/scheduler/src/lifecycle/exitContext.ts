import type { ExitTracker } from "./exitTracker.js";
import type { TaskStore } from "../db/taskStore.js";

export type ExitContext = {
  exitCode?: number | null;
  childSessionId?: string | null;
  asyncRef?: string | null;
  smBaseUrl?: string;
};

// Memory has the live child's exit code; DB has it after the .then handler
// persisted it. Falling back covers the case where the scheduler bounced
// between child clean-exit and the verify tick — the only place this fires.
export function createLookupExitContext(deps: {
  exitTracker: ExitTracker;
  store: Pick<TaskStore, "getRun">;
  smBaseUrl: string;
}): (runId: string) => ExitContext {
  return (runId) => {
    const tracked = deps.exitTracker.lookup(runId);
    const persisted = deps.store.getRun(runId);
    const exitCode =
      tracked.exitCode !== undefined
        ? tracked.exitCode
        : (persisted?.exitCode ?? null);
    return {
      exitCode,
      childSessionId: persisted?.childSessionId ?? null,
      asyncRef: persisted?.asyncRef ?? null,
      smBaseUrl: deps.smBaseUrl,
    };
  };
}
