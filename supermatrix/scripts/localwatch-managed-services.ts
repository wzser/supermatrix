#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, open as openFile, readFile, rename, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname } from "node:path";

const DEFAULT_CONFIG_PATH = "/Users/LOCAL_USER/SuperMatrixRuntime/config/localwatch-services.json";
const DEFAULT_STATE_PATH = "/Users/LOCAL_USER/SuperMatrixRuntime/data/localwatch-managed-services.state.json";
const PROCESS_TIMEOUT_MS = 3_000;
const TCP_TIMEOUT_MS = 3_000;
const ACTION_TIMEOUT_MS = 5_000;
const QUIT_CONFIRM_TIMEOUT_MS = 5_000;
const QUIT_CONFIRM_INTERVAL_MS = 200;

type RepairPolicy = "launch-if-absent" | "relaunch-on-unhealthy";
type ServiceStatus = "disabled" | "healthy" | "starting" | "unhealthy";
type NotificationKind = "config-error" | "failure-threshold" | "launch-attempt" | "recovered" | "state-error";

type ManagedService = {
  id: string;
  label: string;
  enabled: boolean;
  probes: {
    primaryProcess: string;
    requiredProcesses: string[];
    tcp: { host: "127.0.0.1"; port: number };
  };
  launch: { kind: "macos-app"; bundleId: string };
  repairPolicy: RepairPolicy;
  failureThreshold: number;
  cooldownSec: number;
  startupGraceSec: number;
};

type Registry = { version: 1; services: ManagedService[] };

type ServiceState = {
  consecutiveFailures: number;
  cooldownUntil: number;
  startupGraceUntil: number;
  lastCheckedAt: string;
  lastStatus: ServiceStatus;
  lastRecoveredAt?: string;
  lastAction?: {
    kind: "launch" | "relaunch";
    at: string;
    openAttempted: boolean;
    gracefulQuit?: boolean;
    quitConfirmed?: boolean;
  };
};

type ManagedState = {
  version: 1;
  updatedAt: string;
  services: Record<string, ServiceState>;
  lastConfigError?: string;
  lastConfigErrorAt?: string;
};

type ProcessProbe = {
  known: boolean;
  ok: boolean;
  primaryPresent: boolean;
  missing: string[];
  error?: string;
};

type TcpProbe = { ok: boolean; error?: string };

type ActionResult = {
  kind: "launch" | "relaunch";
  reason: "process-missing" | "unhealthy-threshold";
  gracefulQuit?: boolean;
  quitConfirmed?: boolean;
  openAttempted: boolean;
  openOk?: boolean;
  error?: string;
};

type ServiceResult = {
  id: string;
  label: string;
  enabled: boolean;
  status: ServiceStatus;
  failureCount: number;
  thresholdReached: boolean;
  recovered: boolean;
  probes: { process: ProcessProbe; tcp: TcpProbe };
  action: ActionResult | null;
};

type Notification = {
  kind: NotificationKind;
  serviceId?: string;
  label?: string;
  message: string;
};

type CheckOutput = {
  ok: boolean;
  checkedAt: string;
  configPath: string;
  statePath: string;
  configError?: string;
  stateError?: string;
  abnormalLabels: string[];
  notifications: Notification[];
  services: ServiceResult[];
};

