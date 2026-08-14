import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const HELPER_PATH = resolve(REPO_ROOT, "scripts/localwatch-managed-services.ts");
const TSX_PATH = resolve(REPO_ROOT, "node_modules/.bin/tsx");
const TEMPLATE_PATH = resolve(REPO_ROOT, "templates/localwatch-services.json");
const CLASH_VERGE_EXECUTABLE = "/Applications/Clash Verge.app/Contents/MacOS/clash-verge";
const VERGE_MIHOMO_EXECUTABLE = "/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo";
const ZINIAO_EXECUTABLE = "/Applications/ziniao.app/Contents/MacOS/ziniao";

type ServiceConfig = {
  id: string;
  label: string;
  enabled: boolean;
  probes: {
    primaryProcess: string;
    requiredProcesses: string[];
    tcp: { host: "127.0.0.1"; port: number };
  };
  launch: { kind: "macos-app"; bundleId: string };
  repairPolicy: "relaunch-on-unhealthy" | "launch-if-absent";
  failureThreshold: number;
  cooldownSec: number;
  startupGraceSec: number;
};

type ManagedResult = {
  ok: boolean;
  configError?: string;
  abnormalLabels: string[];
  notifications: Array<{ kind: string; label?: string }>;
  services: Array<{
    id: string;
    status: string;
    failureCount: number;
    recovered: boolean;
    thresholdReached: boolean;
    action: null | { kind: string; gracefulQuit?: boolean; openAttempted?: boolean };
  }>;
};

function unusedPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function startTcpServer(): Promise<{ close: () => Promise<void>; port: number }> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

function ziniao(port: number, overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    id: "ziniao",
    label: "ZiNiao",
    enabled: true,
    probes: {
      primaryProcess: ZINIAO_EXECUTABLE,
      requiredProcesses: [],
      tcp: { host: "127.0.0.1", port },
    },
    launch: { kind: "macos-app", bundleId: "com.ziniao.fzzixun" },
    repairPolicy: "launch-if-absent",
    failureThreshold: 2,
    cooldownSec: 120,
    startupGraceSec: 30,
    ...overrides,
  };
}

function clashVerge(port: number, overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    id: "clash-verge",
    label: "Clash Verge",
    enabled: true,
    probes: {
      primaryProcess: CLASH_VERGE_EXECUTABLE,
      requiredProcesses: [VERGE_MIHOMO_EXECUTABLE],
      tcp: { host: "127.0.0.1", port },
    },
    launch: { kind: "macos-app", bundleId: "io.github.clash-verge-rev.clash-verge-rev" },
    repairPolicy: "relaunch-on-unhealthy",
    failureThreshold: 2,
    cooldownSec: 120,
    startupGraceSec: 30,
    ...overrides,
  };
}

function writeConfig(path: string, services: ServiceConfig[]): void {
  writeFileSync(path, JSON.stringify({ version: 1, services }, null, 2));
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createFakeMacTools(root: string): { actionsPath: string; binPath: string } {
  const binPath = resolve(root, "bin");
  const actionsPath = resolve(root, "actions.log");
  mkdirSync(binPath);
  writeExecutable(
    resolve(binPath, "ps"),
    `#!/usr/bin/env bash
if [[ -n "\${MANAGED_TEST_ACTION_LOG:-}" ]] && [[ -f "$MANAGED_TEST_ACTION_LOG" ]] && /usr/bin/grep -q '^QUIT' "$MANAGED_TEST_ACTION_LOG"; then
  printf '%s\\n' "\${MANAGED_TEST_PROCESSES_AFTER_QUIT:-}"
  exit 0
fi
printf '%s\\n' "\${MANAGED_TEST_PROCESSES:-}"
`,
  );
  writeExecutable(
    resolve(binPath, "osascript"),
    "#!/usr/bin/env bash\nprintf 'QUIT %s\\n' \"$*\" >> \"$MANAGED_TEST_ACTION_LOG\"\n",
  );
  writeExecutable(
    resolve(binPath, "open"),
    "#!/usr/bin/env bash\nprintf 'OPEN %s\\n' \"$*\" >> \"$MANAGED_TEST_ACTION_LOG\"\n",
  );
  return { actionsPath, binPath };
}

function runManagedServices(input: {
  actionsPath: string;
  binPath: string;
  configPath: string;
  processes?: string;
  processesAfterQuit?: string;
  statePath: string;
}): { code: number | null; stderr: string; stdout: string } {
  const result = spawnSync(TSX_PATH, [HELPER_PATH, "check"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      LOCALWATCH_MANAGED_SERVICES_CONFIG: input.configPath,
      LOCALWATCH_MANAGED_SERVICES_STATE: input.statePath,
      MANAGED_TEST_ACTION_LOG: input.actionsPath,
      MANAGED_TEST_PROCESSES: input.processes ?? "",
      MANAGED_TEST_PROCESSES_AFTER_QUIT: input.processesAfterQuit ?? "",
      PATH: `${input.binPath}:${process.env.PATH ?? ""}`,
    },
  });
  return {
    code: result.status,
    stderr: String(result.stderr ?? ""),
    stdout: String(result.stdout ?? ""),
  };
}

