import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const ROOT = join(import.meta.dirname, "..");

function run(args: string[], env: Record<string, string> = {}): string {
  return execFileSync("npx", ["tsx", CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, WATCHDOG_DISABLE_SYNC: "1", WATCHDOG_NOTIFY_DISABLED: "1", ...env },
    encoding: "utf-8",
    timeout: 10000,
  }).trim();
}

describe("CLI", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "watchdog-test-"));
    dbPath = join(tmpDir, "test.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds an issue and lists it", () => {
    const addOutput = run(
      ["add", "--title", "Fix bug", "--source", "user", "--description", "Something broken", "--verification", "npm test"],
      { WATCHDOG_DB_PATH: dbPath },
    );
    expect(addOutput).toContain("Fix bug");

    const listOutput = run(["list"], { WATCHDOG_DB_PATH: dbPath });
    expect(listOutput).toContain("Fix bug");
    expect(listOutput).toContain("open");
  });

  it("shows issue details with get", () => {
    const addOutput = run(
      ["add", "--title", "Test issue", "--source", "user", "--description", "desc", "--verification", "echo ok"],
      { WATCHDOG_DB_PATH: dbPath },
    );
    const id = JSON.parse(addOutput).id;

    const getOutput = run(["get", id], { WATCHDOG_DB_PATH: dbPath });
    const issue = JSON.parse(getOutput);
    expect(issue.title).toBe("Test issue");
  });

  it("transitions issue through statuses", () => {
    const addOutput = run(
      ["add", "--title", "Lifecycle test", "--source", "user", "--description", "d", "--verification", "echo ok"],
      { WATCHDOG_DB_PATH: dbPath },
    );
    const id = JSON.parse(addOutput).id;

    run(["start", id], { WATCHDOG_DB_PATH: dbPath });
    const started = JSON.parse(run(["get", id], { WATCHDOG_DB_PATH: dbPath }));
    expect(started.status).toBe("in_progress");

    run(["done", id, "--result", "Fixed it"], { WATCHDOG_DB_PATH: dbPath });
    const done = JSON.parse(run(["get", id], { WATCHDOG_DB_PATH: dbPath }));
    expect(done.status).toBe("done");
    expect(done.result).toBe("Fixed it");
  });

  it("verify command runs verification and reports success", () => {
    const addOutput = run(
      ["add", "--title", "Verify test", "--source", "user", "--description", "d", "--verification", "echo ok"],
      { WATCHDOG_DB_PATH: dbPath },
    );
    const id = JSON.parse(addOutput).id;

    const verifyOutput = run(["verify", id], { WATCHDOG_DB_PATH: dbPath });
    const result = JSON.parse(verifyOutput);
    expect(result.success).toBe(true);
    expect(result.output).toContain("ok");
  });

  it("verify command reports failure for bad command", () => {
    const addOutput = run(
      ["add", "--title", "Fail test", "--source", "user", "--description", "d", "--verification", "exit 1"],
      { WATCHDOG_DB_PATH: dbPath },
    );
    const id = JSON.parse(addOutput).id;

    let verifyOutput: string;
    try {
      verifyOutput = run(["verify", id], { WATCHDOG_DB_PATH: dbPath });
    } catch (err: unknown) {
      verifyOutput = (err as { stdout?: string }).stdout?.trim() ?? "";
    }
    const result = JSON.parse(verifyOutput);
    expect(result.success).toBe(false);
  });

  it("verify command errors when no verification set", () => {
    const addOutput = run(
      ["add", "--title", "No verify", "--source", "user", "--description", "d"],
      { WATCHDOG_DB_PATH: dbPath },
    );
    const id = JSON.parse(addOutput).id;

    const verifyOutput = run(["verify", id], { WATCHDOG_DB_PATH: dbPath });
    const result = JSON.parse(verifyOutput);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No verification");
  });

  it("verify failure increments retry count", () => {
    const addOutput = run(
      ["add", "--title", "Retry CLI", "--source", "user", "--description", "d", "--verification", "exit 1"],
      { WATCHDOG_DB_PATH: dbPath },
    );
    const id = JSON.parse(addOutput).id;

    let verifyOutput: string;
    try {
      verifyOutput = run(["verify", id], { WATCHDOG_DB_PATH: dbPath });
    } catch (err: unknown) {
      verifyOutput = (err as { stdout?: string }).stdout?.trim() ?? "";
    }

    const getOutput = run(["get", id], { WATCHDOG_DB_PATH: dbPath });
    const issue = JSON.parse(getOutput);
    expect(issue.retryCount).toBe(1);
  });

  it("shows next open issue", () => {
    run(
      ["add", "--title", "First", "--source", "user", "--description", "d", "--verification", "v"],
      { WATCHDOG_DB_PATH: dbPath },
    );
    run(
      ["add", "--title", "Second", "--source", "user", "--description", "d", "--verification", "v"],
      { WATCHDOG_DB_PATH: dbPath },
    );

    const nextOutput = run(["next"], { WATCHDOG_DB_PATH: dbPath });
    expect(nextOutput).toContain("First");
  });
});
