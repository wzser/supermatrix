// src/adapters/process-lister-ps/index.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ListFilter,
  ProcessInfo,
  ProcessLister,
} from "../../ports/processLister.ts";

const pexecFile = promisify(execFile);

const RESUME_RE = /(?:--resume|resume)\s+([0-9a-f-]{36})/;

export function extractBackendSessionId(cmd: string): string | null {
  const match = cmd.match(RESUME_RE);
  return match ? match[1]! : null;
}

export function createPsProcessLister(): ProcessLister {
  return {
    async list(filter: ListFilter): Promise<ProcessInfo[]> {
      // `ps -e -o pid=,ppid=,command=`
      let stdout: string;
      try {
        const res = await pexecFile("/bin/ps", ["-e", "-o", "pid=,ppid=,command="], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
        stdout = res.stdout;
      } catch {
        return [];
      }
      const rows: ProcessInfo[] = [];
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const ppid = Number(m[2]);
        const cmd = m[3];
        if (filter.cmdPattern && !filter.cmdPattern.test(cmd)) continue;
        if (filter.ppid !== undefined && ppid !== filter.ppid) continue;
        const backendSessionId = extractBackendSessionId(cmd);
        let cwd: string | null = null;
        if (filter.cwdPrefix) {
          cwd = await getCwd(pid);
          if (!cwd || !cwd.startsWith(filter.cwdPrefix)) continue;
        }
        rows.push({ pid, ppid, cmd, cwd, backendSessionId });
      }
      return rows;
    },

    async killAll(pids: number[]): Promise<number[]> {
      const killed: number[] = [];
      for (const pid of pids) {
        try { process.kill(pid, "SIGTERM"); killed.push(pid); } catch { /* already dead */ }
      }
      // Wait up to 2s
      await new Promise((r) => setTimeout(r, 2000));
      for (const pid of pids) {
        try { process.kill(pid, 0); } catch { continue; } // already dead — skip SIGKILL
        try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
      }
      return killed;
    },

    async getCommand(pid: number): Promise<string | null> {
      try {
        const { stdout } = await pexecFile("/bin/ps", ["-p", String(pid), "-o", "command="], { timeout: 1000 });
        const cmd = stdout.trim();
        return cmd.length > 0 ? cmd : null;
      } catch {
        return null;
      }
    },

    async getProcessInfo(pid: number): Promise<{ pid: number; ppid: number; cmd: string } | null> {
      try {
        const { stdout } = await pexecFile("/bin/ps", ["-p", String(pid), "-o", "pid=,ppid=,command="], { timeout: 1000 });
        const m = stdout.trim().match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) return null;
        return { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! };
      } catch {
        return null;
      }
    },
  };
}

async function getCwd(pid: number): Promise<string | null> {
  try {
    const { stdout } = await pexecFile("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 1000 });
    // lsof -Fn outputs lines prefixed with 'n'
    for (const line of stdout.split("\n")) {
      if (line.startsWith("n")) return line.slice(1);
    }
    return null;
  } catch {
    return null;
  }
}
