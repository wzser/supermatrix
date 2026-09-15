// tests/fakes/fakeProcessLister.ts
import type {
  ListFilter,
  ProcessInfo,
  ProcessLister,
} from "../../src/ports/processLister.ts";

export type FakeProcessListerOpts = {
  processes?: ProcessInfo[];
  commandByPid?: Record<number, string>;
  ppidByPid?: Record<number, number>;
  onKill?: (pids: number[]) => number[];
};

export function createFakeProcessLister(
  opts: FakeProcessListerOpts = {}
): ProcessLister & { killedPids: number[] } {
  const killed: number[] = [];
  const processes = opts.processes ?? [];
  return {
    async list(filter: ListFilter): Promise<ProcessInfo[]> {
      return processes.filter((p) => {
        if (filter.cmdPattern && !filter.cmdPattern.test(p.cmd)) return false;
        if (filter.cwdPrefix && !p.cwd?.startsWith(filter.cwdPrefix)) return false;
        if (filter.ppid !== undefined && p.ppid !== filter.ppid) return false;
        return true;
      });
    },
    async killAll(pids: number[]): Promise<number[]> {
      const actually = opts.onKill ? opts.onKill(pids) : pids;
      killed.push(...actually);
      return actually;
    },
    async getCommand(pid: number): Promise<string | null> {
      return opts.commandByPid?.[pid] ?? null;
    },
    async getProcessInfo(pid: number): Promise<{ pid: number; ppid: number; cmd: string } | null> {
      const cmd = opts.commandByPid?.[pid];
      if (cmd === undefined) return null;
      const ppid = opts.ppidByPid?.[pid] ?? 0;
      return { pid, ppid, cmd };
    },
    get killedPids(): number[] {
      return killed;
    },
  };
}
