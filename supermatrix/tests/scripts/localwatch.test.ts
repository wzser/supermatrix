import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  classifyBackendConnectivityError,
  selectedProxyName,
  updateEnvAssignment,
} from "../../scripts/backend-api-connectivity.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/localwatch.sh");
const TERMINAL_LAUNCHER_PATH = resolve(REPO_ROOT, "scripts/launchd/terminal-launcher.sh");
const LOCALWATCH_IDENTITY_HELPER_PATH = resolve(REPO_ROOT, "scripts/lib/localwatch-identity.sh");
const LOCALWATCH_IDENTITY_FNS = readFileSync(LOCALWATCH_IDENTITY_HELPER_PATH, "utf8");

// localwatch.sh runs its main loop at module bottom, so it cannot be sourced
// wholesale. These helpers extract a single function / block from the live
// script text and execute it in a stub harness, so the assertions exercise the
// REAL branch logic (not a copy) without booting the supervisor.
function extractBlock(start: RegExp, end: RegExp): string {
  return extractScriptBlock(SCRIPT_PATH, start, end);
}

function extractScriptBlock(scriptPath: string, start: RegExp, end: RegExp): string {
  const script = readFileSync(scriptPath, "utf8");
  const from = script.search(start);
  if (from < 0) throw new Error(`block start not found: ${start}`);
  const rest = script.slice(from);
  const to = rest.search(end);
  if (to < 0) throw new Error(`block end not found: ${end}`);
  return rest.slice(0, to);
}

function runBash(snippet: string, env: Record<string, string> = {}): string {
  return execFileSync("bash", ["-c", snippet], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

type BackendProbeRun = {
  code: number | null;
  stderr: string;
  stdout: string;
};

function runBackendApiConnectivity(env: NodeJS.ProcessEnv): Promise<BackendProbeRun> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      resolve(REPO_ROOT, "node_modules/.bin/tsx"),
      [resolve(REPO_ROOT, "scripts/backend-api-connectivity.ts")],
      { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

type KimiHealthResponse = {
  body?: string;
  hang?: boolean;
  status?: number;
};

async function startKimiHealthServer(response: KimiHealthResponse): Promise<{
  close: () => Promise<void>;
  port: number;
  requests: string[];
}> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    if (response.hang) return;
    res.writeHead(response.status ?? 200, { "content-type": "application/json" });
    res.end(response.body ?? "");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    },
  };
}

async function startUnrelatedListener(body: string): Promise<{
  child: ReturnType<typeof spawn>;
  close: () => Promise<void>;
  port: number;
}> {
  const child = spawn(process.execPath, ["-e", `
    const http = require("node:http");
    const server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end(${JSON.stringify(body)});
    });
    server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));
    setInterval(() => {}, 1_000);
  `], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "ignore"] });
  const port = await new Promise<number>((resolvePort, rejectPort) => {
    let stdout = "";
    const timer = setTimeout(() => rejectPort(new Error("listener start timeout")), 5_000);
    child.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
      const line = stdout.split("\n", 1)[0]?.trim();
      if (!line || !/^\d+$/.test(line)) return;
      clearTimeout(timer);
      resolvePort(Number(line));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPort(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectPort(new Error(`listener exited early: ${code}`));
    });
  });
  return {
    child,
    port,
    close: async () => {
      if (child.exitCode !== null) return;
      await new Promise<void>((resolveClose) => {
        child.once("exit", () => resolveClose());
        try {
          if (!child.kill("SIGKILL")) resolveClose();
        } catch {
          resolveClose();
        }
      });
    },
  };
}

async function runConnectivityAgainstKimiHealth(
  response: KimiHealthResponse,
  timeoutMs = 5_000,
  closeBeforeRun = false,
): Promise<{ kimiWasLaunched: boolean; requests: string[]; result: BackendProbeRun }> {
  const tempDir = mkdtempSync(resolve(tmpdir(), "sm-kimi-health-probe-"));
  const fakeClaude = resolve(tempDir, "claude");
  const fakeCodex = resolve(tempDir, "codex");
  const fakeKimi = resolve(tempDir, "kimi");
  const kimiCalls = resolve(tempDir, "kimi-calls.log");
  const health = await startKimiHealthServer(response);
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "auth" && "\${2:-}" == "status" ]]; then
  printf '%s\\n' '{"loggedIn":true}'
  exit 0
fi
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"OK"}'
`,
  );
  writeFileSync(fakeCodex, "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(fakeKimi, "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$FAKE_KIMI_CALLS\"\nexit 99\n");
  chmodSync(fakeClaude, 0o755);
  chmodSync(fakeCodex, 0o755);
  chmodSync(fakeKimi, 0o755);
  let healthClosed = false;

  try {
    if (closeBeforeRun) {
      await health.close();
      healthClosed = true;
    }
    const result = await runBackendApiConnectivity({
      ...process.env,
      FAKE_KIMI_CALLS: kimiCalls,
      PATH: `${tempDir}:${process.env.PATH ?? ""}`,
      SM_API_PORT: String(health.port),
      SM_BACKEND_API_ENV_FILE: resolve(tempDir, "missing.env"),
      SM_BACKEND_API_PROBE_TIMEOUT_MS: String(timeoutMs),
      SM_CLAUDE_CLI_PATH: fakeClaude,
      SM_CODEX_CLI_PATH: fakeCodex,
    });
    return {
      kimiWasLaunched: existsSync(kimiCalls),
      requests: [...health.requests],
      result,
    };
  } finally {
    if (!healthClosed) await health.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// The exact Lark event-subscriber block from check_lark_connectivity (between markers).
const PROBE3 = extractBlock(/# 4\. Lark event subscriber\./, /# 5\. business-screen HTTP 200/);
// The real has_forced_lark_subscriber predicate (ps | awk | grep -q).
const HAS_FORCED_FN = extractBlock(
  /has_forced_lark_subscriber\(\) \{/,
  /\nreport_unsafe_lark_subscribers\(\)/,
);
const RESTART_PROVENANCE_FN = extractBlock(
  /record_supermatrix_restart_provenance\(\) \{/,
  /\nsend_alert\(\)/,
);
const BACKEND_API_CONNECTIVITY_FN = extractBlock(
  /check_backend_api_connectivity\(\) \{/,
  /\nhas_forced_lark_subscriber\(\)/,
);
const SEND_BACKEND_API_ALERT_FN = extractBlock(
  /send_backend_api_alert\(\) \{/,
  /\n# Triggered after a force-restart event/,
);
const SEND_QUOTA_STATUS_FN = extractBlock(
  /send_quota_status\(\) \{/,
  /\n# Report orphan vitest workers/,
);
const LOCALWATCH_MAINTENANCE_PERMIT_FNS = extractBlock(
  /localwatch_maintenance_permit_path\(\) \{/,
  /\ncleanup\(\)/,
);
const LOCALWATCH_LOCK_FNS = extractBlock(
  /localwatch_process_cwd_for_pid\(\) \{/,
  /\nacquire_localwatch_lock\nlock_status=/,
);
const TERMINAL_BOOTSTRAP_BLOCK = extractScriptBlock(
  TERMINAL_LAUNCHER_PATH,
  /# If localwatch is already running/,
  /\n# Monitor:/,
);
const LOCALWATCH_CLEANUP_FN = extractBlock(
  /cleanup\(\) \{/,
  /\ntrap cleanup INT TERM/,
);
const CHECK_LARK_CONNECTIVITY_FN = extractBlock(
  /check_lark_connectivity\(\) \{/,
  /\nsend_quota_status\(\)/,
);
const MEMORY_GUARD_FN = extractBlock(
  /# Memory Guard/,
  /\n# Process Management — heartbeat todo-watch workers/,
);
const HEARTBEAT_TODO_WATCH_FNS = extractBlock(
  /list_heartbeat_todo_watch_sessions\(\) \{/,
  /\nhas_forced_lark_subscriber\(\)/,
);
const CRASH_SIGNATURE_FN = extractBlock(
  /extract_crash_signature\(\) \{/,
  /\nhandle_supermatrix_exit\(\)/,
);
const ADOPT_EXISTING_SUPERMATRIX_FN = extractBlock(
  /is_repo_supermatrix_launcher_identity\(\) \{/,
  /\n# ============================================================================\n# Process Management — SuperMatrix/,
);
const START_SCHEDULER_V2_FN = extractBlock(
  /start_scheduler_v2\(\) \{/,
  /\nhandle_scheduler_v2_exit\(\)/,
);
const START_CARD_ASK_BROKER_FN = extractBlock(
  /start_card_ask_broker\(\) \{/,
  /\nhandle_card_ask_broker_exit\(\)/,
);
const START_BUSINESS_SCREEN_FN = extractBlock(
  /start_business_screen\(\) \{/,
  /\nhandle_business_screen_exit\(\)/,
);
const MANAGED_COMPONENT_IDENTITY_FNS = extractBlock(
  /managed_component_expected_cwd\(\) \{/,
  /\n# ============================================================================\n# Process Management — Scheduler v2/,
);
const START_BUSINESS_SCREEN_ARCHITECTURE_FN = extractBlock(
  /start_business_screen_architecture\(\) \{/,
  /\nhandle_business_screen_architecture_exit\(\)/,
);
const HANDLE_BUSINESS_SCREEN_ARCHITECTURE_FN = extractBlock(
  /handle_business_screen_architecture_exit\(\) \{/,
  /\n# ============================================================================\n# Auto-Repair/,
);
const CHECK_BUSINESS_SCREEN_ARCHITECTURE_HEALTH_FN = extractBlock(
  /check_bs_architecture_health\(\) \{/,
  /\nreport_supermatrix_backend_api_issue\(\)/,
);
const AUXILIARY_HEALTH_FNS = extractBlock(
  /check_sched_v2_health\(\) \{/,
  /\nreport_supermatrix_backend_api_issue\(\)/,
);

function runHeartbeatTodoWatchScenario({
  pauses = [],
  pendingSessions,
  releaseFails = false,
}: {
  pauses?: Array<[sessionName: string, status: string, expiresAt: string | null]>;
  pendingSessions: string[];
  releaseFails?: boolean;
}): string {
  const tempDir = mkdtempSync(resolve(tmpdir(), "sm-localwatch-heartbeat-watch-"));
  const heartbeatWorkspace = resolve(tempDir, "heartbeat");
  const heartbeatPackage = resolve(heartbeatWorkspace, "heartbeat_patrol");
  const heartbeatDb = resolve(tempDir, "heartbeat.sqlite");
  const watcherScript = resolve(heartbeatWorkspace, "scripts/heartbeat-todo-watch");
  const heartbeatPython = process.env.HEARTBEAT_PYTHON ?? "python3";
  mkdirSync(heartbeatPackage, { recursive: true });
  mkdirSync(resolve(heartbeatWorkspace, "scripts"), { recursive: true });
  writeFileSync(resolve(heartbeatPackage, "__init__.py"), "");
  writeFileSync(
    resolve(heartbeatPackage, "state.py"),
    `import os

class HeartbeatState:
    def __init__(self, path):
        raise AssertionError("schema init must not run while releasing a watcher claim")

    @classmethod
    def open_existing(cls, path):
        state = cls.__new__(cls)
        state.path = path
        return state

    def release_todo_watch(self, target_session):
        if os.environ.get("FAIL_RELEASE") == "1":
            raise RuntimeError("release failed")
        print(f"RELEASE:{target_session}")
`,
  );
  writeFileSync(watcherScript, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(watcherScript, 0o755);
  execFileSync(
    heartbeatPython,
    [
      "-c",
      `import json
import sqlite3
import sys

db_path, pending_json, pauses_json = sys.argv[1:]
with sqlite3.connect(db_path) as conn:
    conn.executescript("""
        CREATE TABLE action_claims (
          action_type TEXT,
          target_session TEXT,
          logical_key TEXT,
          status TEXT
        );
        CREATE TABLE session_todos (target_session TEXT, status TEXT);
        CREATE TABLE heartbeat_pauses (session_name TEXT, status TEXT, expires_at TEXT);
    """)
    conn.executemany(
        "INSERT INTO session_todos (target_session, status) VALUES (?, 'pending')",
        [(session_name,) for session_name in json.loads(pending_json)],
    )
    conn.executemany(
        "INSERT INTO heartbeat_pauses (session_name, status, expires_at) VALUES (?, ?, ?)",
        json.loads(pauses_json),
    )
