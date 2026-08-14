import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { BootCheck } from "../types.ts";

const MAIN_CMD_PATTERN = /tsx .*src\/cli\/main\.ts/;

export const dualInstanceCheck: BootCheck = {
  name: "dual-instance",
  phases: ["pre-wiring"],
  async run(ctx) {
    const pidFile = path.join(path.dirname(ctx.cfg.dbPath), ".bootstrap.pid");

    // 1. Stale PID file handling
    if (existsSync(pidFile)) {
      const raw = readFileSync(pidFile, "utf-8").trim();
      const oldPid = parseInt(raw, 10);
      if (Number.isFinite(oldPid)) {
        const oldCmd = await ctx.processLister.getCommand(oldPid);
        if (oldCmd && MAIN_CMD_PATTERN.test(oldCmd)) {
          return {
            name: "dual-instance",
            status: "fail",
            message: `检测到另一个 bootstrap 进程存活 (pid=${oldPid})：${oldCmd}`,
          };
        }
        // Stale: old pid dead or different command — fall through and overwrite.
      }
    }

    // 2. ps fallback scan — catches the case where PID file got wiped but
    //    another bootstrap is still running. Run BEFORE writing our own PID
    //    so a failure here doesn't leave a dead PID file behind.
    //
    // We exclude both process.pid (ourselves) and process.ppid (the tsx CLI
    // wrapper that spawned us — tsx runs main.ts via a child node process,
    // and both the wrapper and the child show up in ps matching the pattern).
    const others = await ctx.processLister.list({
      cmdPattern: MAIN_CMD_PATTERN,
    });
    const stillOthers = others.filter(
      (p) => p.pid !== process.pid && p.pid !== process.ppid,
    );
    if (stillOthers.length > 0) {
      return {
        name: "dual-instance",
        status: "fail",
        message: `检测到另一个 bootstrap 进程存活 (pid=${stillOthers[0]!.pid})：${stillOthers[0]!.cmd}`,
      };
    }

    // 3. Write our PID — only after both tiers pass.
    writeFileSync(pidFile, String(process.pid), "utf-8");

    return { name: "dual-instance", status: "ok" };
  },
};

/** Used by `gracefulStop` in `bootstrap.ts` to clean up the PID file. */
export function cleanupBootstrapPidFile(dbPath: string): void {
  const pidFile = path.join(path.dirname(dbPath), ".bootstrap.pid");
  try {
    if (existsSync(pidFile)) unlinkSync(pidFile);
  } catch {
    // ignore — best-effort cleanup
  }
}
