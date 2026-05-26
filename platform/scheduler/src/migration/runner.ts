import type { TaskStore } from "../db/taskStore.js";
import type { MigrationStore } from "./store.js";
import type { InboxPredicate } from "../spawn/predicate.js";
import { inboxPredicate, DECISION_TOKENS } from "../spawn/predicate.js";
import { inferSuggestedClass } from "./classifier.js";
import { renderMigrationProposalText } from "./proposalText.js";

export type MigrationSpawnResult =
  | { ok: true; childSessionId: string }
  | { ok: false; status?: number; error?: string };

export type MigrationSpawnParams = {
  target: string;
  from: string;
  prompt: string;
  verification_predicate: InboxPredicate;
};

export type MigrationRunnerDeps = {
  taskStore: TaskStore;
  migrationStore: MigrationStore;
  spawnFn: (params: MigrationSpawnParams) => Promise<MigrationSpawnResult>;
  sendUserDm?: (text: string) => Promise<void>;
  clock?: () => number;
};

export function createMigrationRunner(deps: MigrationRunnerDeps) {
  const now = () => (deps.clock ?? Date.now)();
  return {
    async sendNext(taskId: string, ownerSession: string): Promise<{ sent: boolean; reason?: string }> {
      if (deps.migrationStore.ownerHasPendingProposal(ownerSession)) {
        return { sent: false, reason: "owner has a pending proposal" };
      }
      const task = deps.taskStore.getTask(taskId);
      if (!task) return { sent: false, reason: "task not found" };
      if (task.class !== null) return { sent: false, reason: "already migrated" };

      const { suggestedClass, suggestedExpectedDurationMs } = inferSuggestedClass({
        executor: task.executor,
        config: task.config,
      });
      const laterCount = deps.migrationStore.countLaterForTask(taskId);
      const executorSummary =
        task.executor === "shell"
          ? `shell: ${String((task.config as { command?: string }).command ?? "").slice(0, 200)}`
          : `http: ${(task.config as { method?: string }).method ?? "POST"} ${String((task.config as { url?: string }).url ?? "").slice(0, 200)}`;
      const prompt = renderMigrationProposalText({
        taskName: task.name,
        taskCron: task.cron,
        suggestedClass,
        suggestedExpectedDurationMs,
        executorSummary,
        laterCount,
      });

      let result: MigrationSpawnResult;
      try {
        result = await deps.spawnFn({
          target: ownerSession,
          from: "scheduler",
          prompt,
          verification_predicate: inboxPredicate({
            sessionName: ownerSession,
            tokens: DECISION_TOKENS,
          }),
        });
      } catch (err) {
        return { sent: false, reason: `spawn threw: ${String(err)}` };
      }
      if (!result.ok) {
        // Terminal failure — owner unreachable (404) or SM error (5xx).
        // Write a default_applied REJECT proposal so scheduler stops re-proposing,
        // and userDM to surface the blockage. Transient network throws are handled above
        // (spawnFn throwing) and intentionally do NOT persist anything — next tick retries.
        const stubProposal = deps.migrationStore.scheduleProposal({
          taskId,
          ownerSession,
          childSessionId: null,
          spawnedAt: now(),
          suggestedClass,
          suggestedExpectedDurationMs,
        });
        deps.migrationStore.markDefaultApplied(stubProposal.id, "REJECT", now());
        const status = result.status ?? "err";
        if (deps.sendUserDm) {
          try {
            await deps.sendUserDm(
              `[scheduler migration] task "${task.name}" (${taskId}) — spawn to owner "${ownerSession}" failed status=${status}. Marked REJECT; migration paused. PATCH /tasks/${taskId} with a valid ownerSession to restart.`
            );
          } catch (err) {
            console.error(`migration unreachable-owner userDM failed for task ${taskId}:`, err);
          }
        }
        return { sent: false, reason: `spawn failed status=${status}` };
      }
      deps.migrationStore.scheduleProposal({
        taskId,
        ownerSession,
        childSessionId: result.childSessionId,
        spawnedAt: now(),
        suggestedClass,
        suggestedExpectedDurationMs,
      });
      return { sent: true };
    },
  };
}
