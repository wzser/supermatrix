import { asTimestamp } from "../../../domain/ids.ts";
import type { Session } from "../../../domain/session.ts";
import type { BootCheck } from "../types.ts";

const BACKEND_PROCESS_RE = /(?:^|\s|\/)(claude|codex|kimi)(?:\s|$)/;

export const reconcileBackendProcessesCheck: BootCheck = {
  name: "reconcile-backend-processes",
  phases: ["post-wiring", "runtime"],
  async run(ctx, mode) {
    if (!ctx.store) {
      return {
        name: "reconcile-backend-processes",
        status: "warn",
        message: "上下文中无 store — 已跳过",
      };
    }
    const store = ctx.store;

    const allCandidates = await ctx.processLister.list({
      cmdPattern: BACKEND_PROCESS_RE,
      cwdPrefix: ctx.cfg.workspaceRoot,
      ppid: 1,
    });

    // Kimi runs a single shared "kimi acp" process. The live ACP owned by KimiBackend
    // must not be treated as an orphan. Split candidates into:
    //   - kimiAcpOrphans: cmd contains both "kimi" and "acp", pid != livePid
    //   - non-kimi orphans: cmd does NOT contain "kimi" (claude / codex)
    //   - everything else (kimi without acp, or kimi acp matching live pid) -> excluded
    const liveKimiPid = ctx.getKimiAcpPid?.() ?? null;
    const kimiAcpOrphans = allCandidates.filter(
      (o) => o.cmd.includes("kimi") && o.cmd.includes("acp") && o.pid !== liveKimiPid,
    );
    const nonKimiOrphans = allCandidates.filter((o) => !o.cmd.includes("kimi"));
    const orphans = [...kimiAcpOrphans, ...nonKimiOrphans];

    const runningRuns = await store.findRunningMessageRuns();

    if (mode === "observe") {
      // In observe mode, only report runs whose session is NOT busy.
      // A run is legitimately running if its session is busy (actively processing).
      const hangingRuns: typeof runningRuns = [];
      for (const run of runningRuns) {
        const session = await store.findSessionById(run.sessionId);
        if (!session || session.status !== "busy") hangingRuns.push(run);
      }

      if (orphans.length === 0 && hangingRuns.length === 0) {
        return { name: "reconcile-backend-processes", status: "ok" };
      }
      return {
        name: "reconcile-backend-processes",
        status: "info",
        message: `当前状态：${orphans.length} 个孤儿 backend、${hangingRuns.length} 个挂起的 run`,
        detail: {
          wouldKill: orphans.map((o) => o.pid),
          wouldTimeout: hangingRuns.map((r) => r.id),
        },
      };
    }

    if (orphans.length === 0 && runningRuns.length === 0) {
      return { name: "reconcile-backend-processes", status: "ok" };
    }

    // execute mode (boot): every running run belongs to a previous console
    // process. A claude/codex backend that console spawned is now an unowned
    // orphan (ppid=1) — the current console has no handle to its stdout stream
    // and there is no reattach path, so the run can never reach a terminal
    // state on its own. Timing it out is the only correct verdict; otherwise
    // the dispatcher's per-session gate rejects every future prompt with
    // "prior run still marked running" and the session is dead forever.
    //
    // kimi is the lone exception: its backend is a single shared ACP process
    // that survives console restarts, and the new console reconnects to it.
    // A kimi run backed by a live ACP is preserved. (At a real boot the ACP is
    // lazy-spawned, so getKimiAcpPid() returns null and even kimi runs time
    // out — which is also correct. The keep path matters only when something
    // already reconnected the ACP before this check runs.)
    //
    // All orphan processes are killed; the kimi-aware filtering above already
    // excludes the live ACP from `orphans`.
    const now = asTimestamp(Date.now());
    const reservedPids = new Set<number>();
    const actions: Array<{ runId: string; reason: string }> = [];
    const keptRunning: Array<{ runId: string; pid: number; reason: string }> = [];
    for (const run of runningRuns) {
      const session = await store.findSessionById(run.sessionId);
      const kimiPid = liveKimiAcpPidForSession(session, liveKimiPid);
      if (session && kimiPid !== null && !reservedPids.has(kimiPid)) {
        reservedPids.add(kimiPid);
        if (session.status !== "busy") {
          await store.updateSessionStatus(session.id, "busy", now);
        }
        keptRunning.push({
          runId: run.id,
          pid: kimiPid,
          reason: "live kimi ACP process matched session backend",
        });
        continue;
      }
      const reason = "boot reconcile: backend orphaned by console restart";
      await store.markMessageRunTimeout(run.id, reason, now);
      actions.push({ runId: run.id, reason });
    }

    const pidsToKill = orphans
      .filter((o) => !reservedPids.has(o.pid))
      .map((o) => o.pid);
    if (pidsToKill.length > 0) await ctx.processLister.killAll(pidsToKill);

    return {
      name: "reconcile-backend-processes",
      status: "warn",
      message: `已保留 ${keptRunning.length} 个存活 kimi run、清理 ${pidsToKill.length} 个孤儿、标记 ${actions.length} 个 run 超时`,
      detail: { keptRunning, killed: pidsToKill, actions },
    };
  },
};

// A backend process orphaned by a previous console (ppid=1) cannot be adopted
// by the current console for claude/codex — their stdout stream died with the
// process that spawned them. kimi is the exception: the backend is a single
// shared ACP process that survives console restarts and the new console
// reconnects to it. So only a kimi session with a live ACP yields a pid worth
// preserving the run for; every other backend returns null (run gets timed out).
function liveKimiAcpPidForSession(
  session: Session | null,
  liveKimiPid: number | null,
): number | null {
  if (!session || session.backend !== "kimi") return null;
  return liveKimiPid;
}