`,
      heartbeatDb,
      JSON.stringify(pendingSessions),
      JSON.stringify(pauses),
    ],
    { stdio: "pipe" },
  );

  try {
    return runBash(
      `
        set -u
        HEARTBEAT_TODO_WATCH_ENABLED=1
        HEARTBEAT_WORKSPACE=${JSON.stringify(heartbeatWorkspace)}
        HEARTBEAT_TODO_WATCH_DB=${JSON.stringify(heartbeatDb)}
        HEARTBEAT_TODO_WATCH_SCRIPT=${JSON.stringify(watcherScript)}
        HEARTBEAT_TODO_WATCH_LOG_DIR=${JSON.stringify(resolve(tempDir, "logs"))}
        HEARTBEAT_PYTHON=${JSON.stringify(heartbeatPython)}
        ${HEARTBEAT_TODO_WATCH_FNS}
        heartbeat_todo_watch_pid_for_session() { return 1; }
        start_heartbeat_todo_watch() { printf 'START:%s\\n' "$1"; }
        log() { printf 'LOG:%s\\n' "$*"; }
        check_heartbeat_todo_watchers 2>/dev/null
      `,
      { FAIL_RELEASE: releaseFails ? "1" : "0" },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function crashSignature(contents: string): string {
  const tempDir = mkdtempSync(resolve(tmpdir(), "sm-localwatch-crash-signature-"));
  const crashLog = resolve(tempDir, "sm-crash.log");
  writeFileSync(crashLog, contents);
  try {
    return runBash(`
      set -o pipefail
      ${CRASH_SIGNATURE_FN}
      extract_crash_signature ${JSON.stringify(crashLog)}
    `);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("localwatch crash signature extraction", () => {
  test("extracts the structured Chinese boot self-check failure", () => {
    expect(crashSignature(
      "[supermatrix] boot 自检失败：\n" +
      "  ❌ codex-default-model: codex model aliases outside bundled catalog\n" +
      "\n" +
      "[supermatrix] 终止启动。修复以上失败项后重启。\n",
    )).toBe(
      "❌ codex-default-model: codex model aliases outside bundled catalog",
    );
  });

  test("falls back to the first non-empty stderr line and bounds it", () => {
    expect(crashSignature(`\n  ${"x".repeat(240)}\nsecond line\n`)).toBe(
      "x".repeat(200),
    );
  });

  test("returns unknown only when stderr has no content", () => {
    expect(crashSignature("\n \t\n")).toBe("unknown");
  });
});

describe("localwatch loopback transport", () => {
  test("every loopback curl request bypasses inherited proxies", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const loopbackCurlLines = script
      .split("\n")
      .filter((line) => /\bcurl\s+-/.test(line) && /http:\/\/(?:localhost|127\.0\.0\.1)/.test(line));

    expect(loopbackCurlLines.length).toBeGreaterThan(0);
    for (const line of loopbackCurlLines) {
      expect(line).toContain("--noproxy '*'");
    }
  });
});

describe("localwatch scheduler management", () => {
  test("keeps accepted localwatch command forms in one shared predicate", () => {
    expect(LOCALWATCH_IDENTITY_FNS).toContain("localwatch_command_matches_script()");
    expect(LOCALWATCH_IDENTITY_FNS).toContain(
      'localwatch_command_matches_script "$command_line" "$expected_script"',
    );

    for (const scriptPath of [
      SCRIPT_PATH,
      TERMINAL_LAUNCHER_PATH,
      resolve(REPO_ROOT, "scripts/platform-maintenance-gate.sh"),
    ]) {
      const source = readFileSync(scriptPath, "utf8");
      expect(source).toContain("localwatch_command_matches_script");
      expect(source).not.toContain('[[ "$command_line" == "bash $expected_script"');
      expect(source).not.toContain('[[ "$command_line" == "bash $LOCALWATCH_SCRIPT"');
    }
  });

  test("launchd Terminal command establishes the canonical cwd", () => {
    const source = readFileSync(TERMINAL_LAUNCHER_PATH, "utf8");
    expect(source).toContain('do script "cd -- $REPO_DIR && exec $LOCALWATCH_SCRIPT"');
    expect(source).not.toContain('do script "/Users/LOCAL_USER/SuperMatrix/scripts/localwatch.sh"');
  });

  test("fails closed when the same-name process scan fails", () => {
    const result = runBash(`
      set -u
      ${LOCALWATCH_IDENTITY_FNS}
      localwatch_ps_snapshot() { return 1; }
      if localwatch_same_script_pids /repo/scripts/localwatch.sh; then
        printf '%s\\n' unsafe
      else
        printf 'status=%s\\n' "$?"
      fi
    `);
    expect(result).toContain("status=2");
    expect(result).not.toContain("unsafe");
  });

  test("fresh and stale lock callers fail closed when process enumeration fails", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "sm-localwatch-scan-failure-"));
    const freshLock = resolve(tempDir, "fresh/.localwatch.lock");
    const staleLock = resolve(tempDir, "stale/.localwatch.lock");
    mkdirSync(staleLock, { recursive: true });
    writeFileSync(resolve(staleLock, "pid"), "999999\n");

    try {
      const result = runBash(`
        set -u
        REPO_DIR=${JSON.stringify(tempDir)}
        SCRIPT_DIR=${JSON.stringify(resolve(tempDir, "scripts"))}
        ${LOCALWATCH_IDENTITY_FNS}
        ${LOCALWATCH_LOCK_FNS}
        localwatch_ps_snapshot() { return 1; }

        LOCK_DIR=${JSON.stringify(freshLock)}
        mkdir -p "$(dirname "$LOCK_DIR")"
        acquire_localwatch_lock
        printf 'fresh=%s exists=%s\\n' "$?" "$([[ -e "$LOCK_DIR" ]] && printf yes || printf no)"

        LOCK_DIR=${JSON.stringify(staleLock)}
        acquire_localwatch_lock
        printf 'stale=%s holder=%s\\n' "$?" "$(cat "$LOCK_DIR/pid")"
      `);

      expect(result).toContain("fresh=2 exists=no");
      expect(result).toContain("stale=2 holder=999999");
      expect(readFileSync(resolve(staleLock, "pid"), "utf8")).toBe("999999\n");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("post-reacquisition scan failure removes the unproven replacement lock", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "sm-localwatch-second-scan-failure-"));
    const lockDir = resolve(tempDir, "logs/.localwatch.lock");
    const counterPath = resolve(tempDir, "scan-count");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(resolve(lockDir, "pid"), "999999\n");
    writeFileSync(counterPath, "0\n");

    try {
      const result = runBash(`
        set -u
        REPO_DIR=${JSON.stringify(tempDir)}
        SCRIPT_DIR=${JSON.stringify(resolve(tempDir, "scripts"))}
        LOCK_DIR=${JSON.stringify(lockDir)}
        ${LOCALWATCH_IDENTITY_FNS}
        ${LOCALWATCH_LOCK_FNS}
        localwatch_ps_snapshot() {
          scan_count=$(cat ${JSON.stringify(counterPath)})
          scan_count=$(( scan_count + 1 ))
          printf '%s\\n' "$scan_count" > ${JSON.stringify(counterPath)}
          (( scan_count == 1 ))
        }
        acquire_localwatch_lock
        printf 'status=%s exists=%s scans=%s\\n' "$?" \
          "$([[ -e "$LOCK_DIR" ]] && printf yes || printf no)" \
          "$(cat ${JSON.stringify(counterPath)})"
      `);

      expect(result).toContain("status=2 exists=no scans=2");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("terminal bootstrap refuses a failed process scan before opening Terminal", () => {
    const run = spawnSync("bash", ["-c", `
      set -u
      LOCALWATCH_SCRIPT=/repo/scripts/localwatch.sh
      ${LOCALWATCH_IDENTITY_FNS}
      localwatch_running() { return 1; }
      localwatch_ps_snapshot() { return 1; }
      log() { printf 'LOG:%s\\n' "$*"; }
      osascript() { printf '%s\\n' TERMINAL_OPENED; }
      ${TERMINAL_BOOTSTRAP_BLOCK}
    `], { encoding: "utf8" });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("same-name localwatch process scan failed; refusing bootstrap");
    expect(run.stdout).not.toContain("TERMINAL_OPENED");
  });

  test("canonicalizes inherited Terminal cwd before acquiring the lock", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "sm-localwatch-canonical-cwd-"));
    const repoDir = resolve(tempDir, "repo");
    mkdirSync(repoDir, { recursive: true });

    try {
      const result = runBash(`
        set -u
        REPO_DIR=${JSON.stringify(repoDir)}
        ${extractBlock(/canonicalize_localwatch_cwd\(\) \{/, /\n# Single-instance lock/)}
        cd ${JSON.stringify(tempDir)}
        canonicalize_localwatch_cwd
        pwd -P
      `);
      expect(result).toBe(realpathSync(repoDir));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("publishes complete lock provenance after a successful bootstrap", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "sm-localwatch-provenance-"));
    const repoDir = resolve(tempDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    const canonicalRepoDir = realpathSync(repoDir);
    const lockDir = resolve(repoDir, "logs/.localwatch.lock");
    mkdirSync(lockDir, { recursive: true });

    try {
      const result = runBash(`
        set -u
        REPO_DIR=${JSON.stringify(canonicalRepoDir)}
        SCRIPT_DIR=${JSON.stringify(resolve(canonicalRepoDir, "scripts"))}
        LOCK_DIR=${JSON.stringify(lockDir)}
        printf '%s\\n' "$$" > "$LOCK_DIR/pid"
        localwatch_process_start_for_pid() { printf '%s\\n' 'Thu Aug 28 06:00:00 2026'; }
        cd ${JSON.stringify(canonicalRepoDir)}
        ${extractBlock(/localwatch_boot_id\(\) \{/, /\npublish_localwatch_lock_provenance/)}
        ${extractBlock(/publish_localwatch_lock_provenance\(\) \{/, /\n# Returns 0 when this process/)}
        publish_localwatch_lock_provenance
        for field in pid repo-dir script-path cwd process-start boot-id maintenance-gate-version provenance.json; do
          [[ -s "$LOCK_DIR/$field" ]] || exit 2
        done
        jq -e --arg repo "$REPO_DIR" --arg script "$SCRIPT_DIR/localwatch.sh" \
          '.version == 1 and .capability == "platform-maintenance-gate-v1" and .repoDir == $repo and .scriptPath == $script and .cwd == $repo' \
          "$LOCK_DIR/provenance.json" >/dev/null
        printf '%s\\n' complete
      `);
      expect(result).toBe("complete");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("publishes a persistent owner receipt for active and stopped lifecycle states", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "sm-localwatch-owner-receipt-"));
    const repoDir = resolve(tempDir, "repo");
    const receiptPath = resolve(tempDir, "runtime/owner-receipt.json");
    mkdirSync(repoDir, { recursive: true });
    try {
      const result = runBash(`
        set -eu
        REPO_DIR=${JSON.stringify(realpathSync(repoDir))}
        SCRIPT_DIR=${JSON.stringify(resolve(repoDir, "scripts"))}
        LOG_DIR=${JSON.stringify(resolve(tempDir, "logs"))}
        SM_LOCALWATCH_OWNER_RECEIPT_PATH=${JSON.stringify(receiptPath)}
        SM_LOCALWATCH_INSTALLATION_NAMESPACE=${JSON.stringify(resolve(tempDir, "runtime"))}
        SM_LOCALWATCH_LAUNCHER_PATH=${JSON.stringify(resolve(tempDir, "runtime/start.sh"))}
        SM_BASE_URL=http://127.0.0.1:3511
        SM_SCHEDULER_HEALTH_URL=http://127.0.0.1:3512/health
        localwatch_process_start_for_pid() { printf '%s\\n' 'Thu Aug 28 06:00:00 2026'; }
        localwatch_boot_id() { printf '%s\\n' '123e4567-e89b-42d3-a456-426614174000'; }
        cd "$REPO_DIR"
        ${extractBlock(/publish_localwatch_owner_receipt\(\) \{/, /\n# Returns 0 when this process/)}
        publish_localwatch_owner_receipt active
        jq -e --arg repo "$REPO_DIR" \
          '.version == 1 and .kind == "localwatch-owner" and .status == "active" and .repoDir == $repo and .installationNamespace == "${resolve(tempDir, "runtime")}" and .healthEndpoints.api == "http://127.0.0.1:3511/api/health" and .healthEndpoints.scheduler == "http://127.0.0.1:3512/health"' ${JSON.stringify(receiptPath)} >/dev/null
        publish_localwatch_owner_receipt stopped
        jq -e '.status == "stopped" and (.stoppedAt | length) > 0' ${JSON.stringify(receiptPath)} >/dev/null
        printf '%s\\n' complete
      `);
      expect(result).toBe("complete");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("startup does not trust a live PID in the lock without exact localwatch identity", () => {
    const source = readFileSync(SCRIPT_PATH, "utf8");
    expect(source).toContain("localwatch_lock_holder_matches");
    expect(source).toContain("acquire_localwatch_lock");
    expect(source).not.toContain('if [[ -n "$holder" ]] && kill -0 "$holder"');
  });

  test("reclaims a stale lock whose live PID belongs to an unrelated process", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "sm-localwatch-stale-live-lock-"));
    const lockDir = resolve(tempDir, "logs/.localwatch.lock");
    mkdirSync(lockDir, { recursive: true });
    const unrelated = spawn("sleep", ["30"], { cwd: tempDir, stdio: "ignore" });
    if (!unrelated.pid) throw new Error("unrelated process did not start");
    writeFileSync(resolve(lockDir, "pid"), `${unrelated.pid}\n`);

    try {
      const result = runBash(`
        set -u
        REPO_DIR=${JSON.stringify(tempDir)}
        SCRIPT_DIR=${JSON.stringify(resolve(tempDir, "scripts"))}
        LOCK_DIR=${JSON.stringify(lockDir)}
        ${LOCALWATCH_IDENTITY_FNS}
        ${LOCALWATCH_LOCK_FNS}
        acquire_localwatch_lock
        status=$?
        printf 'status=%s holder=%s\n' "$status" "$(cat "$LOCK_DIR/pid")"
      `);
      expect(result).toContain("status=0");
      expect(result).not.toContain(`holder=${unrelated.pid}`);
      expect(process.kill(unrelated.pid, 0)).toBe(true);
    } finally {
      try { process.kill(unrelated.pid, "SIGKILL"); } catch { /* exited */ }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("refuses a stale lock when an unproven same-name localwatch is still alive", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "sm-localwatch-unknown-process-"));
    const repoDir = resolve(tempDir, "repo");
    const foreignDir = resolve(tempDir, "foreign");
    const scriptsDir = resolve(repoDir, "scripts");
    const lockDir = resolve(repoDir, "logs/.localwatch.lock");
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(foreignDir, { recursive: true });
    writeFileSync(resolve(scriptsDir, "localwatch.sh"), "#!/usr/bin/env bash\nwhile true; do sleep 1; done\n", { mode: 0o755 });
    const unknown = spawn("/bin/bash", [resolve(scriptsDir, "localwatch.sh")], {
      cwd: foreignDir,
      stdio: "ignore",
    });
    if (!unknown.pid) throw new Error("unknown localwatch did not start");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(resolve(lockDir, "pid"), "999999\n");

    try {
      const result = runBash(`
        set -u
        REPO_DIR=${JSON.stringify(repoDir)}
        SCRIPT_DIR=${JSON.stringify(scriptsDir)}
        LOCK_DIR=${JSON.stringify(lockDir)}
        ${LOCALWATCH_IDENTITY_FNS}
        ${LOCALWATCH_LOCK_FNS}
        acquire_localwatch_lock
        status=$?
        printf 'status=%s\\n' "$status"
      `);
      expect(result).toContain("status=2");
      expect(readFileSync(resolve(lockDir, "pid"), "utf8")).toBe("999999\n");
      expect(process.kill(unknown.pid, 0)).toBe(true);
    } finally {
      try { process.kill(unknown.pid, "SIGKILL"); } catch { /* exited */ }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("same-name scan does not match its own fork subshells", () => {
    // 2026-08-28 crash loop: a bootstrap launched as `bash /abs/localwatch.sh`
    // (the Terminal path) refused itself because the command substitution
    // evaluating the scan appeared in ps with the script's command line.
    const tempDir = mkdtempSync(resolve(tmpdir(), "sm-localwatch-self-scan-"));
    const probe = resolve(tempDir, "localwatch-self-probe.sh");
    writeFileSync(
      probe,
      `#!/usr/bin/env bash
set -u
source ${JSON.stringify(LOCALWATCH_IDENTITY_HELPER_PATH)}
out=$(localwatch_same_script_pids ${JSON.stringify(probe)} "$$")
printf 'conflicts=[%s]\\n' "$out"
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("/bin/bash", [probe], { encoding: "utf8" });
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe("conflicts=[]");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("matches only the exact SuperMatrix launcher in this repository", () => {
    const result = runBash(`
      set -u
      REPO_DIR=/repo/main
      ${ADOPT_EXISTING_SUPERMATRIX_FN}
      if is_repo_supermatrix_launcher_identity \
        'node /repo/main/node_modules/.bin/tsx /repo/main/src/cli/main.ts' \
        '/repo/main'; then
        printf '%s\n' exact
      fi
      if is_repo_supermatrix_launcher_identity \
        'node /repo/other/node_modules/.bin/tsx /repo/other/src/cli/main.ts' \
        '/repo/other'; then
        printf '%s\n' foreign
      fi
      if is_repo_supermatrix_launcher_identity \
        'node /repo/main/node_modules/.bin/tsx /repo/main/src/cli/main.ts' \
        '/repo/other'; then
        printf '%s\n' wrong-cwd
      fi
    `);

    expect(result).toBe("exact");
  });

  test("adopts one existing SuperMatrix process without signaling it", () => {
    const result = runBash(`
      set -u
      REPO_DIR=/repo/main
      sm_pid=0
      sm_start_ts=0
      sm_adopted=false
      kill() {
        if [[ "\${1:-}" == "-0" ]]; then return 0; fi
        printf 'KILL:%s\\n' "$*"
      }
      log() { printf 'LOG:%s\\n' "$*"; }
      send_alert() { printf 'ALERT:%s\\n' "$*"; }
      ${ADOPT_EXISTING_SUPERMATRIX_FN}
      repo_dev_loop_pids() { return 0; }
      repo_supermatrix_launcher_pids() { printf '%s\\n' '4242'; }
      adopt_existing_supermatrix
      printf 'STATE:pid=%s adopted=%s\\n' "$sm_pid" "$sm_adopted"
    `);

    expect(result).toContain("STATE:pid=4242 adopted=true");
    expect(result).not.toContain("KILL:");
  });

  test("ignores an unpermitted TERM without stopping managed processes", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "sm-localwatch-signal-deny-"));
    try {
      const result = runBash(`
        set -u
        SM_DB_PATH=${JSON.stringify(resolve(tempDir, "supermatrix.db"))}
        LOCK_DIR=${JSON.stringify(resolve(tempDir, ".localwatch.lock"))}
        mkdir -p "$LOCK_DIR"
        printf '%s\\n' '123e4567-e89b-42d3-a456-426614174000' > "$LOCK_DIR/boot-id"
        log() { printf 'LOG:%s\\n' "$*"; }
        send_alert() { printf 'ALERT:%s\\n' "$*"; }
        ${LOCALWATCH_MAINTENANCE_PERMIT_FNS}
        ${LOCALWATCH_CLEANUP_FN}
        cleanup
        printf '%s\\n' 'still-running'
      `);
      expect(result).toContain("unauthorized INT/TERM ignored");
      expect(result).toContain("still-running");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("a fresh exact restart permit exits localwatch without signaling its children", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "sm-localwatch-signal-allow-"));
    const permitPath = resolve(tempDir, ".localwatch-maintenance-permit.json");
    try {
      const result = runBash(`
        set -u
        SM_DB_PATH=${JSON.stringify(resolve(tempDir, "supermatrix.db"))}
        LOCK_DIR=${JSON.stringify(resolve(tempDir, ".localwatch.lock"))}
        mkdir -p "$LOCK_DIR"
        printf '%s\\n' '123e4567-e89b-42d3-a456-426614174000' > "$LOCK_DIR/boot-id"
        log() { printf 'LOG:%s\\n' "$*"; }
        send_alert() { printf 'ALERT:%s\\n' "$*"; }
        ${LOCALWATCH_MAINTENANCE_PERMIT_FNS}
        ${LOCALWATCH_CLEANUP_FN}
        jq -cn --argjson requestedAtMs "$(( $(date +%s) * 1000 ))" --argjson targetPid "$$" \\
          '{version:1,operation:"restart-localwatch",requestedAtMs:$requestedAtMs,targetPid:$targetPid,targetBootId:"123e4567-e89b-42d3-a456-426614174000",actorSessionName:"codexroot",reason:"test"}' \\
          > ${JSON.stringify(permitPath)}
        cleanup
        printf '%s\\n' 'unreachable'
      `);
      expect(result).toContain("authorized restart; leaving managed children running");
      expect(result).not.toContain("unreachable");
      expect(existsSync(permitPath)).toBe(false);
      expect(LOCALWATCH_CLEANUP_FN).not.toMatch(/\bpkill\b/);
      expect(LOCALWATCH_CLEANUP_FN).not.toContain('kill -TERM "$sm_pid"');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("writes a parseable atomic restart provenance marker", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "sm-localwatch-restart-provenance-"));
    try {
      const marker = resolve(tempDir, ".restart-provenance.json");
      const result = runBash(`
        set -u
        SM_DB_PATH=${JSON.stringify(resolve(tempDir, "supermatrix.db"))}
        sm_pid=33
        log() { printf 'LOG:%s\\n' "$*" >&2; }
        ${RESTART_PROVENANCE_FN}
        record_supermatrix_restart_provenance "localwatch-health" "probe failed" "scripts/localwatch.sh:test" "SIGTERM"
        cat ${JSON.stringify(marker)}
      `);
      expect(JSON.parse(result)).toMatchObject({
        version: 1,
        source: "localwatch-health",
        reason: "probe failed",
        path: "scripts/localwatch.sh:test",
        signal: "SIGTERM",
        targetPid: 33,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("preserves a fresh causal intent when crash cleanup follows the signal", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "sm-localwatch-restart-preserve-"));
    try {
      const marker = resolve(tempDir, ".restart-provenance.json");
      const result = runBash(`
        set -u
        SM_DB_PATH=${JSON.stringify(resolve(tempDir, "supermatrix.db"))}
        sm_pid=33
        log() { :; }
        ${RESTART_PROVENANCE_FN}
        record_supermatrix_restart_provenance "localwatch-health" "probe failed" "scripts/localwatch.sh:check_sm_health" "SIGTERM"
        record_supermatrix_restart_provenance "localwatch-crash-restart" "exit 137" "scripts/localwatch.sh:handle_supermatrix_exit" "PROCESS_EXIT" "0" "true"
        cat ${JSON.stringify(marker)}
      `);
      expect(JSON.parse(result)).toMatchObject({
        source: "localwatch-health",
        reason: "probe failed",
        path: "scripts/localwatch.sh:check_sm_health",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("records no restart provenance for automatic SuperMatrix health failures", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const healthCheck = extractBlock(
      /check_sm_health\(\) \{/,
      /\ncheck_lark_ws_health\(\)/,
    );

    expect(script).toContain("record_supermatrix_restart_provenance()");
    expect(healthCheck).toContain("自动 reload 已按策略禁用");
    expect(healthCheck).not.toContain("record_supermatrix_restart_provenance");
    expect(healthCheck).not.toMatch(/\b(?:kill|pkill)\b/);
  });

  test("keeps the real CLI first until bootstrap validates it", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain(
      'export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$REPO_DIR/node_modules/.bin:/usr/local/bin:/opt/homebrew/bin:$PATH"',
    );
  });

  test("heartbeat uses a dedicated chat and leaves alerts on the root group", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const heartbeatFn = script.match(/check_lark_connectivity\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    const alertFn = script.match(/send_alert\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

    expect(script).toContain(
      'LOCALWATCH_HEARTBEAT_GROUP="${LOCALWATCH_HEARTBEAT_GROUP:-oc_REDACTEDCHATID}"',
    );
    expect(heartbeatFn).toContain('--chat-id "$LOCALWATCH_HEARTBEAT_GROUP"');
    expect(heartbeatFn).not.toContain("$ROOT_GROUP");
    expect(alertFn).toContain('--chat-id "$ROOT_GROUP"');
  });

  test("syncs AI quota status hourly through localwatch status group", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const harness = `
      set -u
      LOCALWATCH_HEARTBEAT_GROUP=heartbeat-chat
      QUOTA_STATUS_NOTIFY_ENABLED=1
      QUOTA_STATUS_NOTIFY_TIMEOUT=90
      REPO_DIR=/repo
      calls_file=$(mktemp)
      log() { printf 'LOG:%s\\n' "$*"; }
      bounded() {
        printf 'RUN:%s\\n' "$*" >> "$calls_file"
        printf 'CHAT:%s\\n' "$SM_QUOTA_STATUS_CHAT_ID" >> "$calls_file"
        return 0
      }
      ${SEND_QUOTA_STATUS_FN}
      send_quota_status
      cat "$calls_file"
    `;

    const result = runBash(harness);

    expect(script).toContain('QUOTA_STATUS_NOTIFY_ENABLED="${QUOTA_STATUS_NOTIFY_ENABLED:-1}"');
    expect(script).toContain("tick % 360 == 0");
    expect(result).toContain("RUN:90 /repo/node_modules/.bin/tsx /repo/scripts/quota-status-notify.ts");
    expect(result).toContain("CHAT:heartbeat-chat");
  });

  test("scheduler v1 management is retired and v2 remains supervised", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    // v1 (port 3500) retired 2026-08-10: no v1 vars, start/exit handlers or health probe remain.
    expect(script).not.toContain("SCHEDULER_BIN");
    expect(script).not.toContain("SCHEDULER_CWD");
    expect(script).not.toContain("SCHEDULER_PORT=");
    expect(script).not.toContain("start_scheduler()");
    expect(script).not.toContain("handle_scheduler_exit()");
    expect(script).not.toContain("check_sched_health()");
    expect(script).not.toContain('memory_guard_check_process "Scheduler"');
    expect(script).toContain("Scheduler v1 (port 3500) retired 2026-08-10");
  });

  test("runs the process inventory in observe-only mode on the existing 30-second tick", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('PROCESS_OBSERVE_ENABLED="${PROCESS_OBSERVE_ENABLED:-1}"');
    expect(script).toContain('PROCESS_OBSERVE_TIMEOUT="${PROCESS_OBSERVE_TIMEOUT:-8}"');
    expect(script).toContain("observe_platform_processes()");
    expect(script).toContain('scripts/process-observe.ts" observe');
    expect(script).toContain("process observer:");
    expect(script).not.toContain("process-observe.ts enforce");
  });

  test("supervises scheduler-v2 on port 3502 via the durable launcher", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toMatch(/SCHEDULER_V2_PORT=.*3502/u);
    expect(script).toMatch(/SCHEDULER_V2_START=.*SM_SCHEDULER_START.*scheduler\/v2\/start\.sh/u);
    expect(script).toContain('lsof -nP -iTCP:"$SCHEDULER_V2_PORT" -sTCP:LISTEN -t');
    expect(script).toContain('http://localhost:$SCHEDULER_V2_PORT/health');
    expect(script).toContain('.ok == true and .service == "scheduler-v2"');
    expect(script).toContain('[[ ! -f "$SCHEDULER_V2_START" ]]');
    expect(script).not.toContain('[[ ! -x "$SCHEDULER_V2_START" ]]');
    expect(script).toContain('bash "$SCHEDULER_V2_START"');
    expect(script).toContain('start_scheduler_v2');
    expect(script).toContain('handle_scheduler_v2_exit');
    expect(script).toContain('check_sched_v2_health');
  });

  test.each([
    { body: JSON.stringify({ ok: true, service: "scheduler-v2" }), call: "start_scheduler_v2", kind: "scheduler-v2", source: START_SCHEDULER_V2_FN },
    { body: "ok", call: "start_card_ask_broker", kind: "card-ask", source: START_CARD_ASK_BROKER_FN },
    { body: "ok", call: "start_business_screen", kind: "business-screen", source: START_BUSINESS_SCREEN_FN },
    { body: "ok", call: "start_business_screen_architecture", kind: "business-screen-architecture", source: START_BUSINESS_SCREEN_ARCHITECTURE_FN },
  ])("preserves a real unrelated listener through the $kind startup path", async ({ body, call, source }) => {
    const fixtureDir = mkdtempSync(resolve(tmpdir(), "sm-localwatch-startup-fixture-"));
    const schedulerStart = resolve(fixtureDir, "scheduler/start.sh");
    const cardAskBrokerCwd = resolve(fixtureDir, "card-ask");
    const cardAskBrokerStart = resolve(cardAskBrokerCwd, "src/broker.js");
    const businessScreenCwd = resolve(fixtureDir, "business-screen");
    const businessScreenStart = resolve(businessScreenCwd, "server.js");
    const businessScreenArchitectureStart = resolve(
      businessScreenCwd,
      "server-session-architecture.js",
    );

    try {
      mkdirSync(resolve(fixtureDir, "scheduler"), { recursive: true });
      mkdirSync(resolve(cardAskBrokerCwd, "src"), { recursive: true });
      mkdirSync(businessScreenCwd, { recursive: true });
      writeFileSync(schedulerStart, "#!/usr/bin/env bash\nexit 0\n");
      writeFileSync(cardAskBrokerStart, "process.exit(0);\n");
      writeFileSync(businessScreenStart, "process.exit(0);\n");
      writeFileSync(businessScreenArchitectureStart, "process.exit(0);\n");

      const unrelated = await startUnrelatedListener(body);
      try {
        const result = runBash(`
          set -u
          REPO_DIR=${JSON.stringify(REPO_ROOT)}
          LOG_DIR=${JSON.stringify(resolve(fixtureDir, "logs"))}
          SCHEDULER_V2_START=${JSON.stringify(schedulerStart)}
          SCHEDULER_V2_PORT=${unrelated.port}
          CARD_ASK_BROKER_CWD=${JSON.stringify(cardAskBrokerCwd)}
          CARD_ASK_BROKER_START=${JSON.stringify(cardAskBrokerStart)}
          CARD_ASK_BROKER_PORT=${unrelated.port}
          BUSINESS_SCREEN_CWD=${JSON.stringify(businessScreenCwd)}
          BUSINESS_SCREEN_PORT=${unrelated.port}
          BUSINESS_SCREEN_HOST=127.0.0.1
          BUSINESS_SCREEN_ARCHITECTURE_ENABLED=1
          BUSINESS_SCREEN_ARCHITECTURE_START=${JSON.stringify(businessScreenArchitectureStart)}
          BUSINESS_SCREEN_ARCHITECTURE_PORT=${unrelated.port}
          PM2_QUERY_TIMEOUT=1
          LSOF_QUERY_TIMEOUT=1
          sched_v2_pid=0; sched_v2_owned=false; sched_v2_process_start=""
          card_ask_broker_pid=0; card_ask_broker_owned=false; card_ask_broker_process_start=""
          bs_pid=0; bs_process_start=""
          bs_architecture_pid=0; bs_architecture_process_start=""
          pm2() { return 1; }
          bounded() {
            local _secs="$1"; shift
            if [[ "$1" == "lsof" ]]; then printf '%s\n' ${unrelated.child.pid}; return 0; fi
            "$@"
          }
          log() { printf 'LOG:%s\n' "$*"; }
          send_alert() { printf 'ALERT:%s\n' "$*"; }
          ${MANAGED_COMPONENT_IDENTITY_FNS}
          ${source}
          ${call} || true
        `);

        expect(result).toContain("maintenance denied");
        expect(result).toContain("no signal sent");
        expect(process.kill(unrelated.child.pid!, 0)).toBe(true);
      } finally {
        await unrelated.close();
      }
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test.each([
    ["scheduler-v2", "Scheduler v2"],
    ["card-ask", "card-ask broker"],
    ["business-screen", "business-screen"],
    ["business-screen-architecture", "business-screen architecture"],
  ])("revalidates %s after TERM and refuses to KILL a reused PID", (kind, label) => {
    const result = runBash(`
      set -u
      identity_checks=0
      ${MANAGED_COMPONENT_IDENTITY_FNS}
      managed_component_identity_matches() {
        identity_checks=$((identity_checks + 1))
        [[ "$identity_checks" -eq 1 ]]
      }
      log() { printf 'LOG:%s\n' "$*"; }
      send_alert() { printf 'ALERT:%s\n' "$*"; }
      sleep() { :; }
      kill() {
        if [[ "$1" == "-0" ]]; then return 0; fi
        printf 'SIGNAL:%s\n' "$*"
      }
      signal_managed_component_for_restart ${JSON.stringify(kind)} 4242 "captured start" 5 ${JSON.stringify(label)} || true
    `);

    expect(result).toContain("SIGNAL:-TERM 4242");
    expect(result).not.toContain("SIGNAL:-KILL 4242");
    expect(result).toContain("identity changed after TERM");
  });

  test("routes every auxiliary health restart through exact managed identity checks", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const healthRestarts = script.slice(
      script.indexOf("check_sched_v2_health()"),
      script.indexOf("report_supermatrix_backend_api_issue()"),
    );

    expect(healthRestarts.match(/signal_managed_component_for_restart/g)).toHaveLength(4);
    expect(healthRestarts).not.toMatch(/\bkill\s+-(?:TERM|KILL)\b/);
  });

  test.each([
    ["scheduler-v2", "check_sched_v2_health"],
    ["card-ask", "check_card_ask_broker_health"],
    ["business-screen", "check_bs_health"],
    ["business-screen-architecture", "check_bs_architecture_health"],
  ])("suppresses post-TERM KILL after identity drift through %s health recovery", (_kind, call) => {
    const result = runBash(`
      set -u
      HEALTH_FAIL_THRESHOLD=1
      SCHEDULER_V2_PORT=3502
      CARD_ASK_BROKER_PORT=8787
      BUSINESS_SCREEN_PORT=4322
      BUSINESS_SCREEN_ARCHITECTURE_PORT=4323
      BUSINESS_SCREEN_ARCHITECTURE_ENABLED=1
      sched_v2_pid=4242; sched_v2_process_start="captured start"; sched_v2_health_fails=0
      card_ask_broker_pid=4242; card_ask_broker_process_start="captured start"; card_ask_broker_health_fails=0
      bs_pid=4242; bs_process_start="captured start"; bs_health_fails=0
      bs_architecture_pid=4242; bs_architecture_process_start="captured start"; bs_architecture_health_fails=0
      curl() { printf 'unhealthy'; return 1; }
      log() { printf 'LOG:%s\n' "$*"; }
      send_alert() { printf 'ALERT:%s\n' "$*"; }
      notify_t800_selfcheck() { printf 'SELF:%s\n' "$*"; }
      sleep() { :; }
      ${MANAGED_COMPONENT_IDENTITY_FNS}
      identity_checks=0
      managed_component_identity_matches() {
        printf 'IDENTITY:%s\n' "$1"
        identity_checks=$((identity_checks + 1))
        [[ "$identity_checks" -eq 1 ]]
      }
      kill() {
        if [[ "$1" == "-0" ]]; then return 0; fi
        printf 'SIGNAL:%s\n' "$*"
      }
      ${AUXILIARY_HEALTH_FNS}
      ${call}
    `);

    expect(result).toContain("SIGNAL:-TERM 4242");
    expect(result).not.toContain("SIGNAL:-KILL 4242");
    expect(result).toContain("identity changed after TERM");
  });

  test.each([
    ["Scheduler v2", "scheduler-v2"],
    ["card-ask broker", "card-ask"],
    ["business-screen", "business-screen"],
    ["business-screen-architecture", "business-screen-architecture"],
  ])("suppresses post-TERM KILL after identity drift through %s memory recovery", (_label, kind) => {
    const selectedPid = (candidate: string) => candidate === kind ? 4242 : 0;
    const result = runBash(`
      set -u
      MEMORY_GUARD_ENABLED=1
      MEMORY_GUARD_WARN_CONSECUTIVE=1
      MEMORY_GUARD_ACTION_CONSECUTIVE=1
      MEMORY_GUARD_TERM_GRACE_SECS=0
      MEMORY_GUARD_ALERT_COOLDOWN_SECS=0
      MEMORY_GUARD_SM_WARN_MB=1000
      MEMORY_GUARD_SM_ACTION_MB=1500
      MEMORY_GUARD_SCHED_WARN_MB=700
      MEMORY_GUARD_SCHED_ACTION_MB=800
      MEMORY_GUARD_CARD_ASK_WARN_MB=700
      MEMORY_GUARD_CARD_ASK_ACTION_MB=800
      MEMORY_GUARD_BUSINESS_SCREEN_WARN_MB=700
      MEMORY_GUARD_BUSINESS_SCREEN_ACTION_MB=800
      BUSINESS_SCREEN_ARCHITECTURE_ENABLED=1
      memory_guard_last_alert_ts=0
      sm_pid=0
      sm_stopped=false
      sched_v2_pid=${selectedPid("scheduler-v2")}
      sched_v2_owned=true
      card_ask_broker_pid=${selectedPid("card-ask")}
      card_ask_broker_owned=true
      bs_pid=${selectedPid("business-screen")}
      bs_architecture_pid=${selectedPid("business-screen-architecture")}
      sched_v2_process_start="captured start"
      card_ask_broker_process_start="captured start"
      bs_process_start="captured start"
      bs_architecture_process_start="captured start"
      log() { printf 'LOG:%s\n' "$*"; }
      send_alert() { printf 'ALERT:%s\n' "$*"; }
      send_memory_guard_alert() { printf 'MEMORY:%s\n' "$*"; }
      log_memory_top_snapshot() { :; }
      sleep() { :; }
      ${MEMORY_GUARD_FN}
      memory_guard_rss_mb() { printf '900\n'; }
      send_memory_guard_alert() { printf 'MEMORY:%s\n' "$*"; }
      log_memory_top_snapshot() { :; }
      ${MANAGED_COMPONENT_IDENTITY_FNS}
      identity_checks=0
      managed_component_identity_matches() {
        printf 'IDENTITY:%s\n' "$1"
        identity_checks=$((identity_checks + 1))
        [[ "$identity_checks" -eq 1 ]]
      }
      kill() {
        if [[ "$1" == "-0" ]]; then return 0; fi
        printf 'SIGNAL:%s\n' "$*"
      }
      printf 'CALLER:check_memory_guard\n'
      check_memory_guard || true
    `);

    expect(result).toContain("CALLER:check_memory_guard");
    expect(result).toContain("SIGNAL:-TERM 4242");
    expect(result).not.toContain("SIGNAL:-KILL 4242");
    expect(result).toContain("identity changed after TERM");
    expect(result).toContain(`IDENTITY:${kind}`);
  });

  test.each([
    ["business-screen", "business-screen"],
    ["business-screen architecture", "business-screen-architecture"],
  ])("suppresses post-TERM KILL after identity drift through %s heartbeat recovery", (_label, kind) => {
    const bsCode = kind === "business-screen" ? "503" : "200";
    const architectureCode = kind === "business-screen-architecture" ? "503" : "200";
    const result = runBash(`
      set -u
      LOCALWATCH_HEARTBEAT_GROUP=test-group
      LARK_APP_SECRET=test-secret
      LARK_WS_HEALTH_FAIL_THRESHOLD=2
      LARK_CALL_TIMEOUT=1
      LARK_CLI=lark-cli
      SM_API_PORT=3501
      BUSINESS_SCREEN_PORT=4322
      BUSINESS_SCREEN_ARCHITECTURE_PORT=4323
      BUSINESS_SCREEN_ARCHITECTURE_ENABLED=1
      lark_ws_health_fails=0
      lark_connectivity_abnormal_fails=0
      bs_pid=${kind === "business-screen" ? 4242 : 0}
      bs_process_start="captured start"
      bs_architecture_pid=${kind === "business-screen-architecture" ? 4242 : 0}
      bs_architecture_process_start="captured start"
      log() { printf 'LOG:%s\n' "$*"; }
      send_alert() { printf 'ALERT:%s\n' "$*"; }
      launchctl() { printf '1\t0\tcom.LOCAL_USER.localwatch\n'; }
      has_forced_lark_subscriber() { return 1; }
      report_unsafe_lark_subscribers() { :; }
      report_supermatrix_backend_api_issue() { :; }
      restart_launchd_label() { :; }
      bounded() { return 0; }
      start_business_screen() { printf 'START:business-screen\n'; }
      start_business_screen_architecture() { printf 'START:business-screen-architecture\n'; }
      sleep() { :; }
      curl() {
        local request="$*"
        case "$request" in
          *'/api/health/kimi-acp'*) printf '{"status":"ok","backend":"kimi","state":"ready","pid":1,"roundtrip":{"ok":true,"rttMs":1}}' ;;
          *'/api/health'*) printf '{"status":"ok"}' ;;
          *'localhost:4322/'*) printf '${bsCode}' ;;
          *'localhost:4323/'*) printf '${architectureCode}' ;;
          *'localhost:3510/health'*) printf '{"status":"ok","registryLoaded":true}' ;;
          *) return 1 ;;
        esac
      }
      ${MANAGED_COMPONENT_IDENTITY_FNS}
      identity_checks=0
      managed_component_identity_matches() {
        printf 'IDENTITY:%s\n' "$1"
        identity_checks=$((identity_checks + 1))
        [[ "$identity_checks" -eq 1 ]]
      }
      kill() {
        if [[ "$1" == "-0" ]]; then return 0; fi
        printf 'SIGNAL:%s\n' "$*"
      }
      ${CHECK_LARK_CONNECTIVITY_FN}
      printf 'CALLER:check_lark_connectivity\n'
      check_lark_connectivity || true
    `);

    expect(result).toContain("CALLER:check_lark_connectivity");
    expect(result).toContain("SIGNAL:-TERM 4242");
    expect(result).not.toContain("SIGNAL:-KILL 4242");
    expect(result).toContain("identity changed after TERM");
    expect(result).toContain(`IDENTITY:${kind}`);
    expect(result).toContain(`START:${kind}`);
  });

  test("routes memory and heartbeat component recovery through the same exact identity helper", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const memoryRestart = script.slice(
      script.indexOf("restart_supervised_process_for_memory_guard()"),
      script.indexOf("memory_guard_check_process()"),
    );
    const connectivity = script.slice(
      script.indexOf("check_lark_connectivity()"),
      script.indexOf("send_quota_status()"),
    );

    expect(memoryRestart).toContain("signal_managed_component_for_restart");
    expect(memoryRestart).not.toMatch(/\bkill\s+-(?:TERM|KILL)\b/);
    expect(connectivity.match(/recover_heartbeat_managed_component/g)).toHaveLength(2);
    expect(connectivity).not.toMatch(/\bkill\s+-(?:TERM|KILL)\b/);
  });

  test("startup paths never kill listeners whose managed identity was not proven", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const starts = script.slice(
      script.indexOf("start_scheduler_v2()"),
      script.indexOf("# ============================================================================\n# Auto-Repair"),
    );

    expect(starts).not.toMatch(/\bxargs\s+kill\b/);
    expect(starts).not.toMatch(/\bkill\s+-(?:TERM|KILL)\b/);
    expect(starts.match(/resolve_managed_port_holder/g)).toHaveLength(4);
  });

  test("supervises the card ask broker with health adoption and read-only Keychain secret lookup", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('CARD_ASK_BROKER_CWD="${CARD_ASK_BROKER_CWD:-/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/larkc/card-callback}"');
    expect(script).toContain('CARD_ASK_BROKER_START="${CARD_ASK_BROKER_START:-$CARD_ASK_BROKER_CWD/src/broker.js}"');
    expect(script).toContain('CARD_ASK_BROKER_PORT="${BROKER_PORT:-8787}"');
    expect(script).toContain('lsof -nP -iTCP:"$CARD_ASK_BROKER_PORT" -sTCP:LISTEN -t');
    expect(script).toContain('http://localhost:$CARD_ASK_BROKER_PORT/health');
    expect(script).toContain("adopting existing instance");
    expect(script).toContain("security find-generic-password");
    expect(script).toContain('LARK_APP_ID / LARK_APP_SECRET missing, skipping card-ask broker');
    expect(script).toContain('start_card_ask_broker');
    expect(script).toContain('handle_card_ask_broker_exit');
    expect(script).toContain('check_card_ask_broker_health');
  });

  test("supervises heartbeat todo-watch processes from localwatch", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain(
      'HEARTBEAT_WORKSPACE="${HEARTBEAT_WORKSPACE:-/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/heartbeat}"',
    );
    expect(script).toContain(
      'HEARTBEAT_TODO_WATCH_SCRIPT="${HEARTBEAT_TODO_WATCH_SCRIPT:-$HEARTBEAT_WORKSPACE/scripts/heartbeat-todo-watch}"',
    );
    expect(script).toContain("list_heartbeat_todo_watch_sessions()");
    expect(script).toContain("heartbeat_todo_watch_pid_for_session()");
    expect(script).toContain("release_heartbeat_todo_watch_claim()");
    expect(script).toContain("start_heartbeat_todo_watch()");
    expect(script).toContain("check_heartbeat_todo_watchers()");
    expect(script).toContain("check_heartbeat_todo_watchers");
    expect(script).not.toContain("terminate_heartbeat_todo_watchers");
  });

  test("does not start active paused heartbeat todo-watch sessions until their pause expires", () => {
    const result = runHeartbeatTodoWatchScenario({
      pendingSessions: ["active-pause", "expired-pause"],
      pauses: [
        ["active-pause", "paused", "2999-01-01T00:00:00+00:00"],
        ["expired-pause", "paused", "2000-01-01T00:00:00+00:00"],
      ],
    });

    expect(result).not.toContain("active-pause");
    expect(result).toContain("RELEASE:expired-pause");
    expect(result).toContain("START:expired-pause");
  });

  test("opens existing heartbeat state to release and start a non-paused pending watcher", () => {
    const result = runHeartbeatTodoWatchScenario({ pendingSessions: ["autoprice"] });

    expect(result).toContain("LOG:heartbeat todo watcher missing for session=autoprice; restarting under localwatch");
    expect(result).toContain("RELEASE:autoprice");
    expect(result).toContain("START:autoprice");
    expect(result).not.toContain("WARN: failed to release");
  });

  test("does not start a pending heartbeat todo watcher when claim release fails", () => {
    const result = runHeartbeatTodoWatchScenario({
      pendingSessions: ["autoprice"],
      releaseFails: true,
    });

    expect(result).toContain("LOG:WARN: failed to release heartbeat todo watcher claim for session=autoprice");
    expect(result).not.toContain("START:autoprice");
  });

  test("reports forced Lark event subscribers without cross-session signals", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("report_unsafe_lark_subscribers()");
    expect(script).toContain("lark-cli event \\+subscribe");
    expect(script).toContain("--force");
    expect(script).toContain("unsafe Lark subscriber");
    const reporter = extractBlock(
      /report_unsafe_lark_subscribers\(\) \{/,
      /\nrestart_launchd_label\(\)/,
    );
    expect(reporter).not.toMatch(/\bkill\b/);
    expect(reporter).toContain("not signalled");
  });

  test("reports orphan vitest workers without TERM or KILL", () => {
    const reporter = extractBlock(
      /report_orphan_vitest\(\) \{/,
      /\n# ============================================================================\n# Signal handling/,
    );

    expect(reporter).not.toMatch(/\bkill\b/);
    expect(reporter).toContain("not signalled");
  });

  test("heartbeat marks forced Lark subscribers as abnormal", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const heartbeatFn = script.match(/check_lark_connectivity\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

    expect(heartbeatFn).toContain("--force");
    expect(heartbeatFn).toContain("Lark subscriber --force");
  });

  test("self-check spawn payload uses spawn2.0 todo-pool closure with source and verification predicate", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("--arg from \"supermatrix-root\"");
    expect(script).toContain("--arg client_request_id");
    expect(script).toContain("closure:{kind:\"message\",target:{type:\"todo_pool\"}}");
    expect(script).toContain("/api/spawn2.0");
    expect(script).not.toContain("supermatrix_internal:{caller_invocation:\"async_kickoff\"}");
    expect(script).not.toContain("mode:\"async_kickoff\"");
    expect(script).toContain("verification_predicate");
    expect(script).toContain("session_name:$target");
    expect(script).toContain("contains_all:[\"localwatch self-check trigger\",$anchor]");
  });

  test("runs the backend API connectivity probe periodically with bounded self-repair", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("BACKEND_API_CHECK_TIMEOUT=180");
    expect(script).toContain("BACKEND_API_CHECK_FAIL_THRESHOLD=2");
    expect(script).toContain("backend_api_claude_health_fails=0");
    expect(script).toContain("backend_api_codex_health_fails=0");
    expect(script).toContain("backend_api_kimi_health_fails=0");
    expect(script).toContain("check_backend_api_connectivity()");
    expect(script).toContain('"$REPO_DIR/node_modules/.bin/tsx" "$REPO_DIR/scripts/backend-api-connectivity.ts" --repair');
    expect(script).toContain("backend API connectivity failed");
    expect(script).toContain("backend API connectivity recovered");
    expect(script).toContain("notify_t800_selfcheck");
    expect(script).toContain("tick % 180 == 0");
  });

  test("keeps Kimi ACP failures counted and requires a manual reload at the threshold", () => {
    const kimiFailure = JSON.stringify({
      ok: false,
      probes: [
        { backend: "claude", ok: true, model: "claude-opus-4-8" },
        { backend: "codex", ok: true, model: "gpt-5.5" },
        {
          backend: "kimi",
          ok: false,
          failureKind: "degraded",
          excerpt: "shared Kimi ACP roundtrip failed",
        },
      ],
      repairs: [],
      restartRecommended: false,
    });
    const harness = `
      set -u
      BACKEND_API_CHECK_TIMEOUT=180
      BACKEND_API_CHECK_FAIL_THRESHOLD=2
      REPO_DIR=/repo
      backend_api_claude_health_fails=0
      backend_api_codex_health_fails=0
      backend_api_kimi_health_fails=0
      bounded() { printf '%s\\n' ${JSON.stringify(kimiFailure)}; return 1; }
      log() { printf 'LOG:%s\\n' "$*"; }
      send_backend_api_alert() { printf 'KIMI_ALERT:%s\\n' "$*"; }
      notify_t800_selfcheck() { printf 'SELF:%s\\n' "$*"; }
      ${BACKEND_API_CONNECTIVITY_FN}
      check_backend_api_connectivity
      printf 'AFTER1:kimi=%s\\n' "$backend_api_kimi_health_fails"
      check_backend_api_connectivity
      printf 'AFTER2:kimi=%s\\n' "$backend_api_kimi_health_fails"
    `;

    const result = runBash(harness);

    expect(result).toContain("AFTER1:kimi=1");
    expect(result).toContain("AFTER2:kimi=2");
    expect(result).toContain("KIMI_ALERT:⚠️ Kimi ACP");
    expect(result).toContain("自动 reload 已按策略禁用");
    expect(result).not.toContain("safe-reload.sh");
  });

  test("runs a lightweight Claude auth check before starting SuperMatrix", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const main = script.slice(script.lastIndexOf('log "localwatch starting"'));

    expect(script).toContain("CLAUDE_AUTH_CHECK_TIMEOUT=20");
    expect(script).toContain("check_claude_auth_on_startup()");
    expect(script).toContain('"$REPO_DIR/scripts/backend-api-connectivity.ts" --auth-only');
    expect(main.indexOf("check_claude_auth_on_startup")).toBeGreaterThan(-1);
    expect(main.indexOf("check_claude_auth_on_startup")).toBeLessThan(
      main.indexOf("start_supermatrix"),
    );
  });

  test("runs the memory guard periodically", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("MEMORY_GUARD_ENABLED");
    expect(script).toContain("check_memory_guard()");
    expect(script).toContain("check_memory_guard");
  });

  test("never auto-terminates SuperMatrix for health, memory, or backend repair", () => {
    const memoryReport = extractBlock(
      /report_supermatrix_memory_guard\(\) \{/,
      /\nrestart_supervised_process_for_memory_guard\(\)/,
    );
    const healthCheck = extractBlock(
      /check_sm_health\(\) \{/,
      /\ncheck_lark_ws_health\(\)/,
    );
    const backendReport = extractBlock(
      /report_supermatrix_backend_api_issue\(\) \{/,
      /\ncheck_claude_auth_on_startup\(\)/,
    );

    for (const block of [memoryReport, healthCheck, backendReport]) {
      expect(block).not.toMatch(/\b(?:kill|pkill)\b/);
      expect(block).not.toContain("safe-reload.sh");
    }
  });

  test("memory guard reports SuperMatrix hard RSS hits without reloading it", () => {
    const harness = `
      set -u
      MEMORY_GUARD_ENABLED=1
      MEMORY_GUARD_WARN_CONSECUTIVE=2
      MEMORY_GUARD_ACTION_CONSECUTIVE=3
      MEMORY_GUARD_ALERT_COOLDOWN_SECS=600
      MEMORY_GUARD_TERM_GRACE_SECS=10
      MEMORY_GUARD_SM_WARN_MB=100
      MEMORY_GUARD_SM_ACTION_MB=150
      MEMORY_GUARD_SCHED_WARN_MB=1000
      MEMORY_GUARD_SCHED_ACTION_MB=1500
      MEMORY_GUARD_CARD_ASK_WARN_MB=1000
      MEMORY_GUARD_CARD_ASK_ACTION_MB=1500
      MEMORY_GUARD_BUSINESS_SCREEN_WARN_MB=1000
      MEMORY_GUARD_BUSINESS_SCREEN_ACTION_MB=1500
      sm_pid=123
      sm_stopped=false
      sched_pid=0
      sched_owned=false
      sched_v2_pid=0
      sched_v2_owned=false
      card_ask_broker_pid=0
      card_ask_broker_owned=false
      bs_pid=0
      bs_architecture_pid=0
      memory_guard_sm_warn_hits=0
      memory_guard_sm_action_hits=0
      memory_guard_sched_warn_hits=0
      memory_guard_sched_action_hits=0
      memory_guard_sched_v2_warn_hits=0
      memory_guard_sched_v2_action_hits=0
      memory_guard_card_ask_warn_hits=0
      memory_guard_card_ask_action_hits=0
      memory_guard_bs_warn_hits=0
      memory_guard_bs_action_hits=0
      memory_guard_bs_architecture_warn_hits=0
      memory_guard_bs_architecture_action_hits=0
      memory_guard_last_alert_ts=0
      log() { printf 'LOG:%s\\n' "$*"; }
      ${MEMORY_GUARD_FN}
      memory_guard_rss_mb() { printf '175\\n'; }
      send_memory_guard_alert() { printf 'ALERT:%s\\n' "$*"; }
      log_memory_top_snapshot() { printf 'SNAPSHOT\\n'; }
      report_supermatrix_memory_guard() { printf 'REPORT_SM:%s\\n' "$*"; }
      restart_supervised_process_for_memory_guard() { printf 'RESTART_PROC:%s\\n' "$*"; }
      check_memory_guard
      check_memory_guard
      check_memory_guard
    `;

    const result = runBash(harness);

    expect(result.match(/REPORT_SM:/g)?.length).toBe(1);
    expect(result).toContain("memory guard: SuperMatrix rss=175MB exceeded action=150MB (3/3)");
  });

  test("memory guard does not restart scheduler-v2 instances it does not own", () => {
    const harness = `
      set -u
      MEMORY_GUARD_ENABLED=1
      MEMORY_GUARD_WARN_CONSECUTIVE=1
      MEMORY_GUARD_ACTION_CONSECUTIVE=1
      MEMORY_GUARD_ALERT_COOLDOWN_SECS=600
      MEMORY_GUARD_TERM_GRACE_SECS=10
      MEMORY_GUARD_SM_WARN_MB=1000
      MEMORY_GUARD_SM_ACTION_MB=1500
      MEMORY_GUARD_SCHED_WARN_MB=100
      MEMORY_GUARD_SCHED_ACTION_MB=150
      MEMORY_GUARD_CARD_ASK_WARN_MB=1000
      MEMORY_GUARD_CARD_ASK_ACTION_MB=1500
      MEMORY_GUARD_BUSINESS_SCREEN_WARN_MB=1000
      MEMORY_GUARD_BUSINESS_SCREEN_ACTION_MB=1500
      sm_pid=0
      sm_stopped=false
      sched_v2_pid=234
      sched_v2_owned=false
      card_ask_broker_pid=0
      card_ask_broker_owned=false
      bs_pid=0
      bs_architecture_pid=0
      memory_guard_sm_warn_hits=0
      memory_guard_sm_action_hits=0
      memory_guard_sched_v2_warn_hits=0
      memory_guard_sched_v2_action_hits=0
      memory_guard_card_ask_warn_hits=0
      memory_guard_card_ask_action_hits=0
      memory_guard_bs_warn_hits=0
      memory_guard_bs_action_hits=0
      memory_guard_bs_architecture_warn_hits=0
      memory_guard_bs_architecture_action_hits=0
      memory_guard_last_alert_ts=0
      log() { printf 'LOG:%s\\n' "$*"; }
      ${MEMORY_GUARD_FN}
      memory_guard_rss_mb() { printf '175\\n'; }
      send_memory_guard_alert() { printf 'ALERT:%s\\n' "$*"; }
      log_memory_top_snapshot() { printf 'SNAPSHOT\\n'; }
      report_supermatrix_memory_guard() { printf 'REPORT_SM:%s\\n' "$*"; }
      restart_supervised_process_for_memory_guard() { printf 'RESTART_PROC:%s\\n' "$*"; }
      check_memory_guard
    `;

    const result = runBash(harness);

    expect(result).toContain("memory guard: skipping Scheduler v2 pid=234 because localwatch does not own it");
    expect(result).not.toContain("RESTART_PROC:");
    expect(result).not.toContain("REPORT_SM:");
  });

  test("alerts without restarting SuperMatrix when the backend probe reports Claude auth failure", () => {
    const output = JSON.stringify({
      ok: false,
      probes: [
        {
          backend: "claude",
          ok: false,
          model: "claude-opus-4-8",
          failureKind: "auth",
          excerpt: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        },
        { backend: "codex", ok: true, model: "gpt-5.5" },
      ],
      repairs: [],
      restartRecommended: false,
    });
    const harness = `
      set -u
      BACKEND_API_CHECK_TIMEOUT=180
      BACKEND_API_CHECK_FAIL_THRESHOLD=2
      REPO_DIR=/repo
      backend_api_claude_health_fails=0
      backend_api_codex_health_fails=0
      bounded() { printf '%s\\n' ${JSON.stringify(output)}; return 1; }
      log() { printf 'LOG:%s\\n' "$*"; }
      send_alert() { printf 'ALERT:%s\\n' "$*"; }
      notify_t800_selfcheck() { printf 'SELF:%s\\n' "$*"; }
      report_supermatrix_backend_api_issue() { printf 'REPORT:%s\\n' "$*"; }
      ${SEND_BACKEND_API_ALERT_FN}
      ${BACKEND_API_CONNECTIVITY_FN}
      send_backend_api_alert() { printf 'BACKEND_ALERT:%s\\n' "$*"; }
      check_backend_api_connectivity
      printf 'CLAUDE_FAILS:%s\\n' "$backend_api_claude_health_fails"
      printf 'CODEX_FAILS:%s\\n' "$backend_api_codex_health_fails"
    `;

    const result = runBash(harness);

    expect(result).not.toContain("RESTART:");
    expect(result).toContain("BACKEND_ALERT:⚠️ Claude Code 登录态无效");
    expect(result).toContain("claude auth login --claudeai");
    expect(result).toContain("CLAUDE_FAILS:1");
    expect(result).toContain("CODEX_FAILS:0");
  });

  test("tracks Claude and Codex backend API connectivity failures independently", () => {
    const claudeFailure = JSON.stringify({
      ok: false,
      probes: [
        {
          backend: "claude",
          ok: false,
          model: "claude-opus-4-8",
          failureKind: "transport",
          excerpt: "socket connection was closed",
        },
        { backend: "codex", ok: true, model: "gpt-5.5" },
      ],
      repairs: [],
      restartRecommended: false,
    });
    const codexFailure = JSON.stringify({
      ok: false,
      probes: [
        { backend: "claude", ok: true, model: "claude-opus-4-8" },
        {
          backend: "codex",
          ok: false,
          model: "gpt-5.5",
          failureKind: "model_access",
          excerpt: "The model does not exist or you do not have access to it",
        },
      ],
      repairs: [],
      restartRecommended: false,
    });
    const outputs = [claudeFailure, codexFailure, codexFailure].join("\n---\n");
    const harness = `
      set -u
      BACKEND_API_CHECK_TIMEOUT=180
      BACKEND_API_CHECK_FAIL_THRESHOLD=2
      LOCALWATCH_HEARTBEAT_GROUP=heartbeat-chat
      LARK_CALL_TIMEOUT=10
      LARK_CLI=lark-cli
      REPO_DIR=/repo
      backend_api_claude_health_fails=0
      backend_api_codex_health_fails=0
      outputs_file=$(mktemp)
      cat > "$outputs_file" <<'EOF'
${outputs}
EOF
      bounded() {
        if [[ "\${2:-}" == "lark-cli" ]]; then
          printf 'SEND:%s\\n' "$*"
          return 0
        fi
        awk 'BEGIN{RS="\\n---\\n"} NR==1{print; exit}' "$outputs_file"
        awk 'BEGIN{RS="\\n---\\n"; ORS=""} NR>1{if (NR>2) print "\\n---\\n"; print}' "$outputs_file" > "$outputs_file.next"
        mv "$outputs_file.next" "$outputs_file"
        return 1
      }
      log() { printf 'LOG:%s\\n' "$*"; }
      send_alert() { printf 'ALERT:%s\\n' "$*"; }
      notify_t800_selfcheck() { printf 'SELF:%s\\n' "$*"; }
      report_supermatrix_backend_api_issue() { printf 'REPORT:%s\\n' "$*"; }
      ${SEND_BACKEND_API_ALERT_FN}
      ${BACKEND_API_CONNECTIVITY_FN}
      check_backend_api_connectivity
      printf 'AFTER1:claude=%s codex=%s\\n' "$backend_api_claude_health_fails" "$backend_api_codex_health_fails"
      check_backend_api_connectivity
      printf 'AFTER2:claude=%s codex=%s\\n' "$backend_api_claude_health_fails" "$backend_api_codex_health_fails"
      check_backend_api_connectivity
      printf 'AFTER3:claude=%s codex=%s\\n' "$backend_api_claude_health_fails" "$backend_api_codex_health_fails"
    `;

    const result = runBash(harness);

    expect(result).toContain("AFTER1:claude=1 codex=0");
    expect(result).toContain("AFTER2:claude=0 codex=1");
    expect(result).toContain("AFTER3:claude=0 codex=0");
    expect(result).toContain("SEND:10 lark-cli im +messages-send --as bot --chat-id heartbeat-chat --text ⚠️ Codex API 连通性连续 2 次失败");
    expect(result).not.toContain("ALERT:⚠️ Claude/Codex API 连通性");
    expect(result).not.toContain("ALERT:⚠️ Claude API 连通性连续 2 次失败");
  });

  test("tries to repair autobitable adapter before reporting the heartbeat abnormal", () => {
    const harness = `
      set -u
      LOCALWATCH_HEARTBEAT_GROUP=heartbeat-chat
      LARK_CALL_TIMEOUT=10
      LARK_CLI=lark-cli
      BUSINESS_SCREEN_PORT=4322
      BUSINESS_SCREEN_ARCHITECTURE_ENABLED=0
      LARK_APP_SECRET=secret
      lark_connectivity_abnormal_fails=0
      autobitable_calls_file=$(mktemp)
      printf '0' > "$autobitable_calls_file"
      launchctl() { printf 'com.LOCAL_USER.localwatch\\n'; }
      has_forced_lark_subscriber() { return 1; }
      restart_launchd_label() { printf 'REPAIR:%s\\n' "$1"; }
      log() { printf 'LOG:%s\\n' "$*"; }
      osascript() { return 0; }
      sleep() { :; }
      bounded() { printf 'SEND:%s\\n' "$*"; return 0; }
      curl() {
        local url=""
        for arg in "$@"; do url="$arg"; done
        case "$url" in
          *3501/api/health/kimi-acp*) printf '{"status":"ok","backend":"kimi","pid":123,"state":"ready","roundtrip":{"ok":true,"rttMs":3}}' ;;
          *3501/api/health*) printf '{"status":"ok"}' ;;
          *4322*) printf '200' ;;
          *3510/health*)
            autobitable_calls=$(cat "$autobitable_calls_file")
            autobitable_calls=$((autobitable_calls + 1))
            printf '%s' "$autobitable_calls" > "$autobitable_calls_file"
            if [[ "$autobitable_calls" -eq 1 ]]; then
              printf '{"status":"down","registryLoaded":false}'
            else
              printf '{"status":"ok","registryLoaded":true}'
            fi
            ;;
          *) printf '{}' ;;
        esac
      }
      ${CHECK_LARK_CONNECTIVITY_FN}
      check_lark_connectivity
    `;

    const result = runBash(harness);

    expect(result).toContain("REPAIR:com.supermatrix.autobitable-adapter");
    expect(result).toContain("SEND:10 lark-cli im +messages-send --as bot --chat-id heartbeat-chat --text 💓 localwatch heartbeat");
    expect(result).toContain("一切正常");
    expect(result).not.toContain("异常：autobitable");
  });

  test("reports that SuperMatrix needs a manual reload before heartbeat recovery", () => {
    const harness = `
      set -u
      LOCALWATCH_HEARTBEAT_GROUP=heartbeat-chat
      LARK_CALL_TIMEOUT=10
      LARK_CLI=lark-cli
      BUSINESS_SCREEN_PORT=4322
      BUSINESS_SCREEN_ARCHITECTURE_ENABLED=0
      LARK_APP_SECRET=secret
      lark_connectivity_abnormal_fails=0
      sm_calls_file=$(mktemp)
      printf '0' > "$sm_calls_file"
      launchctl() { printf 'com.LOCAL_USER.localwatch\\n'; }
      has_forced_lark_subscriber() { return 1; }
      report_supermatrix_backend_api_issue() { printf 'SM_REPORT:%s\\n' "$*"; }
      restart_launchd_label() { printf 'REPAIR:%s\\n' "$1"; }
      log() { printf 'LOG:%s\\n' "$*"; }
      osascript() { return 0; }
      sleep() { :; }
      bounded() { printf 'SEND:%s\\n' "$*"; return 0; }
      curl() {
        local url=""
        for arg in "$@"; do url="$arg"; done
        case "$url" in
          *3501/api/health/kimi-acp*) printf '{"status":"ok","backend":"kimi","pid":123,"state":"ready","roundtrip":{"ok":true,"rttMs":3}}' ;;
          *3501/api/health*)
            sm_calls=$(cat "$sm_calls_file")
            sm_calls=$((sm_calls + 1))
            printf '%s' "$sm_calls" > "$sm_calls_file"
            if [[ "$sm_calls" -eq 1 ]]; then
              printf '{"status":"down"}'
            else
              printf '{"status":"ok"}'
            fi
            ;;
          *4322*) printf '200' ;;
          *3510/health*) printf '{"status":"ok","registryLoaded":true}' ;;
          *) printf '{}' ;;
        esac
      }
      ${CHECK_LARK_CONNECTIVITY_FN}
      check_lark_connectivity
    `;

    const result = runBash(harness);

    expect(result).toContain(
      "SM_REPORT:SuperMatrix heartbeat /api/health failed " +
      "localwatch-heartbeat-repair scripts/localwatch.sh:check_lark_connectivity",
    );
    expect(result).toContain("一切正常");
    expect(result).not.toContain("异常：SuperMatrix");
  });

  test("reports heartbeat abnormal only after two consecutive failed repair attempts", () => {
    const harness = `
      set -u
      LOCALWATCH_HEARTBEAT_GROUP=heartbeat-chat
      LARK_CALL_TIMEOUT=10
      LARK_CLI=lark-cli
      BUSINESS_SCREEN_PORT=4322
      BUSINESS_SCREEN_ARCHITECTURE_ENABLED=0
      LARK_APP_SECRET=secret
      lark_connectivity_abnormal_fails=0
      launchctl() { printf 'com.LOCAL_USER.localwatch\\n'; }
      has_forced_lark_subscriber() { return 1; }
      restart_launchd_label() { printf 'REPAIR:%s\\n' "$1"; }
      log() { printf 'LOG:%s\\n' "$*"; }
      osascript() { return 0; }
      sleep() { :; }
      bounded() { printf 'SEND:%s\\n' "$*"; return 0; }
      curl() {
        local url=""
        for arg in "$@"; do url="$arg"; done
        case "$url" in
          *3501/api/health/kimi-acp*) printf '{"status":"ok","backend":"kimi","pid":123,"state":"ready","roundtrip":{"ok":true,"rttMs":3}}' ;;
          *3501/api/health*) printf '{"status":"ok"}' ;;
          *4322*) printf '200' ;;
          *3510/health*) printf '{"status":"down","registryLoaded":false}' ;;
          *) printf '{}' ;;
        esac
      }
      ${CHECK_LARK_CONNECTIVITY_FN}
      check_lark_connectivity
      printf 'AFTER_FIRST:%s\\n' "$lark_connectivity_abnormal_fails"
      check_lark_connectivity
      printf 'AFTER_SECOND:%s\\n' "$lark_connectivity_abnormal_fails"
    `;

    const result = runBash(harness);

    expect(result).toContain("AFTER_FIRST:1");
    expect(result).toContain("AFTER_SECOND:2");
    expect(result.match(/异常：autobitable/g)?.length).toBe(1);
  });

  test("keeps a degraded shared Kimi ACP out of all-normal heartbeat and reports it after two probes", () => {
    const harness = `
      set -u
      LOCALWATCH_HEARTBEAT_GROUP=heartbeat-chat
      LARK_CALL_TIMEOUT=10
      LARK_CLI=lark-cli
      BUSINESS_SCREEN_PORT=4322
      BUSINESS_SCREEN_ARCHITECTURE_ENABLED=0
      LARK_APP_SECRET=secret
      lark_connectivity_abnormal_fails=0
      launchctl() { printf 'com.LOCAL_USER.localwatch\\n'; }
      has_forced_lark_subscriber() { return 1; }
      report_supermatrix_backend_api_issue() { printf 'RAW_REPORT:%s\\n' "$*"; }
      restart_launchd_label() { printf 'REPAIR:%s\\n' "$1"; }
      log() { printf 'LOG:%s\\n' "$*"; }
      osascript() { return 0; }
      sleep() { :; }
      bounded() { printf 'SEND:%s\\n' "$*"; return 0; }
      curl() {
        local url=""
        for arg in "$@"; do url="$arg"; done
        case "$url" in
          *3501/api/health/kimi-acp*) printf '{"status":"degraded","backend":"kimi","pid":123,"state":"ready","roundtrip":{"ok":false,"error":"session/list timed out"}}' ;;
          *3501/api/health*) printf '{"status":"ok"}' ;;
          *4322*) printf '200' ;;
          *3510/health*) printf '{"status":"ok","registryLoaded":true}' ;;
          *) printf '{}' ;;
        esac
      }
      ${CHECK_LARK_CONNECTIVITY_FN}
      check_lark_connectivity
      printf 'AFTER_FIRST:%s\\n' "$lark_connectivity_abnormal_fails"
      check_lark_connectivity
      printf 'AFTER_SECOND:%s\\n' "$lark_connectivity_abnormal_fails"
    `;

    const result = runBash(harness);

    expect(result).toContain("AFTER_FIRST:1");
    expect(result).toContain("AFTER_SECOND:2");
    expect(result).not.toContain("一切正常");
    expect(result).toContain("异常：Kimi ACP");
    expect(result).not.toContain("RAW_REPORT:");
  });

  test("logs and routes managed-service threshold, launch, config, and recovery events to the heartbeat group", () => {
    const checkManagedServicesFn = extractBlock(
      /check_managed_services\(\) \{/,
      /\nappend_managed_services_heartbeat_abnormal\(\)/,
    );
    const helperOutput = JSON.stringify({
      ok: true,
      abnormalLabels: ["Clash Verge", "ZiNiao"],
      notifications: [
        { kind: "failure-threshold", label: "Clash Verge", message: "threshold reached" },
        { kind: "launch-attempt", label: "Clash Verge", message: "relaunch requested" },
        { kind: "config-error", message: "invalid schema" },
        { kind: "recovered", label: "ZiNiao", message: "real probes recovered" },
      ],
    });
    const harness = `
      set -u
      MANAGED_SERVICES_CHECK_TIMEOUT=20
      REPO_DIR=/repo
      LOCALWATCH_HEARTBEAT_GROUP=heartbeat-chat
      managed_services_heartbeat_abnormal=""
      bounded() { printf '%s\\n' ${JSON.stringify(helperOutput)}; return 0; }
      log() { printf 'LOG:%s\\n' "$*"; }
      send_backend_api_alert() { printf 'HEARTBEAT:%s\\n' "$*"; }
      ${checkManagedServicesFn}
      check_managed_services
      printf 'ABNORMAL:%s\\n' "$managed_services_heartbeat_abnormal"
    `;

    const result = runBash(harness);

    expect(result).toContain("LOG:managed service failure-threshold: Clash Verge: threshold reached");
    expect(result).toContain("LOG:managed service launch-attempt: Clash Verge: relaunch requested");
    expect(result).toContain("LOG:managed service config-error: invalid schema");
    expect(result).toContain("LOG:managed service recovered: ZiNiao: real probes recovered");
    expect(result).toContain("HEARTBEAT:⚠️ localwatch managed service failure-threshold: Clash Verge: threshold reached");
    expect(result).toContain("HEARTBEAT:✅ localwatch managed service recovered: ZiNiao: real probes recovered");
    expect(result).toContain("ABNORMAL:Clash Verge, ZiNiao");
  });

  test("keeps a current managed-service failure out of the all-normal heartbeat", () => {
    const appendManagedServicesFn = extractBlock(
      /append_managed_services_heartbeat_abnormal\(\) \{/,
      /\ncheck_lark_connectivity\(\)/,
    );
    const harness = `
      set -u
      LOCALWATCH_HEARTBEAT_GROUP=heartbeat-chat
      LARK_CALL_TIMEOUT=10
      LARK_CLI=lark-cli
      BUSINESS_SCREEN_PORT=4322
      BUSINESS_SCREEN_ARCHITECTURE_ENABLED=0
      LARK_APP_SECRET=secret
      lark_connectivity_abnormal_fails=0
      managed_services_heartbeat_abnormal="Clash Verge"
      launchctl() { printf 'com.LOCAL_USER.localwatch\\n'; }
      has_forced_lark_subscriber() { return 1; }
      restart_launchd_label() { :; }
      log() { printf 'LOG:%s\\n' "$*"; }
      osascript() { return 0; }
      sleep() { :; }
      bounded() { printf 'SEND:%s\\n' "$*"; return 0; }
      curl() {
        local url=""
        for arg in "$@"; do url="$arg"; done
        case "$url" in
          *3501/api/health/kimi-acp*) printf '{"status":"ok","backend":"kimi","pid":123,"state":"ready","roundtrip":{"ok":true,"rttMs":3}}' ;;
          *3501/api/health*) printf '{"status":"ok"}' ;;
          *4322*) printf '200' ;;
          *3510/health*) printf '{"status":"ok","registryLoaded":true}' ;;
          *) printf '{}' ;;
        esac
      }
      ${appendManagedServicesFn}
      ${CHECK_LARK_CONNECTIVITY_FN}
      check_lark_connectivity
      check_lark_connectivity
    `;

    const result = runBash(harness);

    expect(result).not.toContain("一切正常");
    expect(result).toContain("异常：Clash Verge");
  });
});

describe("backend API connectivity probe helpers", () => {
  test("checks Claude auth status before inference and redacts account metadata", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "sm-claude-auth-probe-"));
    const fakeClaude = resolve(tempDir, "claude");
    const fakeCodex = resolve(tempDir, "codex");
    const callsFile = resolve(tempDir, "claude-calls.log");
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_CLAUDE_CALLS"
if [[ "\${1:-}" == "auth" && "\${2:-}" == "status" ]]; then
  printf '%s\\n' '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty","email":"secret@example.com"}'
  exit 1
fi
printf '%s\\n' '{"type":"result","result":"OK"}'
`,
    );
    writeFileSync(fakeCodex, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(fakeClaude, 0o755);
    chmodSync(fakeCodex, 0o755);

    try {
      const result = spawnSync(
        resolve(REPO_ROOT, "node_modules/.bin/tsx"),
        [resolve(REPO_ROOT, "scripts/backend-api-connectivity.ts"), "--auth-only"],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            FAKE_CLAUDE_CALLS: callsFile,
            SM_CLAUDE_CLI_PATH: fakeClaude,
            SM_CODEX_CLI_PATH: fakeCodex,
            SM_BACKEND_API_PROBE_TIMEOUT_MS: "5000",
          },
        },
      );
      const summary = JSON.parse(result.stdout) as {
        probes: Array<{ backend: string; ok: boolean; failureKind?: string; excerpt?: string }>;
      };
      const claude = summary.probes.find((probe) => probe.backend === "claude");

      expect(result.status).toBe(1);
      expect(readFileSync(callsFile, "utf8").trim()).toBe("auth status");
      expect(summary.probes.map((probe) => probe.backend)).toEqual(["claude"]);
      expect(claude).toMatchObject({ backend: "claude", ok: false, failureKind: "auth" });
      expect(claude?.excerpt).toContain("loggedIn=false");
      expect(claude?.excerpt).not.toContain("secret@example.com");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("probes the process-owned Kimi ACP health endpoint without launching a Kimi CLI", async () => {
    const { kimiWasLaunched, requests, result } = await runConnectivityAgainstKimiHealth({
      body: JSON.stringify({
        status: "ok",
        backend: "kimi",
        pid: 12345,
        state: "ready",
        roundtrip: { ok: true, rttMs: 17 },
      }),
    });
    const summary = JSON.parse(result.stdout) as {
      ok: boolean;
      probes: Array<{
        backend: string;
        ok: boolean;
        pid?: number;
        roundtrip?: { ok: boolean; rttMs?: number };
        state?: string;
      }>;
    };
    const kimi = summary.probes.find((probe) => probe.backend === "kimi");

    expect(result.code).toBe(0);
    expect(summary.ok).toBe(true);
    expect(requests).toEqual(["/api/health/kimi-acp"]);
    expect(kimiWasLaunched).toBe(false);
    expect(kimi).toMatchObject({
      backend: "kimi",
      ok: true,
      pid: 12345,
      state: "ready",
      roundtrip: { ok: true, rttMs: 17 },
    });
  });

  test.each([
    [
      "degraded Kimi ACP response",
      {
        status: 503,
        body: JSON.stringify({
          status: "degraded",
          backend: "kimi",
          pid: 12345,
          state: "ready",
          roundtrip: { ok: false, error: "session/list timed out" },
        }),
      },
      1_000,
      false,
      "degraded",
    ],
    ["malformed Kimi ACP response", { body: "not-json" }, 1_000, false, "bad_payload"],
    ["timed out Kimi ACP response", { hang: true }, 100, false, "timeout"],
    ["unreachable Kimi ACP endpoint", {}, 1_000, true, "transport"],
  ] as const)("classifies %s without falling back to a Kimi CLI", async (
    _label,
    response,
    timeoutMs,
    closeBeforeRun,
    failureKind,
  ) => {
    const { kimiWasLaunched, result } = await runConnectivityAgainstKimiHealth(
      response,
      timeoutMs,
      closeBeforeRun,
    );
    const summary = JSON.parse(result.stdout) as {
      probes: Array<{ backend: string; ok: boolean; failureKind?: string }>;
    };
    const kimi = summary.probes.find((probe) => probe.backend === "kimi");

    expect(result.code).toBe(1);
    expect(kimiWasLaunched).toBe(false);
    expect(kimi).toMatchObject({ backend: "kimi", ok: false, failureKind });
  });

  test("classifies 401 authentication failures before transport wording", () => {
    expect(
      classifyBackendConnectivityError(
        "Failed to authenticate. API Error: 401 The socket connection was closed unexpectedly",
      ),
    ).toBe("auth");
  });

  test("classifies model access and transport failures", () => {
    expect(
      classifyBackendConnectivityError("The model `gpt-5.5` does not exist or you do not have access to it."),
    ).toBe("model_access");
    expect(classifyBackendConnectivityError("The socket connection was closed unexpectedly")).toBe("transport");
  });

  test("updates an env assignment without touching surrounding lines", () => {
    const input = "A=1\nSM_CODEX_DEFAULT_MODEL=gpt-5.5\nB=2\n";

    expect(updateEnvAssignment(input, "SM_CODEX_DEFAULT_MODEL", "gpt-5.4")).toBe(
      "A=1\nSM_CODEX_DEFAULT_MODEL=gpt-5.4\nB=2\n",
    );
    expect(updateEnvAssignment("A=1\n", "SM_CODEX_DEFAULT_MODEL", "gpt-5.4")).toBe(
      "A=1\nSM_CODEX_DEFAULT_MODEL=gpt-5.4\n",
    );
  });

  test("extracts the current selected Mihomo proxy node", () => {
    expect(selectedProxyName({ name: "Codex-Fast", now: "Claude-Stable" })).toBe("Claude-Stable");
    expect(selectedProxyName({ name: "Codex-Fast", fixed: "Claude-Stable" })).toBe("Claude-Stable");
    expect(selectedProxyName({ name: "Codex-Fast" })).toBeNull();
  });
});

describe("localwatch Lark subscriber health probe (in-process WS adaptation)", () => {
  // Run the REAL probe-3 block with stubbed helpers and inspect the `abnormal`
  // array it produces. has_forced_lark_subscriber / pgrep are stubbed by return
  // code (0 = forced present / external subscriber found).
  function probeAbnormal(opts: {
    forced: boolean;
    externalSubscriberRunning: boolean;
    larkAppSecret: string;
    larkWsFailures?: number;
  }): string {
    const forcedRc = opts.forced ? 0 : 1;
    const pgrepRc = opts.externalSubscriberRunning ? 0 : 1;
    const harness = `
      set -u
      report_supermatrix_backend_api_issue() { :; }
      report_unsafe_lark_subscribers() { :; }
      sleep() { :; }
      has_forced_lark_subscriber() { return ${forcedRc}; }
      pgrep() { return ${pgrepRc}; }
      abnormal=()
      LARK_APP_SECRET=${JSON.stringify(opts.larkAppSecret)}
      LARK_WS_HEALTH_FAIL_THRESHOLD=2
      lark_ws_health_fails=${opts.larkWsFailures ?? 0}
      ${PROBE3}
      printf '%s\\n' "\${abnormal[*]:-}"
    `;
    return runBash(harness);
  }

  test("does NOT false-alarm in-process WS mode (LARK_APP_SECRET set, no external lark-cli subscriber)", () => {
    // The 2026-06-13 regression: live SuperMatrix runs the subscriber in-process,
    // so no external process exists — this must stay healthy.
    expect(
      probeAbnormal({ forced: false, externalSubscriberRunning: false, larkAppSecret: "secret-xyz" }),
    ).toBe("");
  });

  test("marks a confirmed in-process SDK WS failure threshold without looking for a second subscriber", () => {
    expect(
      probeAbnormal({
        forced: false,
        externalSubscriberRunning: false,
        larkAppSecret: "secret-xyz",
        larkWsFailures: 2,
      }),
    ).toBe("Lark SDK WS");
  });

  test("still flags a missing subscriber in legacy external mode (no LARK_APP_SECRET)", () => {
    expect(
      probeAbnormal({ forced: false, externalSubscriberRunning: false, larkAppSecret: "" }),
    ).toBe("Lark subscriber");
  });

  test("legacy external mode with a running subscriber stays healthy", () => {
    expect(
      probeAbnormal({ forced: false, externalSubscriberRunning: true, larkAppSecret: "" }),
    ).toBe("");
  });

  test("flags an unsafe --force subscriber regardless of mode", () => {
    expect(
      probeAbnormal({ forced: true, externalSubscriberRunning: false, larkAppSecret: "secret-xyz" }),
    ).toBe("Lark subscriber --force");
    expect(
      probeAbnormal({ forced: true, externalSubscriberRunning: true, larkAppSecret: "" }),
    ).toBe("Lark subscriber --force");
  });

  test("counts only terminal SDK WS health responses before requesting safe reload", () => {
    const checkLarkWsHealth = extractBlock(
      /check_lark_ws_health\(\) \{/,
      /\ncheck_sched_v2_health\(\)/,
    );
    const responses = [
      JSON.stringify({ status: "grace", ingress: "node-sdk-ws", state: "reconnecting" }),
      JSON.stringify({ status: "degraded", ingress: "node-sdk-ws", state: "failed" }),
      JSON.stringify({ status: "ok", ingress: "node-sdk-ws", state: "connected", reconnectAttempts: 0 }),
      JSON.stringify({ status: "degraded", ingress: "node-sdk-ws", state: "failed" }),
      JSON.stringify({ status: "degraded", ingress: "node-sdk-ws", state: "failed" }),
    ];
    const harness = `
      set -u
      LARK_APP_SECRET=secret
      LARK_WS_HEALTH_FAIL_THRESHOLD=2
      lark_ws_health_fails=0
      sm_pid=123
      sm_stopped=false
      responses_file=$(mktemp)
      cat > "$responses_file" <<'EOF'
${responses.join("\n---\n")}
EOF
      curl() {
        awk 'BEGIN{RS="\\n---\\n"} NR==1{print; exit}' "$responses_file"
        awk 'BEGIN{RS="\\n---\\n"; ORS=""} NR>1{if (NR>2) print "\\n---\\n"; print}' "$responses_file" > "$responses_file.next"
        mv "$responses_file.next" "$responses_file"
      }
      log() { printf 'LOG:%s\\n' "$*"; }
      send_backend_api_alert() { printf 'ALERT:%s\\n' "$*"; }
      ${checkLarkWsHealth}
      check_lark_ws_health
      printf 'AFTER_GRACE:%s\\n' "$lark_ws_health_fails"
      check_lark_ws_health
      printf 'AFTER_ONE:%s\\n' "$lark_ws_health_fails"
      check_lark_ws_health
      printf 'AFTER_RECOVERY:%s\\n' "$lark_ws_health_fails"
      check_lark_ws_health
      printf 'AFTER_TWO:%s\\n' "$lark_ws_health_fails"
      check_lark_ws_health
      printf 'AFTER_THRESHOLD:%s\\n' "$lark_ws_health_fails"
    `;

    const result = runBash(harness);

    expect(result).toContain("AFTER_GRACE:0");
    expect(result).toContain("AFTER_ONE:1");
    expect(result).toContain("AFTER_RECOVERY:0");
    expect(result).toContain("AFTER_TWO:1");
    expect(result).toContain("AFTER_THRESHOLD:2");
    expect(result).toContain("ALERT:⚠️ Lark SDK WS");
    expect(result).toContain("自动 reload 已按策略禁用");
  });

  // has_forced_lark_subscriber drives both the heartbeat --force flag and
  // report_unsafe_lark_subscribers — exercise the real ps|awk|grep predicate.
  function hasForced(psLine: string): boolean {
    const harness = `
      set -u
      ps() { printf '%s\\n' ${JSON.stringify(psLine)}; }
      ${HAS_FORCED_FN}
      if has_forced_lark_subscriber; then echo FORCED; else echo CLEAN; fi
    `;
    return runBash(harness) === "FORCED";
  }

  test("detects a --force subscriber from ps output", () => {
    expect(
      hasForced("4242 node /repo/node_modules/.bin/lark-cli event +subscribe --as bot --force"),
    ).toBe(true);
  });

  test("does not treat a normal (non --force) subscriber as unsafe", () => {
    expect(
      hasForced("4242 node /repo/node_modules/.bin/lark-cli event +subscribe --as bot"),
    ).toBe(false);
  });

  test("treats no subscriber process as clean", () => {
    expect(hasForced("")).toBe(false);
  });

  test("ignores an unrelated process that merely carries the subscriber string in its argv", () => {
    // Real 2026-06-13 case: a claude session's prompt text embedded the literal
    // `lark-cli event +subscribe --as bot --force` string, so the claude process
    // argv matched a bare regex. The comm guard ($2 == node || ~ lark-cli) keeps
    // report_unsafe_lark_subscribers from misclassifying it.
    expect(
      hasForced("2655 claude claude -p --model opus lark-cli event +subscribe --as bot --force ..."),
    ).toBe(false);
  });

  test("supervises the session architecture business-screen on port 4323 independently", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('BUSINESS_SCREEN_ARCHITECTURE_ENABLED="${BUSINESS_SCREEN_ARCHITECTURE_ENABLED:-0}"');
    expect(script).toContain('BUSINESS_SCREEN_ARCHITECTURE_PORT="${BUSINESS_SCREEN_ARCHITECTURE_PORT:-4323}"');
    expect(script).toContain('BUSINESS_SCREEN_ARCHITECTURE_START="${BUSINESS_SCREEN_ARCHITECTURE_START:-$BUSINESS_SCREEN_CWD/server-session-architecture.js}"');
    expect(script).toContain('node "$BUSINESS_SCREEN_ARCHITECTURE_START"');
    expect(script).toContain('>> "$LOG_DIR/business-screen-architecture.stdout.log"');
    expect(script).toContain('2>> "$LOG_DIR/business-screen-architecture.stderr.log"');
    expect(script).toContain("start_business_screen_architecture");
    expect(script).toContain("handle_business_screen_architecture_exit");
    expect(script).toContain("check_bs_architecture_health");
    expect(script).toContain("authorized restart; leaving managed children running for successor adoption");

    // Keep the existing main dashboard on its original port and entrypoint.
    expect(script).toContain('BUSINESS_SCREEN_PORT="${BUSINESS_SCREEN_PORT:-4322}"');
    expect(script).toContain('node "$BUSINESS_SCREEN_CWD/server.js"');
  });

  test("does not start, restart, health-check, or alert for disabled architecture service", () => {
    const result = runBash(`
      set -u
      BUSINESS_SCREEN_ARCHITECTURE_ENABLED=0
      BUSINESS_SCREEN_ARCHITECTURE_START=/definitely/missing/server-session-architecture.js
      BUSINESS_SCREEN_ARCHITECTURE_PORT=4323
      bs_architecture_pid=123
      HEALTH_FAIL_THRESHOLD=1
      log() { printf 'LOG:%s\\n' "$*"; }
      send_alert() { printf 'ALERT:%s\\n' "$*"; }
      curl() { printf '503'; }
      kill() { printf 'KILL:%s\\n' "$*"; }
      ${START_BUSINESS_SCREEN_ARCHITECTURE_FN}
      ${HANDLE_BUSINESS_SCREEN_ARCHITECTURE_FN}
      ${CHECK_BUSINESS_SCREEN_ARCHITECTURE_HEALTH_FN}
    `);

    expect(result).toBe("");
  });
});
