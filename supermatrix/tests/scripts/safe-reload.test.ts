import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
  | "shape-drift" // sent, exited 0, but printed an envelope the grep does not match
  | "slow-ok"; // sent after a delay, used to overlap two concurrent ticks

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("scripts/safe-reload.sh", () => {
  test("fires once, recording the claim marker", async () => {
    const env = makeEnvironment();

    const run = await runSafeReload(env, { mode: "ok" });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[reload-fired]");
    expect(larkCalls(env)).toHaveLength(1);
    expect(larkCalls(env)[0]).toContain("/reload --source scheduler");
    expect(readFileSync(env.markerPath, "utf8")).toContain("source=scheduler");
  });

  test("busy sessions skip without consuming the claim", async () => {
    const env = makeEnvironment({ busySessions: 2 });

    const run = await runSafeReload(env, { mode: "ok" });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[busy-skip] count=2");
    expect(larkCalls(env)).toHaveLength(0);
    expect(existsSync(env.markerPath)).toBe(false);
  });

  test("a fresh marker dedups the tick under the default window", async () => {
    const env = makeEnvironment();
    writeFileSync(env.markerPath, "claimed_at=1 source=scheduler\n");

    const run = await runSafeReload(env, { mode: "ok" });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[dedup-skip]");
    expect(larkCalls(env)).toHaveLength(0);
  });

  test("an aged-out marker lets the next daily reload through", async () => {
    const env = makeEnvironment();
    writeFileSync(env.markerPath, "claimed_at=1 source=scheduler\n");
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(env.markerPath, sevenHoursAgo, sevenHoursAgo);

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

  test("an unrecognized ok envelope after delivery retains the claim and is never retried", async () => {
    const env = makeEnvironment();

    const ambiguous = await runSafeReload(env, { mode: "shape-drift" });

    expect(ambiguous.code).toBe(2);
    expect(ambiguous.stderr).toContain("[dispatch-ambiguous]");
    expect(larkCalls(env)).toHaveLength(1);
    expect(existsSync(env.markerPath)).toBe(true);

    const nextTick = await runSafeReload(env, { mode: "ok" });

    expect(nextTick.stdout).toContain("[dedup-skip]");
    expect(larkCalls(env)).toHaveLength(1);
  });

  // localwatch calls with SM_RELOAD_DEDUP_WINDOW_SEC=0 to bypass dedup for a
  // confirmed incident. Even there, one ambiguous dispatch must not become two.
  test("an ambiguous dispatch is not re-sent within the same tick even with dedup disabled", async () => {
    const env = makeEnvironment();

    const first = await runSafeReload(env, { mode: "exit-nonzero", dedupWindowSec: 0 });
    expect(first.code).toBe(2);
    expect(larkCalls(env)).toHaveLength(1);

    // The emergency caller keeps its own cooldown; with the window reopened the
    // claim is spent and a genuinely later tick may fire again.
    const second = await runSafeReload(env, { mode: "ok", dedupWindowSec: 0 });
    expect(second.stdout).toContain("[reload-fired]");
    expect(larkCalls(env)).toHaveLength(2);
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
  claimLockPath: string;
  callsPath: string;
  larkCliPath: string;
  markerPath: string;
  root: string;
  scriptPath: string;
};

/**
 * Builds a throwaway repo whose scripts/ holds the live safe-reload.sh, so the
 * assertions run the real script text while .env.local, the sqlite db, the marker
 * and lark-cli all point at the temp tree.
 */
function makeEnvironment(options: { busySessions?: number } = {}): Environment {
  const root = mkdtempSync(join(tmpdir(), "sm-safe-reload-"));
  tempDirs.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "data"));

  const scriptPath = join(root, "scripts", "safe-reload.sh");
  writeFileSync(scriptPath, readFileSync(SCRIPT_PATH, "utf8"), { mode: 0o755 });

  const dbPath = join(root, "data", "supermatrix.db");
  seedSessions(dbPath, options.busySessions ?? 0);

  const callsPath = join(root, "lark-calls.log");
  const larkCliPath = join(root, "fake-lark-cli");
  writeFileSync(larkCliPath, fakeLarkCli(callsPath), { mode: 0o755 });

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
    callsPath,
    claimLockPath: join(root, "data", ".last-reload-fired.claim.lock"),
    larkCliPath,
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
  shape-drift)
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
  options: { mode: LarkMode; dedupWindowSec?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("zsh", [env.scriptPath], {
      env: {
        ...process.env,
        FAKE_LARK_MODE: options.mode,
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
