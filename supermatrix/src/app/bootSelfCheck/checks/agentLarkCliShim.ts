import { access, lstat, realpath, constants as fsConst } from "node:fs/promises";
import path from "node:path";
import type { BootCheck, CheckResult } from "../types.ts";

export type AgentLarkCliShimCheckOptions = {
  shimPath: string;
  installPath: string;
  env?: Record<string, string | undefined>;
};

export function createAgentLarkCliShimCheck(
  options: AgentLarkCliShimCheckOptions,
): BootCheck {
  const env = options.env ?? process.env;

  return {
    name: "agent-lark-cli-shim",
    phases: ["pre-wiring", "runtime"],
    async run(ctx, mode): Promise<CheckResult> {
      const validation = await validatePaths(
        options.shimPath,
        options.installPath,
        ctx.cfg.larkCliPath,
      );
      if (validation) {
        return { name: "agent-lark-cli-shim", status: "fail", message: validation };
      }

      const installDir = path.dirname(options.installPath);
      if (mode === "observe") {
        const firstPath = (env.PATH ?? "").split(path.delimiter)[0];
        if (firstPath !== installDir) {
          return {
            name: "agent-lark-cli-shim",
            status: "fail",
            message: `shim directory is not first on PATH: expected ${installDir}, got ${firstPath || "<empty>"}`,
          };
        }
        if (env.SM_REAL_LARK_CLI_PATH !== ctx.cfg.larkCliPath) {
          return {
            name: "agent-lark-cli-shim",
            status: "fail",
            message: `SM_REAL_LARK_CLI_PATH drift: expected ${ctx.cfg.larkCliPath}, got ${env.SM_REAL_LARK_CLI_PATH ?? "<empty>"}`,
          };
        }
      } else {
        const remaining = (env.PATH ?? "")
          .split(path.delimiter)
          .filter((entry) => entry && entry !== installDir);
        env.PATH = [installDir, ...remaining].join(path.delimiter);
        env.SM_REAL_LARK_CLI_PATH = ctx.cfg.larkCliPath;
      }

      return {
        name: "agent-lark-cli-shim",
        status: "ok",
        detail: {
          shimPath: options.shimPath,
          installPath: options.installPath,
          realCliPath: ctx.cfg.larkCliPath,
        },
      };
    },
  };
}

async function validatePaths(
  shimPath: string,
  installPath: string,
  realCliPath: string,
): Promise<string | null> {
  if (!await isExecutable(shimPath)) {
    return `source shim is not executable: ${shimPath}`;
  }

  try {
    const installed = await lstat(installPath);
    if (!installed.isSymbolicLink()) {
      return `installed shim is not a symlink: ${installPath}`;
    }
  } catch {
    return `installed shim is not a symlink: ${installPath}`;
  }

  let sourceRealPath: string;
  let installedRealPath: string;
  try {
    [sourceRealPath, installedRealPath] = await Promise.all([
      realpath(shimPath),
      realpath(installPath),
    ]);
  } catch {
    return `installed shim does not target the repository shim: ${installPath}`;
  }
  if (sourceRealPath !== installedRealPath) {
    return `installed shim does not target the repository shim: ${installPath}`;
  }

  if (!await isExecutable(realCliPath)) {
    return `real lark-cli is not executable: ${realCliPath}`;
  }

  let realCliRealPath: string;
  try {
    realCliRealPath = await realpath(realCliPath);
  } catch {
    return `real lark-cli is not executable: ${realCliPath}`;
  }
  if (realCliRealPath === sourceRealPath) {
    return `real lark-cli resolves to the shim: ${realCliPath}`;
  }

  return null;
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConst.X_OK);
    return true;
  } catch {
    return false;
  }
}
