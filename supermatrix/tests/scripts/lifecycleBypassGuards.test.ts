import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("legacy lifecycle bypass guards", () => {
  test("dev-loop is retired and cannot supervise or signal SuperMatrix", async () => {
    const result = await runScript("zsh", [resolve(REPO_ROOT, "scripts/dev-loop.sh")]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("retired");
    expect(result.stderr).toContain("codexroot maintenance gate");
  });

  test("port repair reports the exact holder but never kills it", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "sm-port-guard-"));
    tempDirs.push(binDir);
    const killCalls = join(binDir, "kill-calls.log");
    writeFileSync(join(binDir, "lsof"), "#!/bin/bash\nprintf '%s\\n' 4242\n");
    writeFileSync(join(binDir, "kill"), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(killCalls)}\n`);
    chmodSync(join(binDir, "lsof"), 0o755);
    chmodSync(join(binDir, "kill"), 0o755);

    const result = await runScript("bash", [resolve(REPO_ROOT, "scripts/repair/fix-port-in-use.sh")], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.code).toBe(3);
    expect(result.stderr).toContain("Port 3501 occupied by PIDs: 4242");
    expect(result.stderr).toContain("codexroot maintenance gate");
    expect(() => readFileSync(killCalls, "utf8")).toThrow();
  });

  test.each(["install.sh", "uninstall.sh", "supermatrix-launch.sh"])(
    "legacy direct launchd entry %s is retired",
    async (name) => {
      const result = await runScript("zsh", [resolve(REPO_ROOT, "scripts/launchd", name)]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("retired");
    },
  );

  test("terminal launcher monitors only this repository's exact localwatch identity", () => {
    const source = readFileSync(
      resolve(REPO_ROOT, "scripts/launchd/terminal-launcher.sh"),
      "utf8",
    );

    expect(source).not.toContain("pgrep -f 'localwatch\\.sh'");
    expect(source).toContain('source "$IDENTITY_HELPER"');
    expect(source).toContain(
      'localwatch_command_matches_script "$command_line" "$LOCALWATCH_SCRIPT"',
    );
    expect(source).toContain('[[ "$process_cwd" == "$REPO_DIR" ]]');
  });
});

async function runScript(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { env, timeout: 5_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (typeof failure.code !== "number") throw error;
    return { code: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}