type PlannedAction = {
  kind: "launch" | "relaunch";
  reason: "process-missing" | "unhealthy-threshold";
  service: ManagedService;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], context: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${context} must contain exactly: ${wanted.join(", ")}`);
  }
}

function assertString(value: unknown, context: string, pattern: RegExp, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !pattern.test(value)) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function assertExecutablePath(value: unknown, context: string): string {
  return assertString(value, context, /^\/[A-Za-z0-9 ._\/-]+$/, 180);
}

function assertBoundedInteger(value: unknown, context: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${context} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function parseRegistry(value: unknown): Registry {
  if (!isRecord(value)) throw new Error("registry must be an object");
  assertExactKeys(value, ["version", "services"], "registry");
  if (value.version !== 1) throw new Error("registry.version must be 1");
  if (!Array.isArray(value.services) || value.services.length === 0 || value.services.length > 32) {
    throw new Error("registry.services must contain 1 to 32 services");
  }

  const ids = new Set<string>();
  const services = value.services.map((candidate, index) => {
    const context = `registry.services[${index}]`;
    if (!isRecord(candidate)) throw new Error(`${context} must be an object`);
    assertExactKeys(candidate, [
      "id",
      "label",
      "enabled",
      "probes",
      "launch",
      "repairPolicy",
      "failureThreshold",
      "cooldownSec",
      "startupGraceSec",
    ], context);
    const id = assertString(candidate.id, `${context}.id`, /^[a-z0-9][a-z0-9-]{0,63}$/, 64);
    if (ids.has(id)) throw new Error(`${context}.id duplicates ${id}`);
    ids.add(id);
    const label = assertString(candidate.label, `${context}.label`, /^[^\t\r\n]{1,80}$/, 80);
    if (typeof candidate.enabled !== "boolean") throw new Error(`${context}.enabled must be boolean`);
    if (!isRecord(candidate.probes)) throw new Error(`${context}.probes must be an object`);
    assertExactKeys(candidate.probes, ["primaryProcess", "requiredProcesses", "tcp"], `${context}.probes`);
    const primaryProcess = assertExecutablePath(candidate.probes.primaryProcess, `${context}.probes.primaryProcess`);
    if (!Array.isArray(candidate.probes.requiredProcesses) || candidate.probes.requiredProcesses.length > 3) {
      throw new Error(`${context}.probes.requiredProcesses must contain 0 to 3 executable paths`);
    }
    const requiredProcesses = candidate.probes.requiredProcesses.map((processPath, processIndex) =>
      assertExecutablePath(processPath, `${context}.probes.requiredProcesses[${processIndex}]`),
    );
    if (new Set([primaryProcess, ...requiredProcesses]).size !== requiredProcesses.length + 1) {
      throw new Error(`${context}.probes executable paths must be unique`);
    }
    if (!isRecord(candidate.probes.tcp)) throw new Error(`${context}.probes.tcp must be an object`);
    assertExactKeys(candidate.probes.tcp, ["host", "port"], `${context}.probes.tcp`);
    if (candidate.probes.tcp.host !== "127.0.0.1") {
      throw new Error(`${context}.probes.tcp.host must be 127.0.0.1`);
    }
    const port = assertBoundedInteger(candidate.probes.tcp.port, `${context}.probes.tcp.port`, 1, 65_535);
    if (!isRecord(candidate.launch)) throw new Error(`${context}.launch must be an object`);
    assertExactKeys(candidate.launch, ["kind", "bundleId"], `${context}.launch`);
    if (candidate.launch.kind !== "macos-app") throw new Error(`${context}.launch.kind must be macos-app`);
    const bundleId = assertString(candidate.launch.bundleId, `${context}.launch.bundleId`, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 128);
    if (candidate.repairPolicy !== "launch-if-absent" && candidate.repairPolicy !== "relaunch-on-unhealthy") {
      throw new Error(`${context}.repairPolicy is invalid`);
    }
    return {
      id,
      label,
      enabled: candidate.enabled,
      probes: { primaryProcess, requiredProcesses, tcp: { host: "127.0.0.1", port } },
      launch: { kind: "macos-app", bundleId },
      repairPolicy: candidate.repairPolicy,
      failureThreshold: assertBoundedInteger(candidate.failureThreshold, `${context}.failureThreshold`, 1, 10),
      cooldownSec: assertBoundedInteger(candidate.cooldownSec, `${context}.cooldownSec`, 1, 3_600),
      startupGraceSec: assertBoundedInteger(candidate.startupGraceSec, `${context}.startupGraceSec`, 1, 600),
    } satisfies ManagedService;
  });
  return { version: 1, services };
}

function emptyState(now: Date): ManagedState {
  return { version: 1, updatedAt: now.toISOString(), services: {} };
}

function parseServiceState(value: unknown): ServiceState | undefined {
  if (!isRecord(value)) return undefined;
  const status = value.lastStatus;
  if (status !== "disabled" && status !== "healthy" && status !== "starting" && status !== "unhealthy") return undefined;
  if (
    typeof value.consecutiveFailures !== "number" || !Number.isSafeInteger(value.consecutiveFailures) || value.consecutiveFailures < 0 ||
    typeof value.cooldownUntil !== "number" || !Number.isFinite(value.cooldownUntil) ||
    typeof value.startupGraceUntil !== "number" || !Number.isFinite(value.startupGraceUntil) ||
    typeof value.lastCheckedAt !== "string"
  ) {
    return undefined;
  }
  const state: ServiceState = {
    consecutiveFailures: value.consecutiveFailures,
    cooldownUntil: value.cooldownUntil,
    startupGraceUntil: value.startupGraceUntil,
    lastCheckedAt: value.lastCheckedAt,
    lastStatus: status,
  };
  if (typeof value.lastRecoveredAt === "string") state.lastRecoveredAt = value.lastRecoveredAt;
  if (isRecord(value.lastAction) && (value.lastAction.kind === "launch" || value.lastAction.kind === "relaunch") && typeof value.lastAction.at === "string" && typeof value.lastAction.openAttempted === "boolean") {
    state.lastAction = {
      kind: value.lastAction.kind,
      at: value.lastAction.at,
      openAttempted: value.lastAction.openAttempted,
      ...(typeof value.lastAction.gracefulQuit === "boolean" ? { gracefulQuit: value.lastAction.gracefulQuit } : {}),
      ...(typeof value.lastAction.quitConfirmed === "boolean" ? { quitConfirmed: value.lastAction.quitConfirmed } : {}),
    };
  }
  return state;
}

async function readState(path: string, now: Date): Promise<{ state: ManagedState; warning?: string }> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.services)) {
      return { state: emptyState(now), warning: "managed-service state is invalid; starting a fresh state" };
    }
    const services: Record<string, ServiceState> = {};
    for (const [id, value] of Object.entries(parsed.services)) {
      const state = parseServiceState(value);
      if (state) services[id] = state;
    }
    return {
      state: {
        version: 1,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : now.toISOString(),
        services,
        ...(typeof parsed.lastConfigError === "string" ? { lastConfigError: parsed.lastConfigError } : {}),
        ...(typeof parsed.lastConfigErrorAt === "string" ? { lastConfigErrorAt: parsed.lastConfigErrorAt } : {}),
      },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: emptyState(now) };
    return { state: emptyState(now), warning: `cannot read managed-service state: ${errorMessage(error)}` };
  }
}

async function writeStateAtomic(path: string, state: ManagedState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    const handle = await openFile(temporaryPath, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function initialServiceState(now: Date): ServiceState {
  return {
    consecutiveFailures: 0,
    cooldownUntil: 0,
    startupGraceUntil: 0,
    lastCheckedAt: now.toISOString(),
    lastStatus: "unhealthy",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[\r\n\t]/g, " ").slice(0, 300) : String(error).slice(0, 300);
}

function runBounded(command: string, args: string[], timeoutMs: number): { ok: boolean; error?: string; stdout: string } {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1_000_000 });
  const stdout = String(result.stdout ?? "");
  if (result.error) return { ok: false, error: errorMessage(result.error), stdout };
  if (result.status !== 0) {
    return { ok: false, error: String(result.stderr ?? `exit ${result.status ?? "unknown"}`).trim().slice(0, 300), stdout };
  }
  return { ok: true, stdout };
}

function trackedProcessPaths(probes: ManagedService["probes"]): string[] {
  return [probes.primaryProcess, ...probes.requiredProcesses];
}

function commandHasExecutable(commandLine: string, executablePath: string): boolean {
  const command = commandLine.trimStart();
  return command === executablePath || (command.startsWith(executablePath) && /\s/.test(command.charAt(executablePath.length)));
}

function probeProcesses(probes: ManagedService["probes"]): ProcessProbe {
  const trackedPaths = trackedProcessPaths(probes);
  const command = runBounded("ps", ["-axo", "command="], PROCESS_TIMEOUT_MS);
  if (!command.ok) {
    return {
      known: false,
      ok: false,
      primaryPresent: false,
      missing: trackedPaths,
      error: command.error || "ps failed",
    };
  }
  const commandLines = command.stdout.split(/\r?\n/);
  const missing = trackedPaths.filter((executablePath) => !commandLines.some((commandLine) => commandHasExecutable(commandLine, executablePath)));
  return {
    known: true,
    ok: missing.length === 0,
    primaryPresent: !missing.includes(probes.primaryProcess),
    missing,
  };
}

function probeTcp(host: "127.0.0.1", port: number): Promise<TcpProbe> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ host, port });
    const finish = (result: TcpProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "tcp timeout" }), TCP_TIMEOUT_MS);
    socket.once("connect", () => finish({ ok: true }));
    socket.once("error", (error) => finish({ ok: false, error: errorMessage(error) }));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function confirmProcessesAbsent(service: ManagedService): Promise<boolean> {
  const trackedPaths = trackedProcessPaths(service.probes);
  const deadline = Date.now() + QUIT_CONFIRM_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const probe = probeProcesses(service.probes);
    if (probe.known && probe.missing.length === trackedPaths.length) return true;
    if (!probe.known) return false;
    await sleep(QUIT_CONFIRM_INTERVAL_MS);
  }
  return false;
}

function launchApp(service: ManagedService): { ok: boolean; error?: string } {
  const command = runBounded("open", ["-g", "-b", service.launch.bundleId], ACTION_TIMEOUT_MS);
  return { ok: command.ok, ...(command.error ? { error: command.error } : {}) };
}

async function executeAction(plan: PlannedAction): Promise<ActionResult> {
  if (plan.kind === "launch") {
    const opened = launchApp(plan.service);
    return {
      kind: "launch",
      reason: plan.reason,
      openAttempted: true,
      openOk: opened.ok,
      ...(opened.error ? { error: opened.error } : {}),
    };
  }

  const quit = runBounded(
    "osascript",
    ["-e", `tell application id \"${plan.service.launch.bundleId}\" to quit`],
    ACTION_TIMEOUT_MS,
  );
  const quitConfirmed = await confirmProcessesAbsent(plan.service);
  if (!quitConfirmed) {
    return {
      kind: "relaunch",
      reason: plan.reason,
      gracefulQuit: true,
      quitConfirmed: false,
      openAttempted: false,
      ...(quit.error ? { error: quit.error } : { error: "process did not exit after graceful quit" }),
    };
  }
  const opened = launchApp(plan.service);
  return {
    kind: "relaunch",
    reason: plan.reason,
    gracefulQuit: true,
    quitConfirmed: true,
    openAttempted: true,
    openOk: opened.ok,
    ...(opened.error ? { error: opened.error } : {}),
  };
}

