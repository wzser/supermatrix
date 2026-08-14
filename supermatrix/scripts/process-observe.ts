#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const SCHEMA_VERSION = 2;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_GAP_THRESHOLD_MS = 10 * 60 * 1_000;
const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_RUNTIME_ROOT = "/Users/LOCAL_USER/SuperMatrixRuntime";
const RESERVED_PORTS = new Set([3500, 3501, 3502, 3510, 4322, 8787, 9481, 7897]);
const RUNTIME_COMMANDS = new Set([
  "bash", "bun", "deno", "go", "gunicorn", "java", "node", "npm", "php", "pm2", "pnpm", "python", "python3", "ruby", "sh", "tsx", "uvicorn", "yarn",
]);

type ProcessRow = {
  pid: number;
  ppid: number;
  pgid: number;
  startTime: string;
  tty: string;
  command: string;
  cwd?: string;
  listeningPorts: number[];
};

type ActiveInstance = {
  key: string;
  pid: number;
  ppid: number;
  pgid: number;
  startTime: string;
  tty: string;
  cwd?: string;
  commandHash: string;
  commandKind: string;
  commandPreview?: string;
  matchReasons: string[];
  listeningPorts: number[];
  firstObservedAt: string;
  lastObservedAt: string;
  observations: number;
};

type LifecycleEvent = {
  version: number;
  kind: "started" | "changed" | "exited";
  at: string;
  instance: ActiveInstance;
};

type CoverageGapEvent = {
  version: number;
  kind: "coverage-gap";
  at: string;
  previousObservedAt: string;
  gapMs: number;
};

type ObserveEvent = LifecycleEvent | CoverageGapEvent;

type ObserveState = {
  version: number;
  active: Record<string, ActiveInstance>;
};

type ObserveManifest = {
  version: number;
  startedAt: string;
  lastObservedAt: string;
  samples: number;
  collectorFailures: number;
  lastCollectorErrors: string[];
  coverageGaps: number;
  maxGapMs: number;
  gapThresholdMs: number;
  platformRoots: string[];
  reservedPorts: number[];
};

type Candidate = {
  row: ProcessRow;
  matchReasons: string[];
};

type CollectorResult = { output: string; error?: string };

function now(): Date {
  const override = process.env.PROCESS_OBSERVE_NOW;
  const parsed = override ? new Date(override) : new Date();
  if (Number.isNaN(parsed.valueOf())) throw new Error("PROCESS_OBSERVE_NOW is not a valid timestamp");
  return parsed;
}

function runtimeDir(): string {
  return process.env.PROCESS_OBSERVE_DIR ?? join(process.env.SM_RUNTIME_ROOT ?? DEFAULT_RUNTIME_ROOT, "data", "process-observe");
}

function platformRoots(): string[] {
  return [
    process.env.PROCESS_OBSERVE_REPO_ROOT ?? REPO_ROOT,
    process.env.PROCESS_OBSERVE_RUNTIME_ROOT ?? DEFAULT_RUNTIME_ROOT,
  ].map((root) => root.replace(/\/+$/, ""));
}

function gapThresholdMs(): number {
  const raw = Number(process.env.PROCESS_OBSERVE_GAP_THRESHOLD_MS ?? DEFAULT_GAP_THRESHOLD_MS);
  return Number.isFinite(raw) ? Math.max(60_000, Math.min(raw, DAY_MS * 14)) : DEFAULT_GAP_THRESHOLD_MS;
}

function capture(overrideEnv: string, command: string, args: string[]): CollectorResult {
  const override = process.env[overrideEnv];
  if (override !== undefined) return { output: override };
  try {
    return {
      output: String(execFileSync(command, args, { encoding: "utf8", timeout: 3_000, maxBuffer: 3 * 1024 * 1024 })),
    };
  } catch (error) {
    return { output: "", error: `${command}: ${(error as Error).message.slice(0, 180)}` };
  }
}

function parsePs(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const [pid, ppid, pgid] = match.slice(1, 4).map(Number);
    const command = match[6].trim();
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) || command === "") continue;
    rows.push({
      pid,
      ppid,
      pgid,
      startTime: match[4].trim().replace(/\s+/g, " "),
      tty: match[5],
      command,
      listeningPorts: [],
    });
  }
  return rows;
}

