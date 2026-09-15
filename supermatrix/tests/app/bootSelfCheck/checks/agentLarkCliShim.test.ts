import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentLarkCliShimCheck } from "../../../../src/app/bootSelfCheck/checks/agentLarkCliShim.ts";
import type { BootCheckContext } from "../../../../src/app/bootSelfCheck/types.ts";

describe("agent-lark-cli-shim check", () => {
  let tempDir: string;
  let shimPath: string;
  let installPath: string;
  let realCliPath: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "sm-agent-lark-shim-"));
    shimPath = path.join(tempDir, "repo/scripts/shims/lark-cli");
    installPath = path.join(tempDir, "home/.local/bin/lark-cli");
    realCliPath = path.join(tempDir, "repo/node_modules/.bin/lark-cli");
    makeExecutable(shimPath);
    makeExecutable(realCliPath);
    mkdirSync(path.dirname(installPath), { recursive: true });
    symlinkSync(shimPath, installPath);
    env = { PATH: `/usr/bin${path.delimiter}${path.dirname(installPath)}` };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("validates the installation and configures the child environment in execute mode", async () => {
    const check = createAgentLarkCliShimCheck({ shimPath, installPath, env });

    const result = await check.run(makeContext(realCliPath), "execute");

    expect(result.status).toBe("ok");
    expect(env.PATH?.split(path.delimiter)).toEqual([path.dirname(installPath), "/usr/bin"]);
    expect(env.SM_REAL_LARK_CLI_PATH).toBe(realCliPath);
  });

  it("reports ok without mutation when observe mode sees the configured environment", async () => {
    env.PATH = `${path.dirname(installPath)}${path.delimiter}/usr/bin`;
    env.SM_REAL_LARK_CLI_PATH = realCliPath;
    const before = { ...env };
    const check = createAgentLarkCliShimCheck({ shimPath, installPath, env });

    const result = await check.run(makeContext(realCliPath), "observe");

    expect(result.status).toBe("ok");
    expect(env).toEqual(before);
  });

  it("reports environment drift without repairing it in observe mode", async () => {
    const before = { ...env };
    const check = createAgentLarkCliShimCheck({ shimPath, installPath, env });

    const result = await check.run(makeContext(realCliPath), "observe");

    expect(result.status).toBe("fail");
    if (result.status === "fail") expect(result.message).toContain("shim directory is not first on PATH");
    expect(env).toEqual(before);
  });

  it.each([
    {
      name: "source shim is missing",
      arrange: () => rmSync(shimPath),
      message: "source shim is not executable",
    },
    {
      name: "installed shim is missing",
      arrange: () => rmSync(installPath),
      message: "installed shim is not a symlink",
    },
    {
      name: "installed shim targets a stale file",
      arrange: () => {
        rmSync(installPath);
        const stalePath = path.join(tempDir, "stale-shim");
        makeExecutable(stalePath);
        symlinkSync(stalePath, installPath);
      },
      message: "installed shim does not target the repository shim",
    },
    {
      name: "real CLI is missing",
      arrange: () => rmSync(realCliPath),
      message: "real lark-cli is not executable",
    },
    {
      name: "real CLI resolves to the source shim",
      arrange: () => {
        rmSync(realCliPath);
        symlinkSync(shimPath, realCliPath);
      },
      message: "real lark-cli resolves to the shim",
    },
  ])("fails when $name", async ({ arrange, message }) => {
    arrange();
    const check = createAgentLarkCliShimCheck({ shimPath, installPath, env });

    const result = await check.run(makeContext(realCliPath), "execute");

    expect(result.status).toBe("fail");
    if (result.status === "fail") expect(result.message).toContain(message);
  });
});

function makeExecutable(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(filePath, 0o755);
}

function makeContext(larkCliPath: string): BootCheckContext {
  return {
    cfg: {
      larkCliPath,
      dbPath: "/tmp/sm.db",
      workspaceRoot: "/tmp/workspaces",
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => ({} as never),
    } as never,
    processLister: {
      list: async () => [],
      killAll: async () => [],
      getCommand: async () => null,
      getProcessInfo: async () => null,
    },
  };
}
