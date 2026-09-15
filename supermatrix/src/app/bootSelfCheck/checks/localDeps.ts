import { access, mkdir, constants as fsConst } from "node:fs/promises";
import { execFile, type ExecFileException } from "node:child_process";
import path from "node:path";
import type { BootCheck, CheckResult, BootCheckContext } from "../types.ts";

// NOTE: This check does NOT probe Lark API reachability. If the Lark API is
// unreachable we cannot notify the operator through Lark anyway, so a network
// probe here has no useful delivery channel today. A future out-of-band POST
// notification channel (separate from Lark) will backstop this gap. Until
// then, operators find this failure via the dev-loop stderr log.
const LARK_CLI_VERSION_TIMEOUT_MS = 5_000;

type ExecFileRunner = (
  file: string,
  args: string[],
  options: { timeout: number },
  callback: (error: ExecFileException | null) => void,
) => { on(event: "error", listener: () => void): unknown };

type LocalDepsProbeOptions = {
  execFileRunner?: ExecFileRunner;
  versionTimeoutMs?: number;
};

export function createLocalDepsCheck(options: LocalDepsProbeOptions = {}): BootCheck {
  const execFileRunner: ExecFileRunner = options.execFileRunner ?? ((file, args, execOptions, callback) =>
    execFile(file, args, execOptions, callback));
  const versionTimeoutMs = options.versionTimeoutMs ?? LARK_CLI_VERSION_TIMEOUT_MS;

  return {
    name: "local-deps",
    phases: ["pre-wiring", "runtime"],
    async run(ctx, _mode): Promise<CheckResult> {
      const problems: string[] = [];

      // 1. lark-cli binary + --version probe (with PATH fallback auto-repair)
      const larkResult = await probeLarkCli(ctx, execFileRunner, versionTimeoutMs);
      if (larkResult.kind === "fail") {
        problems.push(larkResult.message);
      } else if (larkResult.kind === "repaired") {
        // Mutate cfg in place — this is the documented side effect.
        ctx.cfg.larkCliPath = larkResult.fallbackPath;
      }

      // 2. DB directory writable (auto-mkdir)
      const dbDir = path.dirname(ctx.cfg.dbPath);
      const dbDirOk = await ensureWritableDir(dbDir);
      if (!dbDirOk) problems.push(`数据库目录不可写：${dbDir}`);

      // 3. Workspace root writable (auto-mkdir)
      const wsOk = await ensureWritableDir(ctx.cfg.workspaceRoot);
      if (!wsOk) problems.push(`workspace 根目录不可写：${ctx.cfg.workspaceRoot}`);

      if (problems.length > 0) {
        return { name: "local-deps", status: "fail", message: problems.join("; ") };
      }
      if (larkResult.kind === "repaired") {
        return {
          name: "local-deps",
          status: "warn",
          message: `主路径 lark-cli 不可用，已回退到 PATH 上的 ${larkResult.fallbackPath}`,
          detail: { primaryPath: larkResult.primaryPath, fallbackPath: larkResult.fallbackPath, repair: "path-fallback" },
        };
      }
      return { name: "local-deps", status: "ok" };
    },
  };
}

export const localDepsCheck: BootCheck = createLocalDepsCheck();

type LarkProbe =
  | { kind: "ok" }
  | { kind: "repaired"; primaryPath: string; fallbackPath: string }
  | { kind: "fail"; message: string };

async function probeLarkCli(
  ctx: BootCheckContext,
  execFileRunner: ExecFileRunner,
  versionTimeoutMs: number,
): Promise<LarkProbe> {
  const primary = ctx.cfg.larkCliPath;
  if (await canExec(primary, execFileRunner, versionTimeoutMs)) return { kind: "ok" };
  const fallback = await whichBinary("lark-cli");
  if (fallback && await canExec(fallback, execFileRunner, versionTimeoutMs)) {
    return { kind: "repaired", primaryPath: primary, fallbackPath: fallback };
  }
  return { kind: "fail", message: `lark-cli 不可用：主路径 ${primary}，且 PATH 中也没有可用 fallback` };
}

async function canExec(
  binPath: string,
  execFileRunner: ExecFileRunner,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await access(binPath, fsConst.X_OK);
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    const child = execFileRunner(binPath, ["--version"], { timeout: timeoutMs }, (err) => {
      resolve(!err);
    });
    child.on("error", () => resolve(false));
  });
}

async function whichBinary(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      await access(candidate, fsConst.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

async function ensureWritableDir(dir: string): Promise<boolean> {
  try {
    await access(dir, fsConst.W_OK);
    return true;
  } catch {}
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, fsConst.W_OK);
    return true;
  } catch {
    return false;
  }
}
