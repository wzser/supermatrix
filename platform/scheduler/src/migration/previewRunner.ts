import type { TaskStore } from "../db/taskStore.js";
import type { MigrationStore } from "./store.js";
import { inboxPredicate, DELIVERY_TOKENS } from "../spawn/predicate.js";
import { inferSuggestedClass } from "./classifier.js";
import { renderMigrationPreview } from "./previewText.js";
import type { MigrationSpawnResult, MigrationSpawnParams } from "./runner.js";

export async function sendPreviewIfNeeded(deps: {
  taskStore: TaskStore;
  migrationStore: MigrationStore;
  ownerSession: string;
  ownerTaskIds: string[];
  spawnFn: (params: MigrationSpawnParams) => Promise<MigrationSpawnResult>;
  clock?: () => number;
}): Promise<boolean> {
  if (deps.migrationStore.isPreviewSent(deps.ownerSession)) return false;

  const entries = deps.ownerTaskIds
    .map((id) => deps.taskStore.getTask(id))
    .filter((t): t is NonNullable<typeof t> => t !== undefined && t !== null)
    .map((t) => {
      const { suggestedClass } = inferSuggestedClass({ executor: t.executor, config: t.config });
      return { taskName: t.name, suggestedClass };
    });
  if (entries.length === 0) return false;

  const prompt = renderMigrationPreview(entries);
  let result: MigrationSpawnResult;
  try {
    result = await deps.spawnFn({
      target: deps.ownerSession,
      from: "scheduler",
      prompt,
      verification_predicate: inboxPredicate({
        sessionName: deps.ownerSession,
        tokens: DELIVERY_TOKENS,
        expectedWindowSec: 3600,
      }),
    });
  } catch {
    return false;
  }
  if (!result.ok) return false;

  deps.migrationStore.markPreviewSent(deps.ownerSession, (deps.clock ?? Date.now)());
  return true;
}
