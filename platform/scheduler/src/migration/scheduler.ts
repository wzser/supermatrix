import type { TaskStore, Task, TaskRun } from "../db/taskStore.js";
import type { MigrationStore } from "./store.js";
import type { MigrationSpawnResult, MigrationSpawnParams } from "./runner.js";
import { createMigrationRunner } from "./runner.js";
import { sendPreviewIfNeeded } from "./previewRunner.js";
import { parseMigrationReply } from "./replyParser.js";
import { applyMigrationAction } from "./actionApplier.js";
import { maybeEscalateMigration } from "./escalation.js";
import { resolveMigrationOwner } from "./ownerResolve.js";

const DAY = 24 * 3600_000;
const TWENTY_FOUR_HOURS = DAY;
const SEVEN_DAYS = 7 * DAY;

export type MigrationTickDeps = {
  taskStore: TaskStore;
  migrationStore: MigrationStore;
  smBaseUrl: string;
  fetchImpl?: typeof fetch;
  spawnFn: (params: MigrationSpawnParams) => Promise<MigrationSpawnResult>;
  sendUserDm: (text: string) => Promise<void>;
  syncTask?: (task: Task, latestRun?: TaskRun) => Promise<void>;
  clock?: () => number;
};

export async function runMigrationTick(deps: MigrationTickDeps): Promise<void> {
  const now = (deps.clock ?? Date.now)();

  await processPendingReplies(deps, now);

  const legacy = listLegacyTasks(deps.taskStore);
  const byOwner = new Map<string, Task[]>();
  for (const t of legacy) {
    const owner = resolveMigrationOwner(t);
    if (!owner) {
      await handleNoOwner(deps, t, now);
      continue;
    }
    const list = byOwner.get(owner) ?? [];
    list.push(t);
    byOwner.set(owner, list);
  }

  const runner = createMigrationRunner({
    taskStore: deps.taskStore,
    migrationStore: deps.migrationStore,
    spawnFn: deps.spawnFn,
    sendUserDm: deps.sendUserDm,
    clock: deps.clock,
  });

  for (const [owner, tasks] of byOwner) {
    const previewed = await sendPreviewIfNeeded({
      taskStore: deps.taskStore,
      migrationStore: deps.migrationStore,
      ownerSession: owner,
      ownerTaskIds: tasks.map((t) => t.id),
      spawnFn: deps.spawnFn,
      clock: deps.clock,
    });
    if (previewed) continue;

    for (const task of tasks) {
      const latest = deps.migrationStore.latestForTask(task.id);
      if (!latest) {
        await runner.sendNext(task.id, owner);
        continue;
      }
      if (latest.status === "pending") continue;
      if (latest.replyAction === "LATER") {
        const anchor = latest.repliedAt ?? latest.defaultAppliedAt ?? latest.spawnedAt;
        if (now - anchor >= SEVEN_DAYS) {
          await runner.sendNext(task.id, owner);
        }
      }
    }
  }

  for (const t of legacy) {
    await maybeEscalateMigration({
      taskStore: deps.taskStore,
      migrationStore: deps.migrationStore,
      taskId: t.id,
      nowMs: now,
      sendUserDm: deps.sendUserDm,
    });
  }
}