function expectOk(run: { code: number | null; stderr: string; stdout: string }): ManagedResult {
  expect(run.code).toBe(0);
  expect(run.stderr).toBe("");
  return JSON.parse(run.stdout) as ManagedResult;
}

function serviceResult(result: ManagedResult, id: string): ManagedResult["services"][number] {
  const service = result.services.find((candidate) => candidate.id === id);
  if (!service) throw new Error(`missing service result for ${id}`);
  return service;
}

describe("localwatch managed macOS services", () => {
  test("ships the approved Clash Verge and ZiNiao initial registry and hot-reloads a changed file", async () => {
    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8")) as { services: ServiceConfig[] };
    expect(template.services).toEqual([
      clashVerge(7897),
      ziniao(9481),
    ]);

    const root = mkdtempSync(resolve(tmpdir(), "sm-managed-services-hot-reload-"));
    try {
      const tools = createFakeMacTools(root);
      const configPath = resolve(root, "services.json");
      const statePath = resolve(root, "state", "managed-services.json");
      const port = await unusedPort();
      writeConfig(configPath, [ziniao(port, { enabled: false })]);

      const first = expectOk(runManagedServices({ ...tools, configPath, statePath }));
      expect(first.services.map((service) => service.id)).toEqual(["ziniao"]);
      expect(serviceResult(first, "ziniao").status).toBe("disabled");

      writeConfig(configPath, [ziniao(port, { enabled: false }), clashVerge(port, { enabled: false })]);
      const second = expectOk(runManagedServices({ ...tools, configPath, statePath }));
      expect(second.services.map((service) => service.id)).toEqual(["ziniao", "clash-verge"]);
      expect(second.services.every((service) => service.status === "disabled")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("opens an explicitly missing app immediately but does not call that recovery before a later healthy probe", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "sm-managed-services-missing-"));
    let tcp: Awaited<ReturnType<typeof startTcpServer>> | undefined;
    try {
      const tools = createFakeMacTools(root);
      const configPath = resolve(root, "services.json");
      const statePath = resolve(root, "state", "managed-services.json");
      const port = await unusedPort();
      writeConfig(configPath, [ziniao(port)]);

      const launched = expectOk(runManagedServices({ ...tools, configPath, statePath }));
      const launchingService = serviceResult(launched, "ziniao");
      expect(launchingService.status).toBe("starting");
      expect(launchingService.recovered).toBe(false);
      expect(launchingService.action).toMatchObject({ kind: "launch", openAttempted: true });
      expect(readFileSync(tools.actionsPath, "utf8")).toContain("OPEN -g -b com.ziniao.fzzixun");

      const beforeRecovery = expectOk(runManagedServices({ ...tools, configPath, statePath }));
      expect(serviceResult(beforeRecovery, "ziniao").recovered).toBe(false);
      expect(readFileSync(tools.actionsPath, "utf8").match(/^OPEN /gm)?.length).toBe(1);

      tcp = await startTcpServer();
      writeConfig(configPath, [ziniao(tcp.port)]);
      const recovered = expectOk(runManagedServices({
        ...tools,
        configPath,
        statePath,
        processes: ZINIAO_EXECUTABLE,
      }));
      expect(serviceResult(recovered, "ziniao")).toMatchObject({ status: "healthy", recovered: true });
      expect(recovered.notifications).toContainEqual(expect.objectContaining({ kind: "recovered", label: "ZiNiao" }));
    } finally {
      await tcp?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("treats a fresh all-healthy service as baseline instead of recovery", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "sm-managed-services-fresh-healthy-"));
    let tcp: Awaited<ReturnType<typeof startTcpServer>> | undefined;
    try {
      const tools = createFakeMacTools(root);
      const configPath = resolve(root, "services.json");
      const statePath = resolve(root, "state", "managed-services.json");
      tcp = await startTcpServer();
      writeConfig(configPath, [ziniao(tcp.port)]);
      expect(existsSync(statePath)).toBe(false);

      const result = expectOk(runManagedServices({
        ...tools,
        configPath,
        statePath,
        processes: ZINIAO_EXECUTABLE,
      }));

      expect(serviceResult(result, "ziniao")).toMatchObject({ status: "healthy", recovered: false });
      expect(result.notifications).not.toContainEqual(expect.objectContaining({ kind: "recovered" }));
    } finally {
      await tcp?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("treats executable paths mentioned only in a command argument as absent and launches", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "sm-managed-services-prompt-path-"));
    try {
      const tools = createFakeMacTools(root);
      const configPath = resolve(root, "services.json");
      const statePath = resolve(root, "state", "managed-services.json");
      writeConfig(configPath, [clashVerge(await unusedPort()), ziniao(await unusedPort())]);
      const promptOnly = `codex exec --prompt "inspect ${CLASH_VERGE_EXECUTABLE} ${VERGE_MIHOMO_EXECUTABLE} ${ZINIAO_EXECUTABLE}"`;

      const result = expectOk(runManagedServices({ ...tools, configPath, statePath, processes: promptOnly }));
      expect(serviceResult(result, "clash-verge").action).toMatchObject({ kind: "launch", openAttempted: true });
      expect(serviceResult(result, "ziniao").action).toMatchObject({ kind: "launch", openAttempted: true });
      const actions = readFileSync(tools.actionsPath, "utf8");
      expect(actions).toContain("OPEN -g -b io.github.clash-verge-rev.clash-verge-rev");
      expect(actions).toContain("OPEN -g -b com.ziniao.fzzixun");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gracefully relaunches Clash Verge after two TCP failures and honors its cooldown", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "sm-managed-services-clash-"));
    try {
      const tools = createFakeMacTools(root);
      const configPath = resolve(root, "services.json");
      const statePath = resolve(root, "state", "managed-services.json");
      writeConfig(configPath, [clashVerge(await unusedPort())]);
      const processes = `${CLASH_VERGE_EXECUTABLE}\n${VERGE_MIHOMO_EXECUTABLE}`;

      const first = expectOk(runManagedServices({ ...tools, configPath, statePath, processes }));
      expect(serviceResult(first, "clash-verge")).toMatchObject({ failureCount: 1, action: null });

      const second = expectOk(runManagedServices({ ...tools, configPath, statePath, processes }));
      expect(serviceResult(second, "clash-verge").action).toMatchObject({
        kind: "relaunch",
        gracefulQuit: true,
        openAttempted: true,
      });
      expect(second.notifications).toContainEqual(expect.objectContaining({ kind: "failure-threshold", label: "Clash Verge" }));
      expect(second.notifications).toContainEqual(expect.objectContaining({ kind: "launch-attempt", label: "Clash Verge" }));
      const actions = readFileSync(tools.actionsPath, "utf8");
      expect(actions).toContain("QUIT -e tell application id");
      expect(actions).toContain("OPEN -g -b io.github.clash-verge-rev.clash-verge-rev");

      const coolingDown = expectOk(runManagedServices({ ...tools, configPath, statePath, processes }));
      expect(serviceResult(coolingDown, "clash-verge").action).toBeNull();
      expect(readFileSync(tools.actionsPath, "utf8").match(/^OPEN /gm)?.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("waits for the Clash child failure threshold while its exact primary executable is alive", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "sm-managed-services-clash-child-"));
    try {
      const tools = createFakeMacTools(root);
      const configPath = resolve(root, "services.json");
      const statePath = resolve(root, "state", "managed-services.json");
      writeConfig(configPath, [clashVerge(await unusedPort())]);

      const first = expectOk(runManagedServices({ ...tools, configPath, statePath, processes: CLASH_VERGE_EXECUTABLE }));
      expect(serviceResult(first, "clash-verge")).toMatchObject({ failureCount: 1, action: null });
      expect(existsSync(tools.actionsPath) ? readFileSync(tools.actionsPath, "utf8") : "").toBe("");

      const second = expectOk(runManagedServices({ ...tools, configPath, statePath, processes: CLASH_VERGE_EXECUTABLE }));
      expect(serviceResult(second, "clash-verge").action).toMatchObject({
        kind: "relaunch",
        gracefulQuit: true,
        quitConfirmed: true,
        openAttempted: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not open Clash after graceful quit while its exact primary executable remains", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "sm-managed-services-clash-quit-"));
    try {
      const tools = createFakeMacTools(root);
      const configPath = resolve(root, "services.json");
      const statePath = resolve(root, "state", "managed-services.json");
      writeConfig(configPath, [clashVerge(await unusedPort(), { failureThreshold: 1 })]);

      const result = expectOk(runManagedServices({
        ...tools,
        configPath,
        statePath,
        processes: CLASH_VERGE_EXECUTABLE,
        processesAfterQuit: CLASH_VERGE_EXECUTABLE,
      }));
      expect(serviceResult(result, "clash-verge").action).toMatchObject({
        kind: "relaunch",
        gracefulQuit: true,
        quitConfirmed: false,
        openAttempted: false,
      });
      const actions = readFileSync(tools.actionsPath, "utf8");
      expect(actions).toContain("QUIT -e tell application id");
      expect(actions).not.toContain("OPEN -g -b io.github.clash-verge-rev.clash-verge-rev");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  test("only alerts when ZiNiao remains alive but its bridge port is down", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "sm-managed-services-ziniao-"));
    try {
      const tools = createFakeMacTools(root);
      const configPath = resolve(root, "services.json");
      const statePath = resolve(root, "state", "managed-services.json");
      writeConfig(configPath, [ziniao(await unusedPort())]);
      const processes = ZINIAO_EXECUTABLE;

      expectOk(runManagedServices({ ...tools, configPath, statePath, processes }));
      const second = expectOk(runManagedServices({ ...tools, configPath, statePath, processes }));
      expect(serviceResult(second, "ziniao")).toMatchObject({
        status: "unhealthy",
        failureCount: 2,
        thresholdReached: true,
        action: null,
      });
      expect(second.notifications).toContainEqual(expect.objectContaining({ kind: "failure-threshold", label: "ZiNiao" }));
      expect(existsSync(tools.actionsPath) ? readFileSync(tools.actionsPath, "utf8") : "").toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed for invalid JSON and schema without executing an action", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "sm-managed-services-invalid-"));
    try {
      const tools = createFakeMacTools(root);
      const configPath = resolve(root, "services.json");
      const statePath = resolve(root, "state", "managed-services.json");
      writeFileSync(configPath, "{ invalid json");

      const invalidJson = runManagedServices({ ...tools, configPath, statePath });
      expect(invalidJson.code).toBe(2);
      expect(JSON.parse(invalidJson.stdout) as ManagedResult).toMatchObject({ ok: false });

      writeFileSync(configPath, JSON.stringify({
        version: 1,
        services: [{ ...ziniao(await unusedPort()), launch: { kind: "shell", command: "rm -rf /" } }],
      }));
      const invalidSchema = runManagedServices({ ...tools, configPath, statePath });
      expect(invalidSchema.code).toBe(2);
      expect(JSON.parse(invalidSchema.stdout) as ManagedResult).toMatchObject({ ok: false });
      expect(existsSync(tools.actionsPath) ? readFileSync(tools.actionsPath, "utf8") : "").toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("deduplicates an unchanged config error until a valid registry clears it", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "sm-managed-services-config-error-"));
    try {
      const tools = createFakeMacTools(root);
      const configPath = resolve(root, "services.json");
      const statePath = resolve(root, "state", "managed-services.json");
      writeFileSync(configPath, "{ invalid json");

      const firstRun = runManagedServices({ ...tools, configPath, statePath });
      expect(firstRun.code).toBe(2);
      expect((JSON.parse(firstRun.stdout) as ManagedResult).notifications.filter((notification) => notification.kind === "config-error")).toHaveLength(1);

      const secondRun = runManagedServices({ ...tools, configPath, statePath });
      expect(secondRun.code).toBe(2);
      expect((JSON.parse(secondRun.stdout) as ManagedResult).notifications.filter((notification) => notification.kind === "config-error")).toHaveLength(0);
      expect(existsSync(tools.actionsPath) ? readFileSync(tools.actionsPath, "utf8") : "").toBe("");

      writeFileSync(configPath, JSON.stringify({
        version: 1,
        services: [{ ...ziniao(await unusedPort()), launch: { kind: "shell", command: "rm -rf /" } }],
      }));
      const changedError = runManagedServices({ ...tools, configPath, statePath });
      expect(changedError.code).toBe(2);
      expect((JSON.parse(changedError.stdout) as ManagedResult).notifications.filter((notification) => notification.kind === "config-error")).toHaveLength(1);

      writeConfig(configPath, [ziniao(await unusedPort(), { enabled: false })]);
      expectOk(runManagedServices({ ...tools, configPath, statePath }));
      const recoveredState = JSON.parse(readFileSync(statePath, "utf8")) as { lastConfigError?: string; lastConfigErrorAt?: string };
      expect(recoveredState).not.toHaveProperty("lastConfigError");
      expect(recoveredState).not.toHaveProperty("lastConfigErrorAt");

      writeFileSync(configPath, "{ invalid json");
      const errorAfterRecovery = runManagedServices({ ...tools, configPath, statePath });
      expect(errorAfterRecovery.code).toBe(2);
      expect((JSON.parse(errorAfterRecovery.stdout) as ManagedResult).notifications.filter((notification) => notification.kind === "config-error")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("persists state atomically across checks with failure and recovery fields", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "sm-managed-services-state-"));
    let tcp: Awaited<ReturnType<typeof startTcpServer>> | undefined;
    try {
      const tools = createFakeMacTools(root);
      const configPath = resolve(root, "services.json");
      const statePath = resolve(root, "nested", "managed-services.json");
      tcp = await startTcpServer();
      writeConfig(configPath, [ziniao(tcp.port)]);
      const processes = ZINIAO_EXECUTABLE;

      expectOk(runManagedServices({ ...tools, configPath, statePath, processes }));
      const healthyState = JSON.parse(readFileSync(statePath, "utf8")) as {
        services: Record<string, { consecutiveFailures: number; lastStatus: string; lastRecoveredAt?: string }>;
      };
      expect(healthyState.services.ziniao).toMatchObject({ consecutiveFailures: 0, lastStatus: "healthy" });
      expect(existsSync(`${statePath}.tmp`)).toBe(false);

      await tcp.close();
      tcp = undefined;
      expectOk(runManagedServices({ ...tools, configPath, statePath, processes }));
      const failedState = JSON.parse(readFileSync(statePath, "utf8")) as {
        services: Record<string, { consecutiveFailures: number; lastStatus: string; cooldownUntil: number; startupGraceUntil: number }>;
      };
      expect(failedState.services.ziniao).toMatchObject({ consecutiveFailures: 1, lastStatus: "unhealthy" });
      expect(typeof failedState.services.ziniao.cooldownUntil).toBe("number");
      expect(typeof failedState.services.ziniao.startupGraceUntil).toBe("number");
      expect(existsSync(`${statePath}.tmp`)).toBe(false);
    } finally {
      await tcp?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