function parseCwds(output: string): Map<number, string> {
  const cwdByPid = new Map<number, string>();
  let currentPid: number | undefined;
  for (const line of output.split("\n")) {
    const pid = line.match(/^p(\d+)$/);
    if (pid) {
      currentPid = Number(pid[1]);
      continue;
    }
    if (currentPid !== undefined && line.startsWith("n/")) cwdByPid.set(currentPid, line.slice(1));
  }
  return cwdByPid;
}

function parseListeners(output: string): Map<number, number[]> {
  const portsByPid = new Map<number, number[]>();
  let currentPid: number | undefined;
  for (const line of output.split("\n")) {
    const pid = line.match(/^p(\d+)$/);
    if (pid) {
      currentPid = Number(pid[1]);
      continue;
    }
    const port = line.match(/^n.*:(\d+)$/);
    if (currentPid === undefined || !port) continue;
    const parsed = Number(port[1]);
    if (!Number.isSafeInteger(parsed)) continue;
    const ports = portsByPid.get(currentPid) ?? [];
    if (!ports.includes(parsed)) ports.push(parsed);
    portsByPid.set(currentPid, ports);
  }
  return portsByPid;
}

function isObserver(row: ProcessRow): boolean {
  return row.command.includes("process-observe.ts");
}

function commandKind(command: string): string {
  return basename(command.trim().split(/\s+/, 1)[0] || "unknown").toLowerCase();
}

function isRuntimeCommand(row: ProcessRow): boolean {
  return RUNTIME_COMMANDS.has(commandKind(row.command));
}

function isPlatformManagedBinary(command: string): boolean {
  return /^(?:\/Applications\/|\/Library\/Apple\/|\/System\/|\/usr\/libexec\/|\/usr\/sbin\/)/.test(command.trim());
}

function initialReasons(row: ProcessRow, roots: string[]): string[] {
  const reasons: string[] = ["user-process"];
  if (roots.some((root) => row.command.includes(root))) reasons.push("platform-command");
  const cwd = row.cwd;
  if (cwd && roots.some((root) => cwd === root || cwd.startsWith(`${root}/`))) reasons.push("platform-cwd");
  if (isRuntimeCommand(row)) reasons.push(`user-runtime:${commandKind(row.command)}`);
  if (row.tty === "??" && row.ppid === 1 && !isRuntimeCommand(row) && !isPlatformManagedBinary(row.command)) {
    reasons.push("unattributed-background-binary");
  }
  for (const port of row.listeningPorts) {
    reasons.push(`tcp-listener:${port}`);
    if (RESERVED_PORTS.has(port)) reasons.push(port === 3500 ? "retired-v1-listener" : `reserved-port:${port}`);
  }
  return [...new Set(reasons)].sort();
}

function discoverCandidates(rows: ProcessRow[], roots: string[]): Candidate[] {
  const candidates = new Map<number, Candidate>();
  for (const row of rows) {
    if (isObserver(row)) continue;
    candidates.set(row.pid, { row, matchReasons: initialReasons(row, roots) });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const candidate = candidates.get(row.pid);
      const parent = candidates.get(row.ppid);
      if (!candidate || !parent || candidate.matchReasons.includes("platform-descendant")) continue;
      if (!parent.matchReasons.includes("platform-command") && !parent.matchReasons.includes("platform-cwd") && !parent.matchReasons.includes("platform-descendant")) continue;
      candidate.matchReasons = [...candidate.matchReasons, "platform-descendant"].sort();
      changed = true;
    }
  }
  return [...candidates.values()].sort((a, b) => a.row.pid - b.row.pid);
}

function redactCommand(value: string): string {
  return value
    .replace(/((?:--?(?:token|secret|password|api[_-]?key)|authorization)\s*(?:=|\s+))[^\s&]+/gi, "$1[redacted]")
    .replace(/([?&](?:token|secret|password|api[_-]?key)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))=([^\s]+)/g, "$1=[redacted]");
}

function instanceKey(row: ProcessRow): string {
  return `${row.pid}:${createHash("sha256").update(row.startTime).digest("hex").slice(0, 16)}`;
}