async function processPendingReplies(deps: MigrationTickDeps, now: number): Promise<void> {
  const fetchFn = deps.fetchImpl ?? fetch;
  for (const p of deps.migrationStore.listPending()) {
    if (!p.childSessionId) continue;
    const url = `${deps.smBaseUrl}/api/sessions/${p.childSessionId}/result`;

    let res: Response;
    try {
      res = await fetchFn(url, { method: "GET", signal: AbortSignal.timeout(30_000) });
    } catch {
      if (now - p.spawnedAt > TWENTY_FOUR_HOURS) {
        deps.migrationStore.markDefaultApplied(p.id, "LATER", now);
      }
      continue;
    }
    if (res.status === 202) {
      if (now - p.spawnedAt > TWENTY_FOUR_HOURS) {
        deps.migrationStore.markDefaultApplied(p.id, "LATER", now);
      }
      continue;
    }
    if (res.status >= 500) {
      if (now - p.spawnedAt > TWENTY_FOUR_HOURS) {
        deps.migrationStore.markDefaultApplied(p.id, "LATER", now);
      }
      continue;
    }
    if (!res.ok) continue;

    let body: { status?: string; finalMessage?: string | null; errorMessage?: string | null };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      continue;
    }
    // SM async_kickoff result shape: { ok, status, childSessionId, finalMessage, errorMessage, ... }
    // status: "completed" | "failed" | "timeout" | "running"
    if (body.status === "running") {
      if (now - p.spawnedAt > TWENTY_FOUR_HOURS) {
        deps.migrationStore.markDefaultApplied(p.id, "LATER", now);
      }
      continue;
    }
    if (body.status === "failed" || body.status === "timeout") {
      deps.migrationStore.markDefaultApplied(p.id, "LATER", now);
      continue;
    }
    const finalMessage = typeof body.finalMessage === "string" ? body.finalMessage : "";
    if (!finalMessage) {
      if (now - p.spawnedAt > TWENTY_FOUR_HOURS) {
        deps.migrationStore.markDefaultApplied(p.id, "LATER", now);
      }
      continue;
    }
    const parsed = parseMigrationReply(finalMessage);
    if (!parsed) {
      if (now - p.spawnedAt > TWENTY_FOUR_HOURS) {
        deps.migrationStore.markDefaultApplied(p.id, "LATER", now);
      }
      continue;
    }

    deps.migrationStore.markReplied(p.id, parsed.action, finalMessage, now);
    const appliedResult = applyMigrationAction({
      taskStore: deps.taskStore,
      taskId: p.taskId,
      action: parsed.action,
      kv: parsed.kv,
      suggestedClass: p.suggestedClass,
      suggestedExpectedDurationMs: p.suggestedExpectedDurationMs,
      ownerSession: p.ownerSession,
    });
    if (appliedResult.applied && deps.syncTask) {
      const reloaded = deps.taskStore.getTask(p.taskId);
      if (reloaded) {
        try {
          await deps.syncTask(reloaded);
        } catch (err) {
          console.error(`migration syncTask error for task ${p.taskId}:`, err);
        }
      }
    }
    if (appliedResult.error) {
      try {
        await deps.sendUserDm(
          `migration proposal for task=${p.taskId} returned MODIFY with invalid input: ${appliedResult.error}. Raw reply: ${finalMessage.slice(0, 300)}`
        );
      } catch {}
    }
  }
}

const MISSING_OWNER_PLACEHOLDER = "__missing__";

async function handleNoOwner(deps: MigrationTickDeps, task: Task, nowMs: number): Promise<void> {
  const latest = deps.migrationStore.latestForTask(task.id);
  if (latest && latest.replyAction === "REJECT") return; // already alerted

  const proposal = deps.migrationStore.scheduleProposal({
    taskId: task.id,
    ownerSession: MISSING_OWNER_PLACEHOLDER,
    childSessionId: null,
    spawnedAt: nowMs,
    suggestedClass: "sync_job",
    suggestedExpectedDurationMs: 1_800_000,
  });
  deps.migrationStore.markDefaultApplied(proposal.id, "REJECT", nowMs);
  try {
    await deps.sendUserDm(
      `[scheduler migration] task "${task.name}" (${task.id}) has no owner_session AND no createdBy — cannot send migration proposal. PATCH /tasks/${task.id} with a valid ownerSession, then restart migration by creating a new task or leave as-is to run legacy path until disabled.`
    );
  } catch (err) {
    console.error(`no-owner userDM failed for task ${task.id}:`, err);
  }
}

function listLegacyTasks(taskStore: TaskStore): Task[] {
  return taskStore.listTasks().filter((t) => t.class === null && t.enabled);
}
