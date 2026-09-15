// src/adapters/backend-kimi/processActivity.ts
//
// Liveness probe for the inactivity watchdog. A turn that emits no ACP
// updates is only *wedged* when the backend process tree shows no signs of
// work at all: in-process subagents and long tool calls (bash, builds,
// test runs) legitimately stay silent on the ACP stream for many minutes,
// so output silence alone is a bad hung-signal. Two local signals are
// sampled around a probe window, and either one counts as alive:
//   - CPU advance in the backend process tree (local tool calls);
//   - network byte growth in the tree (in-flight LLM API streaming —
//     subagent LLM calls burn ~0 local CPU while waiting on the wire).
// (2026-07-20: a kimiroot turn was killed at the 900s silence mark while a
// foreground subagent was still working — fixed by the CPU probe.
// 2026-07-21: an adjust2 turn was killed the same way while its coder
// subagent was mid-LLM-call, CPU flat — fixed by adding the nettop probe.)

import { execFile } from "node:child_process";

export type ExecFileFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

/** `false` is confirmed idle; unknown probe results must never be treated as idle. */
export type ProcessActivityProbeResult =
  | boolean
  | { kind: "unknown"; reason: string };

const defaultExec: ExecFileFn = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 5_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout });
    });
  });

/** Parses `ps` TIME values: [[dd-]hh:]mm:ss, optional fraction (macOS prints hundredths: `1:00.69`). */
export function parsePsTimeMs(raw: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(raw.trim());
  if (!m) return null;
  const days = m[1] ? Number(m[1]) : 0;
  const hours = m[2] !== undefined ? Number(m[2]) : 0;
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  return Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000);
}

/** Pids of `rootPid` and all its descendants from `ps -axo pid=,ppid=,...` output. */
export function collectProcessTreePids(psOutput: string, rootPid: number): Set<number> {
  const childrenByPpid = new Map<number, number[]>();
  for (const line of psOutput.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    const pid = Number(cols[0]);
    const ppid = Number(cols[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const list = childrenByPpid.get(ppid) ?? [];
    list.push(pid);
    childrenByPpid.set(ppid, list);
  }
  const pids = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.pop()!;
    if (pids.has(pid)) continue;
    pids.add(pid);
    for (const child of childrenByPpid.get(pid) ?? []) queue.push(child);
  }
  return pids;
}

/** Sums the cumulative CPU ms of `rootPid` and all its descendants from `ps -axo pid=,ppid=,time=` output. */
export function sumProcessTreeCpuMs(psOutput: string, rootPid: number): number {
  const cpuByPid = new Map<number, number>();
  for (const line of psOutput.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    const pid = Number(cols[0]);
    const cpuMs = parsePsTimeMs(cols[2]!);
    if (!Number.isInteger(pid) || cpuMs === null) continue;
    cpuByPid.set(pid, cpuMs);
  }
  let total = 0;
  for (const pid of collectProcessTreePids(psOutput, rootPid)) {
    total += cpuByPid.get(pid) ?? 0;
  }
  return total;
}

/**
 * Sums cumulative net bytes (in+out) of `pids` from
 * `nettop -l 1 -x -J bytes_in,bytes_out` output. Process rows start at
 * column 0 as `<name>.<pid>` followed by the two byte counters; indented
 * per-connection rows and the header are ignored.
 */
export function sumNettopBytesForPids(nettopOutput: string, pids: ReadonlySet<number>): number {
  let total = 0;
  for (const line of nettopOutput.split("\n")) {
    if (line === "" || line.startsWith(" ") || line.startsWith("\t")) continue;
    const m = /^.+\.(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    if (pids.has(Number(m[1]))) total += Number(m[2]) + Number(m[3]);
  }
  return total;
}

/** Total cumulative CPU ms of the process tree rooted at `pid`, or null when `ps` fails. */
export async function sampleProcessTreeCpuMs(pid: number, exec: ExecFileFn = defaultExec): Promise<number | null> {
  try {
    const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,time="]);
    return sumProcessTreeCpuMs(stdout, pid);
  } catch {
    return null;
  }
}

/** Total cumulative net bytes (in+out) of the tree rooted at `pid`, or null when `nettop` fails. */
export async function sampleProcessTreeNetBytes(
  psOutput: string,
  pid: number,
  exec: ExecFileFn = defaultExec,
): Promise<number | null> {
  try {
    const { stdout } = await exec("nettop", ["-l", "1", "-x", "-J", "bytes_in,bytes_out"]);
    return sumNettopBytesForPids(stdout, collectProcessTreePids(psOutput, pid));
  } catch {
    return null;
  }
}

export type ProcessActivityProbeDeps = {
  exec?: ExecFileFn;
  sleep?: (ms: number) => Promise<void>;
};

// macOS ps TIME resolution is 10ms; require an advance beyond two ticks so
// rounding cannot masquerade as work. An idle event loop burns ~0 CPU over
// the probe window; any real tool call burns orders of magnitude more.
const CPU_ADVANCE_EPSILON_MS = 20;

type ActivitySample = { cpuMs: number; netBytes: number | null };

const sampleActivity = async (pid: number, exec: ExecFileFn): Promise<ActivitySample | null> => {
  let psOutput: string;
  try {
    ({ stdout: psOutput } = await exec("ps", ["-axo", "pid=,ppid=,time="]));
  } catch {
    return null;
  }
  return {
    cpuMs: sumProcessTreeCpuMs(psOutput, pid),
    netBytes: await sampleProcessTreeNetBytes(psOutput, pid, exec),
  };
};

/**
 * Two activity samples `probeWindowMs` apart: true when the process tree
 * rooted at `pid` kept working (i.e. it is not wedged), where "working" is
 * either CPU advance (local tool calls) or net byte growth (in-flight LLM
 * API streaming, which burns ~0 local CPU). A `ps` sampling failure is
 * unknown rather than idle, so the caller can retry without cancelling a
 * possibly active turn; a `nettop` failure degrades the verdict to
 * CPU-only instead of disabling the watchdog.
 */
export async function isProcessTreeActive(
  pid: number,
  probeWindowMs: number,
  deps: ProcessActivityProbeDeps = {},
): Promise<ProcessActivityProbeResult> {
  const exec = deps.exec ?? defaultExec;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const before = await sampleActivity(pid, exec);
  if (before === null) {
    return { kind: "unknown", reason: "ps sample unavailable before CPU probe window" };
  }
  await sleep(probeWindowMs);
  const after = await sampleActivity(pid, exec);
  if (after === null) {
    return { kind: "unknown", reason: "ps sample unavailable after CPU probe window" };
  }
  if (after.cpuMs - before.cpuMs >= CPU_ADVANCE_EPSILON_MS) return true;
  if (before.netBytes !== null && after.netBytes !== null) {
    return after.netBytes > before.netBytes;
  }
  return false;
}
