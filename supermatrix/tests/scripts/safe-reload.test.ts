import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/safe-reload.sh");

// lark-cli stub modes, selected via FAKE_LARK_MODE. Every mode records the call
// FIRST, so "the message may already have been delivered" is literally true for
// the failure modes — that is the whole point of the claim-before-dispatch fix.
type LarkMode =
  | "ok" // returns the well-formed `"ok": true` envelope
  | "exit-nonzero" // sent, then exited non-zero (network hiccup on the reply path)
  | "compact-ok" // sent, exited 0, and printed an equivalent compact JSON envelope
  | "slow-ok"; // sent after a delay, used to overlap two concurrent ticks

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("scripts/safe-reload.sh", () => {
  test("fails closed when invoked without a maintenance gate approval", async () => {
    const env = makeEnvironment();

    const run = await runSafeReload(env, { mode: "ok", approved: false });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("[policy-deny] missing maintenance gate approval");
    expect(larkCalls(env)).toHaveLength(0);
    expect(existsSync(env.markerPath)).toBe(false);
  });

  test("forged environment approval cannot dispatch without live codexroot attestation", async () => {
    const env = makeEnvironment();

    const run = await runSafeReload(env, {
      mode: "ok",
      callerAttestation: "smca_forged",
    });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("caller attestation is not live codexroot provenance");
    expect(larkCalls(env)).toHaveLength(0);
    expect(existsSync(env.markerPath)).toBe(false);
  });

  test("bypasses inherited proxies for the loopback caller-attestation request", async () => {
    const env = makeEnvironment();

    const run = await runSafeReload(env, { mode: "ok", requireDirectLoopback: true });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[reload-fired]");
    expect(larkCalls(env)).toHaveLength(1);
  });

  test("fires once, recording the claim marker", async () => {
    const env = makeEnvironment();

    const run = await runSafeReload(env, { mode: "ok" });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[reload-fired]");
    expect(larkCalls(env)).toHaveLength(1);
    expect(larkCalls(env)[0]).toContain("/reload --source scheduled-daily");
    expect(larkCalls(env)[0]).toMatch(/--permit smrp_[a-f0-9]{32}/);
    const permit = reloadPermits(env)[0];
    expect(permit).toMatchObject({
      version: 1,
      operation: "reload-supermatrix",
      source: "scheduled-daily",
      force: false,
      actorSessionName: "codexroot",
      callerSessionId: "child_codexroot_test",
      callerAttestationToken: "smca_valid_test",
    });
    expect(permit.nonce).toMatch(/^smrp_[a-f0-9]{32}$/);
    expect(run.stdout).not.toContain(String(permit.nonce));
    expect(readFileSync(env.markerPath, "utf8")).toContain("source=scheduled-daily");
  });

  test("manual maintenance skips busy sessions immediately without consuming the claim", async () => {
    const env = makeEnvironment({ busySessions: 2 });

    const run = await runSafeReload(env, { mode: "ok", source: "codexroot-maintenance" });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[busy-skip] count=2");
    expect(larkCalls(env)).toHaveLength(0);
    expect(reloadPermits(env)).toHaveLength(0);
    expect(existsSync(env.markerPath)).toBe(false);
  });

  test("scheduled daily waits for a short-lived busy session and then reloads", async () => {
    const env = makeEnvironment({ busySessions: 1, releaseBusyOnSleep: true });

    const run = await runSafeReload(env, { mode: "ok" });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[busy-wait] count=1");
    expect(run.stdout).toContain("[reload-fired]");
    expect(larkCalls(env)).toHaveLength(1);
    expect(existsSync(env.markerPath)).toBe(true);
  }, 15_000);

  test("scheduled daily stops without a pending reload when the window ends busy", async () => {
    const env = makeEnvironment({ busySessions: 1, advancePastWindowOnSleep: true });

    const run = await runSafeReload(env, { mode: "ok" });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[busy-wait] count=1");
    expect(run.stdout).toContain("[busy-window-expired] count=1");
    expect(larkCalls(env)).toHaveLength(0);
    expect(reloadPermits(env)).toHaveLength(0);
    expect(existsSync(env.markerPath)).toBe(false);
  }, 15_000);

  test("excludes the current codexroot maintenance child from the busy-session gate", async () => {
    const env = makeEnvironment({ busySessions: 1 });

    const run = await runSafeReload(env, {
      mode: "ok",
      callerSessionId: "sess_busy_0",
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[reload-fired]");
    expect(larkCalls(env)).toHaveLength(1);
  });

  test("a fresh marker dedups the tick under the default window", async () => {
    const env = makeEnvironment();
    writeFileSync(env.markerPath, "claimed_at=1 source=scheduled-daily\n");

    const run = await runSafeReload(env, { mode: "ok" });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[dedup-skip]");
    expect(larkCalls(env)).toHaveLength(0);
  });

  test("manual codexroot maintenance does not consume or reuse the daily claim", async () => {
    const env = makeEnvironment();
    writeFileSync(env.markerPath, "claimed_at=1 source=scheduled-daily\n");

    const run = await runSafeReload(env, {
      mode: "ok",
      source: "codexroot-maintenance",
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[reload-fired]");
    expect(larkCalls(env)[0]).toContain("/reload --source codexroot-maintenance");
    expect(existsSync(env.manualMarkerPath)).toBe(true);
  });

  test("an explicitly gated codexroot force records and bypasses other busy sessions", async () => {
    const env = makeEnvironment({ busySessions: 2 });

    const run = await runSafeReload(env, {
      mode: "ok",
      source: "codexroot-maintenance",
      callerSessionId: "sess_busy_0",
      force: true,
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[force-authorized] busy=1");
    expect(larkCalls(env)[0]).toContain("/reload force --source codexroot-maintenance");
    expect(reloadPermits(env)[0]).toMatchObject({
      source: "codexroot-maintenance",
      force: true,
      actorSessionName: "codexroot",
      callerSessionId: "sess_busy_0",
    });
  });

  test("an aged-out marker lets the next daily reload through", async () => {
    const env = makeEnvironment();
    writeFileSync(env.markerPath, "claimed_at=1 source=scheduled-daily\n");
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(env.markerPath, twentyFiveHoursAgo, twentyFiveHoursAgo);

    const run = await runSafeReload(env, { mode: "ok" });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[reload-fired]");
    expect(larkCalls(env)).toHaveLength(1);
  });

  // The exact incident shape (watchdog-kimi-acp-982f503): the send lands, the
  // bookkeeping never happens. Before the fix the marker was touched only after a
  // clean result, so every subsequent `*/5` tick re-sent /reload.
  test("a non-zero lark-cli exit after possible delivery retains the claim and is never retried", async () => {
    const env = makeEnvironment();

    const failed = await runSafeReload(env, { mode: "exit-nonzero" });

    expect(failed.code).toBe(2);
    expect(failed.stderr).toContain("[dispatch-ambiguous]");
    expect(failed.stdout).not.toContain("[reload-fired]");
    expect(larkCalls(env)).toHaveLength(1);
    expect(existsSync(env.markerPath)).toBe(true);

    const nextTick = await runSafeReload(env, { mode: "ok" });

    expect(nextTick.code).toBe(0);
    expect(nextTick.stdout).toContain("[dedup-skip]");
    expect(larkCalls(env)).toHaveLength(1);
  });

  test("accepts a compact JSON success envelope from lark-cli", async () => {
    const env = makeEnvironment();

    const run = await runSafeReload(env, { mode: "compact-ok" });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[reload-fired]");
    expect(larkCalls(env)).toHaveLength(1);
    expect(existsSync(env.markerPath)).toBe(true);
  });

  test("refuses obsolete automatic sources before they can bypass dedup or dispatch", async () => {
    const env = makeEnvironment();

    const run = await runSafeReload(env, {
      mode: "ok",
      dedupWindowSec: 0,
      source: "localwatch-kimi-health",
    });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("[policy-deny] source=localwatch-kimi-health");
    expect(larkCalls(env)).toHaveLength(0);
    expect(existsSync(env.markerPath)).toBe(false);
  });

  test("two concurrent ticks dispatch exactly once", async () => {
    const env = makeEnvironment();

    const runs = await Promise.all([
      runSafeReload(env, { mode: "slow-ok" }),
      runSafeReload(env, { mode: "slow-ok" }),
    ]);

    expect(larkCalls(env)).toHaveLength(1);
    expect(runs.filter((run) => run.stdout.includes("[reload-fired]"))).toHaveLength(1);
    const stoodDown = runs.find((run) => !run.stdout.includes("[reload-fired]"))!;
    expect(stoodDown.code).toBe(0);
    expect(stoodDown.stdout).toMatch(/\[claim-contended\]|\[dedup-skip\]/);
  });

  test("a live claim lock makes the tick stand down without dispatching", async () => {
    const env = makeEnvironment();
    mkdirSync(env.claimLockPath);

    const run = await runSafeReload(env, { mode: "ok" });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[claim-contended]");
    expect(larkCalls(env)).toHaveLength(0);
    expect(existsSync(env.markerPath)).toBe(false);
  });

  test("a stale claim lock from a killed tick is broken instead of wedging reloads", async () => {
    const env = makeEnvironment();
    mkdirSync(env.claimLockPath);
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(env.claimLockPath, longAgo, longAgo);

    const run = await runSafeReload(env, { mode: "ok" });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[reload-fired]");
    expect(larkCalls(env)).toHaveLength(1);
    expect(existsSync(env.claimLockPath)).toBe(false);
  });
});

type Environment = {
  binDir: string;
  claimLockPath: string;
  callsPath: string;
  larkCliPath: string;
  manualMarkerPath: string;
  markerPath: string;
  root: string;
  scriptPath: string;
};

/**
 * Builds a throwaway repo whose scripts/ holds the live safe-reload.sh, so the
 * assertions run the real script text while .env.local, the sqlite db, the marker
 * and lark-cli all point at the temp tree.
 */
function makeEnvironment(options: {
  advancePastWindowOnSleep?: boolean;
  busySessions?: number;
  releaseBusyOnSleep?: boolean;
} = {}): Environment {
  const root = mkdtempSync(join(tmpdir(), "sm-safe-reload-"));
  tempDirs.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "data"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);

  const scriptPath = join(root, "scripts", "safe-reload.sh");
  writeFileSync(scriptPath, readFileSync(SCRIPT_PATH, "utf8"), { mode: 0o755 });

  const dbPath = join(root, "data", "supermatrix.db");
  seedSessions(dbPath, options.busySessions ?? 0);

  const nowHhmmPath = join(root, "now-hhmm");
  writeFileSync(nowHhmmPath, "0350\n");
  writeFileSync(
    join(binDir, "date"),
    `#!/bin/zsh\nif [[ "$1" == "+%H%M" ]]; then cat ${JSON.stringify(nowHhmmPath)}; else /bin/date "$@"; fi\n`,
    { mode: 0o755 },
  );
  if (options.releaseBusyOnSleep || options.advancePastWindowOnSleep) {
    writeFileSync(
      join(binDir, "sleep"),
      `#!/bin/zsh
${options.releaseBusyOnSleep ? `/usr/bin/sqlite3 ${JSON.stringify(dbPath)} "UPDATE sessions SET status = 'idle' WHERE status = 'busy';"\n` : ""}${options.advancePastWindowOnSleep ? `printf '0411\\n' > ${JSON.stringify(nowHhmmPath)}\n` : ""}exit 0
`,
      { mode: 0o755 },
    );
  }

  const callsPath = join(root, "lark-calls.log");
  const larkCliPath = join(root, "fake-lark-cli");
  writeFileSync(larkCliPath, fakeLarkCli(callsPath), { mode: 0o755 });
  writeFileSync(
    join(binDir, "curl"),
    `#!/bin/bash
if [[ "\${FAKE_REQUIRE_DIRECT_LOOPBACK:-0}" == "1" ]]; then
  direct_loopback=false
  args=("$@")
  for (( index=0; index < \${#args[@]} - 1; index += 1 )); do
    if [[ "\${args[$index]}" == "--noproxy" && "\${args[$((index + 1))]}" == "*" ]]; then
      direct_loopback=true
      break
    fi
  done
  [[ "$direct_loopback" == "true" ]] || exit 7
fi
if [[ "$*" == *"smca_valid_test"* ]]; then
  printf '{"ok":true,"attested":true,"ownerSessionName":"codexroot","sessionId":"%s"}\n' "\${FAKE_CALLER_SESSION_ID}"
  exit 0
fi
printf '%s\n' '{"ok":false,"attested":false}'
exit 0
`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(root, ".env.local"),
    [
      `SM_DB_PATH=${dbPath}`,
      "SM_ROOT_GROUP_ID=oc_test_root_group",
      `SM_LARK_CLI_PATH=${larkCliPath}`,
      "",
    ].join("\n"),
  );

  return {
    binDir,
    callsPath,
    claimLockPath: join(root, "data", ".last-reload-fired.claim.lock"),
    larkCliPath,
    manualMarkerPath: join(root, "data", ".last-maintenance-reload-fired"),
    markerPath: join(root, "data", ".last-reload-fired"),
    root,
    scriptPath,
  };
}

function seedSessions(dbPath: string, busySessions: number): void {
  const db = new Database(dbPath);
  try {
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL);");
    const insert = db.prepare("INSERT INTO sessions (id, name, status) VALUES (?, ?, ?)");
    insert.run("sess_idle", "idle-session", "idle");
    for (let index = 0; index < busySessions; index += 1) {
      insert.run(`sess_busy_${index}`, `busy-session-${index}`, "busy");
    }
  } finally {
    db.close();
  }
}

function fakeLarkCli(callsPath: string): string {
  return `#!/usr/bin/env bash
# Record the send BEFORE reacting to FAKE_LARK_MODE: the failure modes model a
# message that already left for Feishu.
printf '%s\\n' "$*" >> "${callsPath}"
case "\${FAKE_LARK_MODE:-ok}" in
  exit-nonzero)
    printf '%s\\n' 'timed out reading the send result' >&2
    exit 1
    ;;
  compact-ok)
    printf '%s\\n' '{"ok":true,"data":{"message_id":"om_drift"}}'
    ;;
  slow-ok)
    sleep 0.4
    printf '%s\\n' '{"ok": true, "data": {"message_id": "om_slow"}}'
    ;;
  *)
    printf '%s\\n' '{"ok": true, "data": {"message_id": "om_ok"}}'
    ;;
esac
exit 0
`;
}

async function runSafeReload(
  env: Environment,
  options: {
    mode: LarkMode;
    dedupWindowSec?: number;
    source?: string;
    approved?: boolean;
    callerSessionId?: string;
    callerAttestation?: string;
    force?: boolean;
    requireDirectLoopback?: boolean;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("zsh", [env.scriptPath], {
      env: {
        ...process.env,
        FAKE_LARK_MODE: options.mode,
        FAKE_REQUIRE_DIRECT_LOOPBACK: options.requireDirectLoopback ? "1" : "0",
        FAKE_CALLER_SESSION_ID: options.callerSessionId ?? "child_codexroot_test",
        PATH: `${env.binDir}:${process.env.PATH ?? ""}`,
        SM_MAINTENANCE_GATE_APPROVAL: options.approved === false
          ? undefined
          : "platform-maintenance-gate-v1",
        SM_MAINTENANCE_CALLER_SESSION_ID: options.callerSessionId ?? "child_codexroot_test",
        SM_CALLER_ATTESTATION: options.callerAttestation ?? "smca_valid_test",
        SM_MAINTENANCE_FORCE: options.force ? "true" : "false",
        SM_RELOAD_SOURCE: options.source ?? "scheduled-daily",
        SM_RELOAD_DEDUP_WINDOW_SEC: options.dedupWindowSec === undefined
          ? undefined
          : String(options.dedupWindowSec),
      },
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (typeof failure.code !== "number") throw error;
    return { code: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function larkCalls(env: Environment): string[] {
  if (!existsSync(env.callsPath)) return [];
  return readFileSync(env.callsPath, "utf8").split("\n").filter((line) => line.length > 0);
}

function reloadPermits(env: Environment): Array<Record<string, unknown>> {
  return readdirSync(join(env.root, "data"))
    .filter((name) => /^\.supermatrix-reload-permit\.smrp_[a-f0-9]{32}\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(env.root, "data", name), "utf8")) as Record<string, unknown>);
}