function serviceNotification(kind: NotificationKind, service: ManagedService | undefined, message: string): Notification {
  return {
    kind,
    ...(service ? { serviceId: service.id, label: service.label } : {}),
    message,
  };
}

async function runCheck(configPath: string, statePath: string): Promise<{ output: CheckOutput; exitCode: number }> {
  const now = new Date();
  const checkedAt = now.toISOString();
  const loadedState = await readState(statePath, now);
  const notifications: Notification[] = [];
  if (loadedState.warning) notifications.push(serviceNotification("state-error", undefined, loadedState.warning));

  let registry: Registry;
  try {
    registry = parseRegistry(JSON.parse(await readFile(configPath, "utf8")) as unknown);
  } catch (error) {
    const configError = `managed-service registry rejected: ${errorMessage(error)}`;
    const isNewConfigError = loadedState.state.lastConfigError !== configError;
    loadedState.state.updatedAt = checkedAt;
    loadedState.state.lastConfigError = configError;
    if (isNewConfigError) loadedState.state.lastConfigErrorAt = checkedAt;
    let stateError: string | undefined;
    try {
      await writeStateAtomic(statePath, loadedState.state);
    } catch (stateWriteError) {
      stateError = `cannot persist managed-service state: ${errorMessage(stateWriteError)}`;
      notifications.push(serviceNotification("state-error", undefined, stateError));
    }
    if (isNewConfigError) notifications.push(serviceNotification("config-error", undefined, configError));
    return {
      exitCode: 2,
      output: {
        ok: false,
        checkedAt,
        configPath,
        statePath,
        configError,
        ...(stateError ? { stateError } : {}),
        abnormalLabels: ["managed-services config"],
        notifications,
        services: [],
      },
    };
  }

  delete loadedState.state.lastConfigError;
  delete loadedState.state.lastConfigErrorAt;
  const plannedActions: Array<{ plan: PlannedAction; result: ServiceResult; state: ServiceState }> = [];
  const results: ServiceResult[] = [];
  for (const service of registry.services) {
    const persistedPrevious = loadedState.state.services[service.id];
    const previous = persistedPrevious ?? initialServiceState(now);
    const processProbe = service.enabled
      ? probeProcesses(service.probes)
      : { known: true, ok: true, primaryPresent: true, missing: [] } satisfies ProcessProbe;
    const tcpProbe = service.enabled ? await probeTcp(service.probes.tcp.host, service.probes.tcp.port) : { ok: true } satisfies TcpProbe;
    const allHealthy = processProbe.known && processProbe.ok && tcpProbe.ok;
    const failureCount = service.enabled && !allHealthy ? previous.consecutiveFailures + 1 : 0;
    const recovered = persistedPrevious !== undefined && service.enabled && allHealthy && (previous.lastStatus === "unhealthy" || previous.lastStatus === "starting");
    const thresholdReached = service.enabled && !allHealthy && failureCount === service.failureThreshold;
    const underCooldown = previous.cooldownUntil > now.getTime();
    const inStartupGrace = previous.startupGraceUntil > now.getTime();
    const state: ServiceState = {
      ...previous,
      consecutiveFailures: failureCount,
      lastCheckedAt: checkedAt,
      lastStatus: !service.enabled ? "disabled" : allHealthy ? "healthy" : inStartupGrace ? "starting" : "unhealthy",
      ...(recovered ? { lastRecoveredAt: checkedAt } : {}),
    };
    let plan: PlannedAction | undefined;
    if (service.enabled && !allHealthy && processProbe.known && !underCooldown && !inStartupGrace) {
      if (!processProbe.primaryPresent) {
        plan = { kind: "launch", reason: "process-missing", service };
      } else if (service.repairPolicy === "relaunch-on-unhealthy" && failureCount >= service.failureThreshold) {
        plan = { kind: "relaunch", reason: "unhealthy-threshold", service };
      }
    }
    if (plan) {
      state.cooldownUntil = now.getTime() + service.cooldownSec * 1_000;
      state.startupGraceUntil = now.getTime() + service.startupGraceSec * 1_000;
      state.lastStatus = "starting";
    }
    if (allHealthy) {
      state.cooldownUntil = 0;
      state.startupGraceUntil = 0;
    }
    loadedState.state.services[service.id] = state;
    const result: ServiceResult = {
      id: service.id,
      label: service.label,
      enabled: service.enabled,
      status: state.lastStatus,
      failureCount,
      thresholdReached,
      recovered,
      probes: { process: processProbe, tcp: tcpProbe },
      action: null,
    };
    results.push(result);
    if (thresholdReached) {
      notifications.push(serviceNotification("failure-threshold", service, `${service.label} reached ${service.failureThreshold} consecutive failed probe(s)`));
    }
    if (recovered) notifications.push(serviceNotification("recovered", service, `${service.label} real probes recovered`));
    if (plan) plannedActions.push({ plan, result, state });
  }

  loadedState.state.updatedAt = checkedAt;
  if (plannedActions.length > 0) {
    try {
      await writeStateAtomic(statePath, loadedState.state);
    } catch (error) {
      const stateError = `cannot persist managed-service state before repair: ${errorMessage(error)}`;
      notifications.push(serviceNotification("state-error", undefined, stateError));
      for (const { result, state } of plannedActions) {
        state.startupGraceUntil = 0;
        state.lastStatus = "unhealthy";
        result.status = "unhealthy";
      }
      return {
        exitCode: 1,
        output: {
          ok: false,
          checkedAt,
          configPath,
          statePath,
          stateError,
          abnormalLabels: results.filter((result) => result.status !== "healthy" && result.status !== "disabled").map((result) => result.label),
          notifications,
          services: results,
        },
      };
    }
  }

  for (const entry of plannedActions) {
    const action = await executeAction(entry.plan);
    entry.result.action = action;
    entry.state.lastAction = {
      kind: action.kind,
      at: checkedAt,
      openAttempted: action.openAttempted,
      ...(action.gracefulQuit !== undefined ? { gracefulQuit: action.gracefulQuit } : {}),
      ...(action.quitConfirmed !== undefined ? { quitConfirmed: action.quitConfirmed } : {}),
    };
    if (!action.openOk) {
      entry.state.lastStatus = "unhealthy";
      entry.state.startupGraceUntil = 0;
      entry.result.status = "unhealthy";
    }
    notifications.push(serviceNotification(
      "launch-attempt",
      entry.plan.service,
      action.openAttempted
        ? `${entry.plan.service.label} ${action.kind} attempt ${action.openOk ? "requested" : "failed"}; awaiting a later real probe`
        : `${entry.plan.service.label} relaunch stopped before open: ${action.error ?? "graceful quit was not confirmed"}`,
    ));
  }

  let stateError: string | undefined;
  try {
    await writeStateAtomic(statePath, loadedState.state);
  } catch (error) {
    stateError = `cannot persist managed-service state: ${errorMessage(error)}`;
    notifications.push(serviceNotification("state-error", undefined, stateError));
  }
  return {
    exitCode: stateError ? 1 : 0,
    output: {
      ok: !stateError,
      checkedAt,
      configPath,
      statePath,
      ...(stateError ? { stateError } : {}),
      abnormalLabels: results.filter((result) => result.status !== "healthy" && result.status !== "disabled").map((result) => result.label),
      notifications,
      services: results,
    },
  };
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "check";
  const configPath = process.env.LOCALWATCH_MANAGED_SERVICES_CONFIG || DEFAULT_CONFIG_PATH;
  const statePath = process.env.LOCALWATCH_MANAGED_SERVICES_STATE || DEFAULT_STATE_PATH;
  if (command !== "check") {
    const output: CheckOutput = {
      ok: false,
      checkedAt: new Date().toISOString(),
      configPath,
      statePath,
      configError: "only the check command is supported",
      abnormalLabels: ["managed-services config"],
      notifications: [serviceNotification("config-error", undefined, "only the check command is supported")],
      services: [],
    };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = 2;
    return;
  }
  const { output, exitCode } = await runCheck(configPath, statePath);
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = exitCode;
}

void main().catch((error) => {
  const message = `managed-service helper failed: ${errorMessage(error)}`;
  const output: CheckOutput = {
    ok: false,
    checkedAt: new Date().toISOString(),
    configPath: process.env.LOCALWATCH_MANAGED_SERVICES_CONFIG || DEFAULT_CONFIG_PATH,
    statePath: process.env.LOCALWATCH_MANAGED_SERVICES_STATE || DEFAULT_STATE_PATH,
    configError: message,
    abnormalLabels: ["managed-services config"],
    notifications: [serviceNotification("config-error", undefined, message)],
    services: [],
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = 2;
});