function toInstance(candidate: Candidate, at: string, previous?: ActiveInstance): ActiveInstance {
  const redactedCommand = redactCommand(candidate.row.command).replace(/\s+/g, " ");
  const matchReasons = [...new Set(candidate.matchReasons)].sort();
  const listeningPorts = [...candidate.row.listeningPorts].sort((a, b) => a - b);
  const storesActionableEvidence = matchReasons.some((reason) => reason !== "user-process");
  return {
    key: instanceKey(candidate.row),
    pid: candidate.row.pid,
    ppid: candidate.row.ppid,
    pgid: candidate.row.pgid,
    startTime: candidate.row.startTime,
    tty: candidate.row.tty,
    ...(candidate.row.cwd && storesActionableEvidence ? { cwd: candidate.row.cwd } : {}),
    commandHash: createHash("sha256").update(redactedCommand).digest("hex"),
    commandKind: commandKind(candidate.row.command),
    ...(storesActionableEvidence ? { commandPreview: redactedCommand.slice(0, 240) } : {}),
    matchReasons,
    listeningPorts,
    firstObservedAt: previous?.firstObservedAt ?? at,
    lastObservedAt: at,
    observations: (previous?.observations ?? 0) + 1,
  };
}

function evidenceChanged(a: ActiveInstance, b: ActiveInstance): boolean {
  return a.commandHash !== b.commandHash || a.cwd !== b.cwd ||
    JSON.stringify(a.matchReasons) !== JSON.stringify(b.matchReasons) ||
    JSON.stringify(a.listeningPorts) !== JSON.stringify(b.listeningPorts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function emptyState(): ObserveState {
  return { version: SCHEMA_VERSION, active: {} };
}

function validateState(value: ObserveState | undefined): ObserveState {
  if (value === undefined) return emptyState();
  if (!isRecord(value) || value.version !== SCHEMA_VERSION || !isRecord(value.active)) {
    throw new Error("process-observe state is invalid; refusing to overwrite it");
  }
  return value;
}

function newManifest(at: string, roots: string[]): ObserveManifest {
  return {
    version: SCHEMA_VERSION,
    startedAt: at,
    lastObservedAt: at,
    samples: 0,
    collectorFailures: 0,
    lastCollectorErrors: [],
    coverageGaps: 0,
    maxGapMs: 0,
    gapThresholdMs: gapThresholdMs(),
    platformRoots: roots,
    reservedPorts: [...RESERVED_PORTS].sort((a, b) => a - b),
  };
}

function validateManifest(value: ObserveManifest | undefined, at: string, roots: string[]): ObserveManifest {
  if (value === undefined) return newManifest(at, roots);
  if (!isRecord(value) || value.version !== SCHEMA_VERSION || typeof value.startedAt !== "string") {
    throw new Error("process-observe manifest is invalid; refusing to overwrite it");
  }
  return value;
}

async function observe(): Promise<{
  ok: boolean;
  started: number;
  changed: number;
  exited: number;
  active: number;
  collectorErrors: string[];
  coverageGaps: number;
}> {
  const at = now().toISOString();
  const dir = runtimeDir();
  const roots = platformRoots();
  const ps = capture("PROCESS_OBSERVE_PS_OUTPUT", "ps", ["-x", "-o", "pid=,ppid=,pgid=,lstart=,tty=,command="]);
  if (ps.error) throw new Error(`process collector failed: ${ps.error}`);
  const ownUid = typeof process.getuid === "function" ? String(process.getuid()) : "";
  const ownUserArgs = ownUid ? ["-u", ownUid] : [];
  const cwd = capture("PROCESS_OBSERVE_CWD_OUTPUT", "lsof", ["-n", "-a", ...ownUserArgs, "-d", "cwd", "-Fpn"]);
  const listeners = capture("PROCESS_OBSERVE_LISTENERS_OUTPUT", "lsof", ["-nP", "-a", ...ownUserArgs, "-iTCP", "-sTCP:LISTEN", "-Fpn"]);
  const collectorErrors = [cwd.error, listeners.error].filter((value): value is string => Boolean(value));

  const cwdByPid = parseCwds(cwd.output);
  const listenersByPid = parseListeners(listeners.output);
  const rows: ProcessRow[] = parsePs(ps.output).map((row) => {
    const processCwd = cwdByPid.get(row.pid);
    return {
      ...row,
      ...(processCwd ? { cwd: processCwd } : {}),
      listeningPorts: listenersByPid.get(row.pid) ?? [],
    };
  });
  const candidates = discoverCandidates(rows, roots);
  const statePath = join(dir, "state.json");
  const manifestPath = join(dir, "manifest.json");
  const eventsPath = join(dir, "events.jsonl");
  const state = validateState(await readJson<ObserveState>(statePath));
  const manifest = validateManifest(await readJson<ObserveManifest>(manifestPath), at, roots);
  const nextActive: Record<string, ActiveInstance> = {};
  const events: ObserveEvent[] = [];
  const previousObservedAt = new Date(manifest.lastObservedAt);
  const gapMs = manifest.samples > 0 && !Number.isNaN(previousObservedAt.valueOf())
    ? new Date(at).valueOf() - previousObservedAt.valueOf()
    : 0;
  const hasCoverageGap = gapMs > manifest.gapThresholdMs;
  if (hasCoverageGap) {
    events.push({
      version: SCHEMA_VERSION,
      kind: "coverage-gap",
      at,
      previousObservedAt: manifest.lastObservedAt,
      gapMs,
    });
  }
  let started = 0;
  let changed = 0;

  for (const candidate of candidates) {
    const key = instanceKey(candidate.row);
    const previous = state.active[key];
    const current = toInstance(candidate, at, previous);
    nextActive[key] = current;
    if (!previous) {
      events.push({ version: SCHEMA_VERSION, kind: "started", at, instance: current });
      started++;
    } else if (evidenceChanged(previous, current)) {
      events.push({ version: SCHEMA_VERSION, kind: "changed", at, instance: current });
      changed++;
    }
  }

  let exited = 0;
  for (const [key, previous] of Object.entries(state.active)) {
    if (nextActive[key]) continue;
    events.push({ version: SCHEMA_VERSION, kind: "exited", at, instance: { ...previous, lastObservedAt: at } });
    exited++;
  }

  const nextManifest: ObserveManifest = {
    ...manifest,
    lastObservedAt: at,
    samples: Number.isSafeInteger(manifest.samples) ? manifest.samples + 1 : 1,
    collectorFailures: (Number.isSafeInteger(manifest.collectorFailures) ? manifest.collectorFailures : 0) + collectorErrors.length,
    lastCollectorErrors: collectorErrors,
    coverageGaps: (Number.isSafeInteger(manifest.coverageGaps) ? manifest.coverageGaps : 0) + (hasCoverageGap ? 1 : 0),
    maxGapMs: Math.max(Number.isFinite(manifest.maxGapMs) ? manifest.maxGapMs : 0, hasCoverageGap ? gapMs : 0),
    gapThresholdMs: Number.isFinite(manifest.gapThresholdMs) ? manifest.gapThresholdMs : gapThresholdMs(),
    platformRoots: roots,
    reservedPorts: [...RESERVED_PORTS].sort((a, b) => a - b),
  };
  await atomicWrite(statePath, { version: SCHEMA_VERSION, active: nextActive } satisfies ObserveState);
  await atomicWrite(manifestPath, nextManifest);
  if (events.length > 0) await appendFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });

  return {
    ok: collectorErrors.length === 0,
    started,
    changed,
    exited,
    active: Object.keys(nextActive).length,
    collectorErrors,
    coverageGaps: nextManifest.coverageGaps,
  };
}

