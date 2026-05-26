import type { ExitInfo } from "./types.js";

export type ExitTracker = {
  register(runId: string, exitPromise: Promise<ExitInfo>): void;
  lookup(runId: string): { exitCode?: number | null };
  clear(runId: string): void;
};

export function createExitTracker(): ExitTracker {
  const state = new Map<string, { exitCode: number | null | undefined; finished: boolean }>();

  return {
    register(runId, exitPromise) {
      state.set(runId, { exitCode: undefined, finished: false });
      exitPromise.then((info) => {
        state.set(runId, { exitCode: info.exitCode, finished: true });
      });
    },

    lookup(runId) {
      const entry = state.get(runId);
      if (!entry) return {};
      if (!entry.finished) return { exitCode: null };
      return { exitCode: entry.exitCode };
    },

    clear(runId) {
      state.delete(runId);
    },
  };
}
