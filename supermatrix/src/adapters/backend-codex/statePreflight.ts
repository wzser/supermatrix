import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session } from "../../domain/session.ts";
import type { RunInput } from "../../ports/AgentBackend.ts";

export type CodexStatePreflightResult = {
  input: RunInput;
  archivedThreadIds: string[];
  skippedResumeId: string | null;
};

type ThreadRow = {
  id: string;
  rollout_path: string;
};

export function defaultCodexStateDbPath(): string {
  return join(homedir(), ".codex", "state_5.sqlite");
}

export function preflightCodexState(
  input: RunInput,
  stateDbPath: string | null | undefined = defaultCodexStateDbPath(),
): CodexStatePreflightResult {
  if (input.answerOnly || !stateDbPath || !existsSync(stateDbPath)) {
    return { input, archivedThreadIds: [], skippedResumeId: null };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(stateDbPath, { timeout: 1000 });
    const archivedThreadIds: string[] = [];
    let nextInput = input;
    let skippedResumeId: string | null = null;

    const resumeId = input.session.backendSessionId;
    if (resumeId) {
      const resumeThread = getUnarchivedThreadById(db, resumeId);
      if (!resumeThread || !existsSync(resumeThread.rollout_path)) {
        if (resumeThread) archiveThread(db, resumeThread.id);
        if (resumeThread) archivedThreadIds.push(resumeThread.id);
        nextInput = withBackendSessionId(nextInput, null);
        skippedResumeId = resumeId;
      }
    }

    for (let i = 0; i < 100; i += 1) {
      const latest = getLatestUnarchivedThreadForCwd(db, input.session.workdir);
      if (!latest || existsSync(latest.rollout_path)) break;
      archiveThread(db, latest.id);
      archivedThreadIds.push(latest.id);
    }

    return { input: nextInput, archivedThreadIds, skippedResumeId };
  } catch {
    return { input, archivedThreadIds: [], skippedResumeId: null };
  } finally {
    db?.close();
  }
}

function withBackendSessionId(input: RunInput, backendSessionId: string | null): RunInput {
  const session: Session = { ...input.session, backendSessionId };
  return { ...input, session };
}

function getUnarchivedThreadById(db: Database.Database, id: string): ThreadRow | undefined {
  return db.prepare(`
    SELECT id, rollout_path
    FROM threads
    WHERE id = ? AND archived = 0
    LIMIT 1
  `).get(id) as ThreadRow | undefined;
}

function getLatestUnarchivedThreadForCwd(db: Database.Database, cwd: string): ThreadRow | undefined {
  return db.prepare(`
    SELECT id, rollout_path
    FROM threads
    WHERE archived = 0 AND cwd = ?
    ORDER BY
      COALESCE(recency_at_ms, updated_at_ms, created_at_ms, 0) DESC,
      id DESC
    LIMIT 1
  `).get(cwd) as ThreadRow | undefined;
}

function archiveThread(db: Database.Database, id: string): void {
  db.prepare(`
    UPDATE threads
    SET archived = 1, archived_at = ?
    WHERE id = ? AND archived = 0
  `).run(Math.floor(Date.now() / 1000), id);
}