type Classification = { kind: "known" | "known-descendant" | "baseline" | "review"; reason: string };

function classify(instance: ActiveInstance, byPid: Map<number, ActiveInstance>, seen = new Set<number>()): Classification {
  if (instance.matchReasons.includes("retired-v1-listener")) return { kind: "review", reason: "retired-v1-listener" };
  const value = instance.commandPreview ?? "";
  const known = [
    ["localwatch", /localwatch\.sh/],
    ["supermatrix", /src\/cli\/main\.ts/],
    ["scheduler-v2", /scheduler\/v2/],
    ["card-ask-broker", /card-callback.*broker\.js|broker\.js.*card-callback/],
    ["business-screen", /business-screen/],
    ["heartbeat-todo-watch", /heartbeat-todo-watch/],
    ["interactive-agent", /(^|\s)(codex|claude|kimi)(\s|$)/],
    ["managed-service", /clash-verge|ziniao/],
  ] as const;
  const hit = known.find(([, pattern]) => pattern.test(value));
  if (hit) return { kind: "known", reason: hit[0] };
  if (instance.matchReasons.includes("platform-command") || instance.matchReasons.includes("platform-cwd")) {
    return { kind: "known", reason: "platform-root" };
  }
  if (!seen.has(instance.pid)) {
    const parent = byPid.get(instance.ppid);
    if (parent) {
      seen.add(instance.pid);
      const parentClassification = classify(parent, byPid, seen);
      if (parentClassification.kind === "known" || parentClassification.kind === "known-descendant") {
        return { kind: "known-descendant", reason: "platform-descendant" };
      }
    }
  }
  if (instance.listeningPorts.length > 0) return { kind: "review", reason: "unattributed-tcp-listener" };
  if (instance.matchReasons.includes("unattributed-background-binary")) {
    return { kind: "review", reason: "unattributed-background-binary" };
  }
  if (instance.matchReasons.some((reason) => reason.startsWith("user-runtime:"))) {
    return instance.tty === "??"
      ? { kind: "review", reason: "unattributed-background-runtime" }
      : { kind: "baseline", reason: "interactive-runtime" };
  }
  return { kind: "baseline", reason: "user-process" };
}

