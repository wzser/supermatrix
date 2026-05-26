import { access, mkdir, constants as fsConst } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import type { BootCheck, CheckResult, BootCheckContext } from "../types.ts";

// NOTE: This check does NOT probe Lark API reachability. If the Lark API is
// unreachable we cannot notify the operator through Lark anyway, so a network
// probe here has no useful delivery channel today. A future out-of-band POST
// notification channel (separate from Lark) will backstop this gap. Until
// then, operators find this failure via the dev-loop stderr log.
export const localDepsCheck: BootCheck = {
  name: "local-deps",
  phases: ["pre-wiring", "runtime"],
  async run(ctx, _mode): Promise<CheckResult> {
    const problems: string[] = [];

    // 1. lark-cli binary + --version probe (with PATH fallback auto-repair)
    const larkResult = await probeLarkCli(ctx);
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

type LarkProbe =
  | { kind: "ok" }
  | { kind: "repaired"; primaryPath: string; fallbackPath: string }
  | { kind: "fail"; message: string };

async function probeLarkCli(ctx: BootCheckContext): Promise<LarkProbe> {
  const primary = ctx.cfg.larkCliPath;
  if (await canExec(primary)) return { kind: "ok" };
  // Fallback: try PATH lookup via `which`
  const fallback = await whichBinary("lark-cli");
  if (fallback && await canExec(fallback)) {
    return { kind: "repaired", primaryPath: primary, fallbackPath: fallback };
  }
  return { kind: "fail", message: `lark-cli 不可用：主路径 ${primary}，且 PATH 中也没有可用 fallback` };
}

async function canExec(binPath: string): Promise<boolean> {
  try {
    await access(binPath, fsConst.X_OK);
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    const child = execFile(binPath, ["--version"], { timeout: 2000 }, (err) => {
      resolve(!err);
    });
    child.on("error", () => resolve(false));
  });
}

async function whichBinary(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("/usr/bin/which", [name], { timeout: 1000 }, (err, stdout) => {
      if (err) return resolve(null);
      const p = stdout.toString().trim();
      resolve(p.length > 0 ? p : null);
    });
  });
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
