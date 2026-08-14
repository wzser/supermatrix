import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WRAPPER = join(process.cwd(), "src/scripts/safe-reload-watch.sh");

type RunOptions = {
  stdout?: string;
  stderr?: string;
  rc?: number;
};

function runWrapper(options: RunOptions) {
  const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-safe-reload-watch-"));
  const binDir = join(tmpDir, "bin");
  const curlLog = join(tmpDir, "curl.log");
  const safeReload = join(tmpDir, "safe-reload.sh");
  try {
    mkdirSync(binDir);
    writeExecutable(
      safeReload,
      `#!/bin/zsh
if [[ -n "\${STUB_STDOUT:-}" ]]; then
  printf "%s" "$STUB_STDOUT"
fi
if [[ -n "\${STUB_STDERR:-}" ]]; then
  printf "%s" "$STUB_STDERR" >&2
fi
exit "\${STUB_RC:-0}"
`,
    );
    writeExecutable(
      join(binDir, "curl"),
      `#!/bin/sh
for arg in "$@"; do
  printf '<%s>' "$arg" >> "$CURL_LOG"
done
printf '\\n' >> "$CURL_LOG"
exit 0
`,
    );
    writeExecutable(
      join(binDir, "sqlite3"),
      `#!/bin/sh
printf '1\\n'
exit 0
`,
    );

    const result = spawnSync("zsh", [WRAPPER], {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: {
        ...process.env,
        CURL_LOG: curlLog,
        NOTIFY_URL: "http://notify.test",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        SAFE_RELOAD: safeReload,
        SCHEDULER_TASK_URL: "http://scheduler.test/tasks/safe-reload-watch",
        STUB_RC: String(options.rc ?? 0),
        STUB_STDERR: options.stderr ?? "",
        STUB_STDOUT: options.stdout ?? "",
      },
    });

    return {
      curlCalls: existsSync(curlLog) ? readFileSync(curlLog, "utf-8").trim().split("\n").filter(Boolean) : [],
      stderr: result.stderr,
      status: result.status,
      stdout: result.stdout,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function writeExecutable(path: string, content: string) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function expectNoSchedulerPatch(curlCalls: string[]) {
  expect(curlCalls.some((call) => call.includes("<-X><PATCH>"))).toBe(false);
}

describe("safe-reload-watch wrapper", () => {
  it("treats busy-skip rc0 as a successful no-op without notify or scheduler disable", () => {
    const result = runWrapper({ stdout: "[busy-skip] count=2\n" });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("[busy-skip] count=2\n");
    expect(result.curlCalls).toEqual([]);
  });

  it("treats dedup-skip rc0 as a successful no-op without notify or scheduler disable", () => {
    const result = runWrapper({ stdout: "[dedup-skip] age=34s window=21600s\n" });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("[dedup-skip] age=34s window=21600s\n");
    expect(result.curlCalls).toEqual([]);
  });

  it("notifies and disables the scheduler task only for reload-fired rc0", () => {
    const result = runWrapper({ stdout: "all idle\n[reload-fired]\nreload triggered\n" });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("all idle\n[reload-fired]\nreload triggered\n");
    expect(result.curlCalls).toHaveLength(2);
    expect(result.curlCalls[0]).toContain("<-X><POST>");
    expect(result.curlCalls[0]).toContain("<http://notify.test>");
    expect(result.curlCalls[1]).toContain("<-X><PATCH>");
    expect(result.curlCalls[1]).toContain("<http://scheduler.test/tasks/safe-reload-watch>");
    expect(result.curlCalls[1]).toContain('<{"enabled":false}>');
  });

  it("fails closed on rc0 output without a known exact marker line", () => {
    const result = runWrapper({ stdout: "all idle [reload-fired] but marker is not its own line\n" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("all idle [reload-fired] but marker is not its own line\n");
    expectNoSchedulerPatch(result.curlCalls);
  });

  it("keeps nonzero safe-reload errors as warning notifications with the original rc", () => {
    const result = runWrapper({ rc: 2, stderr: "missing runtime config\n" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("missing runtime config\n");
    expect(result.curlCalls).toHaveLength(1);
    expect(result.curlCalls[0]).toContain("<-X><POST>");
    expect(result.curlCalls[0]).toContain("safe-reload watch error");
    expectNoSchedulerPatch(result.curlCalls);
  });
});
