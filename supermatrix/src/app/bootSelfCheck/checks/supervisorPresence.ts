import type { BootCheck } from "../types.ts";

const MAX_WALK_DEPTH = 5;
const DEV_LOOP_RE = /dev-loop\.sh/;
const LOCALWATCH_RE = /localwatch\.sh/;
const PM2_RE = /\bPM2\b/i;

export const supervisorPresenceCheck: BootCheck = {
  name: "supervisor-presence",
  phases: ["pre-wiring", "runtime"],
  async run(ctx) {
    // Test seam: allow overriding the starting PPID in tests.
    const startPpid =
      (ctx as { __fakePpid?: number }).__fakePpid ?? process.ppid;

    let cursorPid: number | undefined = startPpid;
    let firstCmd: string | null = null;
    for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
      if (cursorPid === undefined || cursorPid <= 0) break;
      const info = await ctx.processLister.getProcessInfo(cursorPid);
      if (!info) break;
      if (depth === 0) firstCmd = info.cmd;
      if (DEV_LOOP_RE.test(info.cmd)) {
        return {
          name: "supervisor-presence",
          status: "ok",
          detail: { supervisor: "dev-loop", ancestorPid: info.pid, depth },
        };
      }
      if (LOCALWATCH_RE.test(info.cmd)) {
        return {
          name: "supervisor-presence",
          status: "ok",
          detail: { supervisor: "localwatch", ancestorPid: info.pid, depth },
        };
      }
      if (PM2_RE.test(info.cmd)) {
        return {
          name: "supervisor-presence",
          status: "ok",
          detail: { supervisor: "pm2", ancestorPid: info.pid, depth },
        };
      }
      cursorPid = info.ppid;
    }

    // Reached top (or depth limit) without finding a supervisor.
    if (cursorPid === 1) {
      // PPID chain terminated at launchd (init) on macOS. Ambiguous:
      // either a real launchd job or a reparented orphan.
      return {
        name: "supervisor-presence",
        status: "warn",
        message: `PPID=1 — 可能是 launchd 管理或已被 reparent（未验证）`,
        detail: { startPpid },
      };
    }
    if (firstCmd === null) {
      return {
        name: "supervisor-presence",
        status: "warn",
        message: `无法读取父进程命令 (pid=${startPpid})`,
      };
    }
    return {
      name: "supervisor-presence",
      status: "warn",
      message: `裸运行在 ${firstCmd.split(/\s+/)[0]} 下 — 崩溃后没有 supervisor 会自动重启`,
      detail: { firstParent: firstCmd, walkDepth: MAX_WALK_DEPTH },
    };
  },
};
