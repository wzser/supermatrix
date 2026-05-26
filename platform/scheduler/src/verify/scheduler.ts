import { runVerification, type VerifyDeps } from "./runner.js";

export type StartOptions = VerifyDeps & {
  tickIntervalMs: number;
  onTick?: () => void;
};

export function startVerifyScheduler(opts: StartOptions): () => void {
  let stopped = false;

  async function tick() {
    if (stopped) return;
    opts.onTick?.();
    const now = Date.now();
    const due = opts.verifyStore.pollDue(now);
    for (const verification of due) {
      if (stopped) break;
      try {
        await runVerification(verification.id, opts);
      } catch (err) {
        console.error(`verify runner error for ${verification.id}:`, err);
      }
    }
  }

  const handle = setInterval(tick, opts.tickIntervalMs);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
