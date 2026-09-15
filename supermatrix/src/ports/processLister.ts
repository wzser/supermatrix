// src/ports/processLister.ts
export type ProcessInfo = {
  pid: number;
  ppid: number;
  cmd: string;
  cwd: string | null;
  backendSessionId: string | null; // UUID extracted from --resume <uuid>
};

export type ListFilter = {
  cmdPattern: RegExp;       // e.g. /(claude|codex).*--resume\s+([0-9a-f-]{36})/
  cwdPrefix?: string;       // restrict to processes whose cwd starts with this
  ppid?: number;            // if set, only return processes with this PPID
};

export type ProcessLister = {
  list(filter: ListFilter): Promise<ProcessInfo[]>;
  /** Send SIGTERM, wait 2s, then SIGKILL any still-alive. Returns pids actually killed. */
  killAll(pids: number[]): Promise<number[]>;
  /** Fetch command line of a given PID (used by supervisor-presence). Returns null if not found. */
  getCommand(pid: number): Promise<string | null>;
  /**
   * Fetch both command line and parent PID for a given PID. Used by
   * supervisor-presence which walks the process tree to find the real
   * supervisor (e.g., dev-loop.sh) above the tsx CLI wrapper. Returns
   * null if the process is not found.
   */
  getProcessInfo(pid: number): Promise<{ pid: number; ppid: number; cmd: string } | null>;
};