async function readEvents(path: string): Promise<ObserveEvent[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.split("\n").filter(Boolean).flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as ObserveEvent;
        return parsed.version === SCHEMA_VERSION ? [parsed] : [];
      } catch {
        return [];
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function durationLabel(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return `${Math.floor(minutes / 1_440)}d ${Math.floor((minutes % 1_440) / 60)}h ${minutes % 60}m`;
}

async function report(): Promise<Record<string, unknown>> {
  const dir = runtimeDir();
  const manifest = await readJson<ObserveManifest>(join(dir, "manifest.json"));
  const state = await readJson<ObserveState>(join(dir, "state.json"));
  if (!manifest || !state) {
    return { ok: false, judgment: "not_started", message: "process observe data has not been initialized" };
  }
  const startedAt = new Date(manifest.startedAt);
  const lastObservedAt = new Date(manifest.lastObservedAt);
  if (Number.isNaN(startedAt.valueOf()) || Number.isNaN(lastObservedAt.valueOf())) {
    return { ok: false, judgment: "invalid_data", message: "process observe timestamps are invalid" };
  }
  const events = await readEvents(join(dir, "events.jsonl"));
  const activeByPid = new Map(Object.values(state.active).map((instance) => [instance.pid, instance]));
  const classified = Object.values(state.active).map((instance) => ({ instance, classification: classify(instance, activeByPid) }));
  const reviewQueue = classified.filter(({ classification }) => classification.kind === "review").map(({ instance, classification }) => ({
    pid: instance.pid,
    startTime: instance.startTime,
    commandPreview: instance.commandPreview ?? `[${instance.commandKind} #${instance.commandHash.slice(0, 12)}]`,
    reasons: [...instance.matchReasons, classification.reason],
    listeningPorts: instance.listeningPorts,
  }));
  const lifecycleEvents = events.filter((event): event is LifecycleEvent => event.kind !== "coverage-gap");
  const coverageGapEvents = events.filter((event): event is CoverageGapEvent => event.kind === "coverage-gap");
  const retiredV1Events = lifecycleEvents.filter((event) => event.instance.matchReasons.includes("retired-v1-listener"));
  const durationMs = lastObservedAt.valueOf() - startedAt.valueOf();
  const windowComplete = durationMs >= DAY_MS * 7;
  const judgment = !windowComplete || manifest.collectorFailures > 0 || manifest.coverageGaps > 0
    ? "observation_incomplete"
    : reviewQueue.length > 0 || retiredV1Events.length > 0
      ? "needs_human_review"
      : "ready_for_policy_design";
  const judgmentReasons = [
    ...(windowComplete ? [] : ["observation window is shorter than 7 days"]),
    ...(manifest.collectorFailures > 0 ? [`collector failures=${manifest.collectorFailures}`] : []),
    ...(manifest.coverageGaps > 0 ? [`coverage gaps=${manifest.coverageGaps} (max=${durationLabel(manifest.maxGapMs)}, threshold=${durationLabel(manifest.gapThresholdMs)})`] : []),
    ...(reviewQueue.length > 0 ? [`unreviewed runtime/listener candidates=${reviewQueue.length}`] : []),
    ...(retiredV1Events.length > 0 ? [`retired v1 listener observed=${retiredV1Events.length}`] : []),
  ];
  return {
    ok: true,
    generatedAt: now().toISOString(),
    observation: {
      startedAt: manifest.startedAt,
      lastObservedAt: manifest.lastObservedAt,
      durationMs,
      duration: durationLabel(durationMs),
      samples: manifest.samples,
      collectorFailures: manifest.collectorFailures,
      lastCollectorErrors: manifest.lastCollectorErrors,
      coverageGaps: manifest.coverageGaps,
      maxGapMs: manifest.maxGapMs,
      gapThresholdMs: manifest.gapThresholdMs,
    },
    windowComplete,
    events: {
      started: lifecycleEvents.filter((event) => event.kind === "started").length,
      changed: lifecycleEvents.filter((event) => event.kind === "changed").length,
      exited: lifecycleEvents.filter((event) => event.kind === "exited").length,
      coverageGaps: coverageGapEvents.length,
    },
    active: {
      total: classified.length,
      known: classified.filter(({ classification }) => classification.kind === "known").length,
      descendants: classified.filter(({ classification }) => classification.kind === "known-descendant").length,
      baseline: classified.filter(({ classification }) => classification.kind === "baseline").length,
      reviewQueue,
    },
    retiredV1Events: retiredV1Events.map((event) => ({ at: event.at, pid: event.instance.pid, commandPreview: event.instance.commandPreview })),
    judgment,
    judgmentReasons,
  };
}

function markdownReport(result: Record<string, unknown>): string {
  if (result.ok !== true) return `# 进程 Observe Only 验收报告\n\n- 判断：${String(result.judgment)}\n- 说明：${String(result.message ?? "unknown")}`;
  const observation = result.observation as Record<string, unknown>;
  const events = result.events as Record<string, unknown>;
  const active = result.active as Record<string, unknown>;
  const reviewQueue = active.reviewQueue as Array<Record<string, unknown>>;
  const reasons = result.judgmentReasons as string[];
  return [
    "# 进程 Observe Only 验收报告",
    "",
    `- 观察窗口：${String(observation.startedAt)} → ${String(observation.lastObservedAt)}（${String(observation.duration)}）`,
    `- 样本数：${String(observation.samples)}；采集失败：${String(observation.collectorFailures)}；连续性缺口：${String(observation.coverageGaps)}`,
    `- 生命周期事件：启动 ${String(events.started)}，变化 ${String(events.changed)}，退出 ${String(events.exited)}，覆盖缺口 ${String(events.coverageGaps)}`,
    `- 覆盖范围：当前用户进程全量（观察器自身除外）；其中已知 ${String(active.known)}，受控子进程 ${String(active.descendants)}，基线 ${String(active.baseline)}，待人工核查 ${reviewQueue.length}`,
    `- 验收判断：${String(result.judgment)}`,
    ...(reasons.length > 0 ? ["", "## 判断依据", ...reasons.map((reason) => `- ${reason}`)] : []),
    ...(reviewQueue.length > 0 ? ["", "## 待登记或裁决", ...reviewQueue.map((item) => `- PID ${String(item.pid)}｜${String(item.commandPreview)}｜${(item.reasons as string[]).join(", ")}`)] : []),
    "",
    "本轮仅记录与判断；未阻断、结束或唤起任何进程。",
  ].join("\n");
}

async function main(): Promise<void> {
  const [command = "observe", ...args] = process.argv.slice(2);
  if (command === "observe") {
    const result = await observe();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "report") {
    const result = await report();
    const format = args.includes("--format") ? args[args.indexOf("--format") + 1] : "json";
    if (format !== "json" && format !== "markdown") throw new Error("report --format must be json or markdown");
    process.stdout.write(format === "markdown" ? `${markdownReport(result)}\n` : `${JSON.stringify(result)}\n`);
    if (result.ok !== true) process.exitCode = 2;
    return;
  }
  throw new Error("usage: process-observe.ts [observe|report --format json|markdown]");
}

void main().catch((error) => {
  process.stderr.write(`process-observe: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
