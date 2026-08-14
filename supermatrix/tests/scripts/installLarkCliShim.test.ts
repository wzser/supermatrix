import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const installerPath = path.join(repoRoot, "scripts/install-lark-cli-shim.sh");
const repoShimPath = path.join(repoRoot, "scripts/shims/lark-cli");

describe("install-lark-cli-shim", () => {
  let tempDir: string;
  let installPath: string;
  let realCliPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sm-install-lark-shim-"));
    installPath = path.join(tempDir, "bin/lark-cli");
    realCliPath = path.join(tempDir, "real-lark-cli");
    writeFileSync(realCliPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("installs the global path as a symlink to the repository shim", () => {
    const result = runInstaller(installPath, realCliPath);

    expect(result.status).toBe(0);
    expect(lstatSync(installPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(installPath)).toBe(realpathSync(repoShimPath));
  });

  it("atomically replaces an existing symlink", () => {
    mkdirSync(path.dirname(installPath), { recursive: true });
    const staleTarget = path.join(tempDir, "stale-lark-cli");
    writeFileSync(staleTarget, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    symlinkSync(staleTarget, installPath);

    const result = runInstaller(installPath, realCliPath);

    expect(result.status).toBe(0);
    expect(realpathSync(installPath)).toBe(realpathSync(repoShimPath));
    expect(readlinkSync(installPath)).toBe(repoShimPath);
  });

  it("refuses to overwrite a regular file", () => {
    mkdirSync(path.dirname(installPath), { recursive: true });
    writeFileSync(installPath, "operator-owned\n", "utf8");
    chmodSync(installPath, 0o755);

    const result = runInstaller(installPath, realCliPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing to replace non-symlink");
    expect(readFileSync(installPath, "utf8")).toBe("operator-owned\n");
  });

  it("fails before installation when the real CLI is not executable", () => {
    chmodSync(realCliPath, 0o644);

    const result = runInstaller(installPath, realCliPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("real lark-cli is not executable");
    expect(() => lstatSync(installPath)).toThrow();
  });
});

function runInstaller(installPath: string, realCliPath: string) {
  return spawnSync(installerPath, [], {
    encoding: "utf8",
    env: {
      ...process.env,
      SM_LARK_CLI_SHIM_INSTALL_PATH: installPath,
      SM_REAL_LARK_CLI_PATH: realCliPath,
    },
  });
}
