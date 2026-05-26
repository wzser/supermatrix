import type { Task } from "../db/taskStore.js";

export function resolveMigrationOwner(task: Task): string | null {
  if (task.ownerSession && task.ownerSession.length > 0) return task.ownerSession;
  if (task.createdBy && task.createdBy.length > 0 && task.createdBy !== "未知") {
    return task.createdBy;
  }
  return null;
}
