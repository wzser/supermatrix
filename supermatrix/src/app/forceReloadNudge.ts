import { unlinkSync } from "node:fs";
import path from "node:path";

const NUDGE_FILE_NAME = ".force-reload-nudges.json";

export type ForceReloadNudgeCleanupResult = {
  removed: boolean;
};

export function forceReloadNudgePath(dbPath: string): string {
  return path.join(path.dirname(dbPath), NUDGE_FILE_NAME);
}

export function cleanupPendingForceReloadNudge(
  dbPath: string,
): ForceReloadNudgeCleanupResult {
  try {
    unlinkSync(forceReloadNudgePath(dbPath));
    return { removed: true };
  } catch {
    return { removed: false };
  }
}
