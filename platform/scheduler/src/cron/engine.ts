import { Cron } from "croner";

type JobEntry = {
  name: string;
  cron: string;
  job: Cron;
  handler: () => void;
};

export type CronEngine = {
  register(name: string, cronExpr: string, handler: () => void): void;
  unregister(name: string): void;
  trigger(name: string): void;
  list(): Array<{ name: string; cron: string; nextRun: Date | null }>;
  stopAll(): void;
};

export function validateCron(pattern: string): boolean {
  try {
    const job = new Cron(pattern, { paused: true });
    job.stop();
    return true;
  } catch {
    return false;
  }
}

export function createCronEngine(): CronEngine {
  const jobs = new Map<string, JobEntry>();

  return {
    register(name, cronExpr, handler) {
      const job = new Cron(cronExpr, { paused: false }, handler);

      const existing = jobs.get(name);
      if (existing) existing.job.stop();

      jobs.set(name, { name, cron: cronExpr, job, handler });
    },

    unregister(name) {
      const entry = jobs.get(name);
      if (!entry) throw new Error(`Job not found: ${name}`);
      entry.job.stop();
      jobs.delete(name);
    },

    trigger(name) {
      const entry = jobs.get(name);
      if (!entry) throw new Error(`Job not found: ${name}`);
      entry.handler();
    },

    list() {
      return Array.from(jobs.values()).map((e) => ({
        name: e.name,
        cron: e.cron,
        nextRun: e.job.nextRun(),
      }));
    },

    stopAll() {
      for (const entry of jobs.values()) entry.job.stop();
      jobs.clear();
    },
  };
}
