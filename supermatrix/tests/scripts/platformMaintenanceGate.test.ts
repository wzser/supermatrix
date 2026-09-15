import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/platform-maintenance-gate.sh");
const DAILY_TASK_ID = "c79b09c8-138a-4fd8-9377-ed93986b5e9f";
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("scripts/platform-maintenance-gate.sh", () => {
  test("allows the exact scheduler task in the daily maintenance window", async () => {
    const env = makeEnvironment();

    const run = await runGate(env, [
      "reload-supermatrix",
      "--source", "scheduled-daily",
      "--task-id", DAILY_TASK_ID,
      "--reason", "03:50 daily maintenance",
    ]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[maintenance-allowed] operation=reload-supermatrix");
    expect(readFileSync(env.executorCallsPath, "utf8")).toContain(
      "approval=platform-maintenance-gate-v1 source=scheduled-daily caller=child_codexroot_test",
    );
  }, 15_000);

  test("bypasses inherited proxies for loopback identity verification", async () => {
    const env = makeEnvironment();

    const run = await runGate(env, [
      "reload-supermatrix",
      "--source", "scheduled-daily",
      "--task-id", DAILY_TASK_ID,
      "--reason", "03:50 daily maintenance",
    ], {
      FAKE_REQUIRE_DIRECT_LOOPBACK: "1",
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[maintenance-allowed] operation=reload-supermatrix");
  }, 15_000);

  test("denies a non-codexroot caller before the executor", async () => {
    const env = makeEnvironment({ ownerSessionName: "another-session" });

    const run = await runGate(env, [
      "reload-supermatrix",
      "--source", "scheduled-daily",
      "--task-id", DAILY_TASK_ID,
      "--reason", "03:50 daily maintenance",
    ]);

    expect(run.code).toBe(3);
    expect(run.stderr).toContain("only codexroot may perform platform maintenance");
    expect(() => readFileSync(env.executorCallsPath, "utf8")).toThrow();
  });

  test("denies the daily source outside its narrow maintenance window", async () => {
    const env = makeEnvironment({ nowHhmm: "0411" });

    const run = await runGate(env, [
      "reload-supermatrix",
      "--source", "scheduled-daily",
      "--task-id", DAILY_TASK_ID,
      "--reason", "late daily maintenance",
    ]);

    expect(run.code).toBe(3);
    expect(run.stderr).toContain("outside the 03:45-04:10 maintenance window");
    expect(() => readFileSync(env.executorCallsPath, "utf8")).toThrow();
  });

  test("denies a lookalike scheduler task id", async () => {
    const env = makeEnvironment();

    const run = await runGate(env, [
      "reload-supermatrix",
      "--source", "scheduled-daily",
      "--task-id", "c79b09c8-lookalike",
      "--reason", "daily maintenance",
    ]);

    expect(run.code).toBe(3);
    expect(run.stderr).toContain("task id is not the approved daily-reload task");
  });

  test("denies a scheduled source that was not actually spawned by the exact scheduler task", async () => {
    const env = makeEnvironment({ schedulerOrigin: false });

    const run = await runGate(env, [
      "reload-supermatrix",
      "--source", "scheduled-daily",
      "--task-id", DAILY_TASK_ID,
      "--reason", "forged scheduled maintenance",
    ]);

    expect(run.code).toBe(3);
    expect(run.stderr).toContain("caller is not the child spawned by the approved scheduler task");
    expect(() => readFileSync(env.executorCallsPath, "utf8")).toThrow();
  });

  test("scheduled maintenance can never request force", async () => {
    const env = makeEnvironment();

    const run = await runGate(env, [
      "reload-supermatrix",
      "--source", "scheduled-daily",
      "--task-id", DAILY_TASK_ID,
      "--reason", "daily maintenance",
      "--force",
    ]);

    expect(run.code).toBe(3);
    expect(run.stderr).toContain("scheduled-daily never permits force");
  });

  test("allows an explicitly reasoned codexroot emergency force without a scheduler identity", async () => {
    const env = makeEnvironment({ nowHhmm: "1200" });

    const run = await runGate(env, [
      "reload-supermatrix",
      "--source", "codexroot-maintenance",
      "--reason", "platform unavailable; emergency recovery",
      "--force",
      "--emergency",
    ]);

    expect(run.code).toBe(0);
    expect(readFileSync(env.executorCallsPath, "utf8")).toContain(
      "source=codexroot-maintenance caller=child_codexroot_test force=true",
    );
  });

  test("denies codexroot force without an explicit emergency declaration", async () => {
    const env = makeEnvironment();

    const run = await runGate(env, [
      "reload-supermatrix",
      "--source", "codexroot-maintenance",
      "--reason", "ordinary maintenance",
      "--force",
    ]);

    expect(run.code).toBe(3);
    expect(run.stderr).toContain("force requires --emergency");
  });

  test("routine localwatch stop is always denied", async () => {
    const env = makeEnvironment();

    const run = await runGate(env, ["stop-localwatch", "--reason", "routine cleanup"]);

    expect(run.code).toBe(3);
    expect(run.stderr).toContain("routine stop-localwatch is never permitted");
  });

  test("restarts localwatch only through an exact one-shot permit and verifies recovery", async () => {
    const env = makeEnvironment();
    const fakeLocalwatch = startFakeLocalwatch(env);
    writeLocalwatchIdentity(env, fakeLocalwatch.pid!, true);
    let successorPid = 0;
    let simulateSuccessor = true;
    fakeLocalwatch.once("exit", () => {
      if (!simulateSuccessor) return;
      const successor = startFakeLocalwatch(env);
      successorPid = successor.pid ?? 0;
      writeLocalwatchIdentity(env, successorPid, true);
    });

    try {
      const run = await runGate(env, [
        "restart-localwatch",
        "--reason", "localwatch supervisor code changed",
      ]);

      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toContain("[localwatch-restarted]");
      expect(readFileSync(env.auditPath, "utf8")).toContain('"operation":"restart-localwatch"');
      expect(() => readFileSync(env.localwatchPermitPath, "utf8")).toThrow();
    } finally {
      simulateSuccessor = false;
      try { process.kill(fakeLocalwatch.pid, "SIGKILL"); } catch { /* exited */ }
      if (successorPid > 0) {
        try { process.kill(successorPid, "SIGKILL"); } catch { /* exited */ }
      }
    }
  });

  test("refuses to signal a legacy localwatch that has not activated the permit protocol", async () => {
    const env = makeEnvironment({ localwatchGateCapable: false });
    const fakeLocalwatch = startFakeLocalwatch(env);
    writeLocalwatchIdentity(env, fakeLocalwatch.pid!, false);
    try {
      const run = await runGate(env, [
        "restart-localwatch",
        "--reason", "attempt legacy activation",
      ]);
      expect(run.code).toBe(3);
      expect(run.stderr).toContain("has not activated the maintenance permit protocol");
      expect(process.kill(fakeLocalwatch.pid, 0)).toBe(true);
    } finally {
      try { process.kill(fakeLocalwatch.pid, "SIGKILL"); } catch { /* exited */ }
    }
  });

  test("treats an already-active localwatch gate as an idle-independent no-op", async () => {
    const env = makeEnvironment({ busySessions: 1 });
    const fakeLocalwatch = startFakeLocalwatch(env);
    writeLocalwatchIdentity(env, fakeLocalwatch.pid, true);

    try {
      const run = await runGate(env, [
        "activate-localwatch-gate",
        "--source", "scheduled-daily",
        "--task-id", DAILY_TASK_ID,
        "--reason", "confirm existing maintenance gate",
      ]);

      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toContain(`[localwatch-gate-active] pid=${fakeLocalwatch.pid}`);
      expect(process.kill(fakeLocalwatch.pid, 0)).toBe(true);
    } finally {
      try { process.kill(fakeLocalwatch.pid, "SIGKILL"); } catch { /* exited */ }
    }
  });

  test("refuses stale-lock migration when a same-name legacy localwatch is alive", async () => {
    const env = makeEnvironment({ localwatchGateCapable: false });
    const legacyLocalwatch = startFakeLocalwatch(env);
    writeFileSync(env.localwatchPidPath, "999999\n");

    try {
      const run = await runGate(env, [
        "activate-localwatch-gate",
        "--source", "scheduled-daily",
        "--task-id", DAILY_TASK_ID,
        "--reason", "one-time maintenance gate rollout",
      ]);
      expect(run.code).toBe(3);
      expect(run.stderr).toContain("identity cannot be proven");
      expect(run.stderr).toContain("manual restart required");
      expect(readFileSync(env.auditPath, "utf8")).toContain('"verdict":"denied"');
      expect(process.kill(legacyLocalwatch.pid!, 0)).toBe(true);
    } finally {
      try { process.kill(legacyLocalwatch.pid!, "SIGKILL"); } catch { /* exited */ }
    }
  });

  test("refuses gate activation when the shared process scan fails", async () => {
    const env = makeEnvironment({
      localwatchGateCapable: false,
      processScanFailure: true,
    });
    writeFileSync(env.localwatchPidPath, "999999\n");

    const run = await runGate(env, [
      "activate-localwatch-gate",
      "--source", "scheduled-daily",
      "--task-id", DAILY_TASK_ID,
      "--reason", "failed process scan regression",
    ]);

    expect(run.code).toBe(3);
    expect(run.stderr).toContain("same-name localwatch process scan failed");
    expect(readFileSync(env.localwatchPidPath, "utf8")).toBe("999999\n");
    expect(readFileSync(env.auditPath, "utf8")).toContain('"verdict":"denied"');
    expect(() => readFileSync(env.executorCallsPath, "utf8")).toThrow();
  });

  test("refuses a live reused PID whose process is not the exact localwatch", async () => {
    const env = makeEnvironment();
    const unrelated = spawn("sleep", ["30"], { cwd: env.root, stdio: "ignore" });
    if (!unrelated.pid) throw new Error("unrelated process did not start");
    writeLocalwatchIdentity(env, unrelated.pid, true);

    try {
      const run = await runGate(env, [
        "restart-localwatch",
        "--reason", "stale lock pid reuse regression",
      ]);
      expect(run.code).toBe(3);
      expect(run.stderr).toContain("does not match the exact localwatch identity");
      expect(process.kill(unrelated.pid, 0)).toBe(true);
    } finally {
      try { process.kill(unrelated.pid, "SIGKILL"); } catch { /* exited */ }
    }
  });

  test("refuses an exact localwatch command when its boot identity is stale", async () => {
    const env = makeEnvironment();
    const fakeLocalwatch = startFakeLocalwatch(env);
    writeLocalwatchIdentity(env, fakeLocalwatch.pid!, true);
    writeFileSync(join(env.localwatchLockDir, "process-start"), "stale boot identity\n");

    try {
      const run = await runGate(env, [
        "restart-localwatch",
        "--reason", "stale boot identity regression",
      ]);
      expect(run.code).toBe(3);
      expect(run.stderr).toContain("does not match the exact localwatch identity");
      expect(process.kill(fakeLocalwatch.pid!, 0)).toBe(true);
    } finally {
      try { process.kill(fakeLocalwatch.pid!, "SIGKILL"); } catch { /* exited */ }
    }
  });

  test("refuses an active lock whose recorded cwd does not match the process", async () => {
    const env = makeEnvironment();
    const fakeLocalwatch = startFakeLocalwatch(env);
    writeLocalwatchIdentity(env, fakeLocalwatch.pid!, true);
    writeFileSync(join(env.localwatchLockDir, "cwd"), `${join(env.root, "wrong-cwd")}\n`);

    try {
      const run = await runGate(env, [
        "restart-localwatch",
        "--reason", "cwd provenance regression",
      ]);
      expect(run.code).toBe(3);
      expect(run.stderr).toContain("stored cwd does not match");
      expect(process.kill(fakeLocalwatch.pid!, 0)).toBe(true);
    } finally {
      try { process.kill(fakeLocalwatch.pid!, "SIGKILL"); } catch { /* exited */ }
    }
  });

  test("revalidates localwatch identity after permit publication and before signalling", async () => {
    const env = makeEnvironment();
    const fakeLocalwatch = startFakeLocalwatch(env);
    writeLocalwatchIdentity(env, fakeLocalwatch.pid, true);
    let wasSignalled = false;
    let successorPid = 0;
    let simulateSuccessor = true;
    fakeLocalwatch.once("exit", () => {
      wasSignalled = true;
      if (!simulateSuccessor) return;
      const successor = startFakeLocalwatch(env);
      successorPid = successor.pid;
      writeLocalwatchIdentity(env, successorPid, true);
    });

    try {
      const run = await runGate(env, [
        "restart-localwatch",
        "--reason", "check-to-signal identity swap regression",
      ], {
        SM_TEST_MUTATE_LOCALWATCH_IDENTITY_AT_AUDIT: "1",
      });
      expect(run.code).toBe(3);
      expect(run.stderr).toContain("identity changed before signal");
      expect(wasSignalled).toBe(false);
      expect(process.kill(fakeLocalwatch.pid, 0)).toBe(true);
    } finally {
      simulateSuccessor = false;
      try { process.kill(fakeLocalwatch.pid, "SIGKILL"); } catch { /* exited */ }
      if (successorPid > 0) {
        try { process.kill(successorPid, "SIGKILL"); } catch { /* exited */ }
      }
    }
  });
});

type Environment = {
  auditPath: string;
  binDir: string;
  executorCallsPath: string;
  localwatchLockDir: string;
  localwatchPermitPath: string;
  localwatchPidPath: string;
  localwatchScriptPath: string;
  root: string;
  scriptPath: string;
};

function makeEnvironment(options: {
  busySessions?: number;
  ownerSessionName?: string;
  nowHhmm?: string;
  localwatchGateCapable?: boolean;
  processScanFailure?: boolean;
  schedulerOrigin?: boolean;
} = {}): Environment {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-maintenance-gate-")));
  tempDirs.push(root);
  const binDir = join(root, "bin");
  const scriptsDir = join(root, "scripts");
  const dataDir = join(root, "data");
  const localwatchLockDir = join(root, "logs", ".localwatch.lock");
  mkdirSync(binDir);
  mkdirSync(scriptsDir);
  mkdirSync(join(scriptsDir, "lib"));
  mkdirSync(dataDir);
  mkdirSync(localwatchLockDir, { recursive: true });
  if (options.localwatchGateCapable !== false) {
    writeFileSync(join(localwatchLockDir, "maintenance-gate-version"), "platform-maintenance-gate-v1\n");
  }

  const scriptPath = join(scriptsDir, "platform-maintenance-gate.sh");
  writeFileSync(scriptPath, readFileSync(SCRIPT_PATH, "utf8"), { mode: 0o755 });
  const identityHelper = readFileSync(
    resolve(REPO_ROOT, "scripts/lib/localwatch-identity.sh"),
    "utf8",
  ) + (options.processScanFailure
    ? "\nlocalwatch_ps_snapshot() { return 1; }\n"
    : "");
  writeFileSync(join(scriptsDir, "lib/localwatch-identity.sh"), identityHelper);

  const localwatchScriptPath = join(scriptsDir, "localwatch.sh");
  const localwatchPermitPath = join(dataDir, ".localwatch-maintenance-permit.json");
  writeFileSync(
    localwatchScriptPath,
    `#!/bin/bash\ntrap 'rm -f ${JSON.stringify(localwatchPermitPath)}; exit 0' TERM\nwhile true; do sleep 1; done\n`,
    { mode: 0o755 },
  );

  const executorCallsPath = join(root, "executor-calls.log");
  writeFileSync(
    join(scriptsDir, "safe-reload.sh"),
    `#!/bin/zsh\nprintf 'approval=%s source=%s caller=%s force=%s\\n' "$SM_MAINTENANCE_GATE_APPROVAL" "$SM_RELOAD_SOURCE" "$SM_MAINTENANCE_CALLER_SESSION_ID" "$SM_MAINTENANCE_FORCE" >> "${executorCallsPath}"\n`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(binDir, "curl"),
    `#!/bin/zsh
if [[ "\${FAKE_REQUIRE_DIRECT_LOOPBACK:-0}" == "1" ]]; then
  direct_loopback=false
  args=("$@")
  for (( index=1; index < \${#args[@]}; index += 1 )); do
    if [[ "\${args[$index]}" == "--noproxy" && "\${args[$((index + 1))]:-}" == "*" ]]; then
      direct_loopback=true
      break
    fi
  done
  [[ "$direct_loopback" == "true" ]] || exit 7
fi
if [[ "$*" == *"/api/health"* && "$*" != *"caller-identity"* ]]; then
  printf '%s\\n' '{"status":"ok","busy":0}'
else
  printf '%s\\n' '{"ok":true,"attested":true,"ownerSessionName":"${options.ownerSessionName ?? "codexroot"}","sessionId":"child_codexroot_test"}'
fi
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(binDir, "date"),
    `#!/bin/zsh\nif [[ "$1" == "+%H%M" ]]; then print -r -- "${options.nowHhmm ?? "0350"}"; else /bin/date "$@"; fi\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(binDir, "node"),
    `#!/bin/bash\n${JSON.stringify(process.execPath)} "$@"\nrc=$?\nif [[ "\${SM_TEST_MUTATE_LOCALWATCH_IDENTITY_AT_AUDIT:-}" == "1" && "$*" == *"fs.appendFileSync"* && ! -f ${JSON.stringify(join(root, "identity-mutated"))} ]]; then\n  printf '%s\\n' stale-after-initial-check > ${JSON.stringify(join(localwatchLockDir, "process-start"))}\n  : > ${JSON.stringify(join(root, "identity-mutated"))}\nfi\nexit "$rc"\n`,
    { mode: 0o755 },
  );

  const auditPath = join(dataDir, "platform-maintenance-audit.jsonl");
  const dbPath = join(dataDir, "supermatrix.db");
  writeFileSync(
    join(root, ".env.local"),
    [
      `SM_DB_PATH=${dbPath}`,
      `SM_MAINTENANCE_AUDIT_LOG=${auditPath}`,
      "",
    ].join("\n"),
  );
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE cross_session_log (
      child_session_id TEXT,
      from_session_id TEXT NOT NULL,
      to_session_id TEXT NOT NULL,
      origin_run_id TEXT,
      status TEXT NOT NULL
    );
    INSERT INTO sessions (id, name, status) VALUES
      ('sess_scheduler', 'scheduler', 'idle'),
      ('sess_codexroot', 'codexroot', 'idle');
  `);
  if (options.schedulerOrigin !== false) {
    db.prepare(`
      INSERT INTO cross_session_log
        (child_session_id, from_session_id, to_session_id, origin_run_id, status)
      VALUES (?, 'sess_scheduler', 'sess_codexroot', ?, 'pending')
    `).run("child_codexroot_test", `scheduler:${DAILY_TASK_ID}:run_test`);
  }
  for (let index = 0; index < (options.busySessions ?? 0); index += 1) {
    db.prepare("INSERT INTO sessions (id, name, status) VALUES (?, ?, 'busy')")
      .run(`sess_busy_${index}`, `busy-session-${index}`);
  }
  db.close();

  return {
    auditPath,
    binDir,
    executorCallsPath,
    localwatchLockDir,
    localwatchPermitPath,
    localwatchPidPath: join(localwatchLockDir, "pid"),
    localwatchScriptPath,
    root,
    scriptPath,
  };
}

function startFakeLocalwatch(env: Environment) {
  const child = spawn("/bin/bash", [env.localwatchScriptPath], {
    cwd: env.root,
    stdio: "ignore",
  });
  if (!child.pid) throw new Error("fake localwatch did not start");
  return child as typeof child & { pid: number };
}

function writeLocalwatchIdentity(
  env: Environment,
  pid: number,
  capable: boolean,
): void {
  // Mirror how localwatch.sh records the identity (scripts/localwatch.sh:51,975) and how the gate
  // re-reads it (scripts/platform-maintenance-gate.sh:137): pin LC_ALL=C, because `ps -o lstart=`
  // is localized (this machine's zh_CN locale renders "\u4e09  9/ 9 ..." instead of "Wed Sep  9 ..."),
  // and collapse whitespace, because single-digit days are double-space padded.
  const processStart = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  })
    .trim()
    .replace(/\s+/gu, " ");
  writeFileSync(env.localwatchPidPath, `${pid}\n`);
  writeFileSync(join(env.localwatchLockDir, "repo-dir"), `${env.root}\n`);
  writeFileSync(join(env.localwatchLockDir, "script-path"), `${env.localwatchScriptPath}\n`);
  writeFileSync(join(env.localwatchLockDir, "cwd"), `${env.root}\n`);
  writeFileSync(join(env.localwatchLockDir, "process-start"), `${processStart}\n`);
  writeFileSync(
    join(env.localwatchLockDir, "boot-id"),
    "123e4567-e89b-42d3-a456-426614174000\n",
  );
  writeFileSync(
    join(env.localwatchLockDir, "provenance.json"),
    JSON.stringify({
      version: 1,
      capability: "platform-maintenance-gate-v1",
      repoDir: env.root,
      scriptPath: env.localwatchScriptPath,
      cwd: env.root,
      processStart,
      bootId: "123e4567-e89b-42d3-a456-426614174000",
    }) + "\n",
  );
  const capabilityPath = join(env.localwatchLockDir, "maintenance-gate-version");
  if (capable) writeFileSync(capabilityPath, "platform-maintenance-gate-v1\n");
  else rmSync(capabilityPath, { force: true });
}

async function runGate(
  env: Environment,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("zsh", [env.scriptPath, ...args], {
      env: {
        ...process.env,
        PATH: `${env.binDir}:${process.env.PATH ?? ""}`,
        SM_API_BASE: "http://127.0.0.1:3501",
        SM_CALLER_ATTESTATION: "smca_test",
        ...extraEnv,
      },
      timeout: 10_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (typeof failure.code !== "number") throw error;
    return { code: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}
