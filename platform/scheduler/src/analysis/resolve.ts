import type { Conflict } from "./conflicts.js";
import type { TaskStore, Task } from "../db/taskStore.js";

type SpawnToFn = (target: string, prompt: string) => Promise<string>;
type NotifyFn = (text: string) => Promise<void>;
type SyncFn = (task: Task) => void;
type ReregisterFn = (task: Task) => void;

type Logger = {
  info(obj: unknown, msg: string): void;
  warn(obj: unknown, msg: string): void;
  error(obj: unknown, msg: string): void;
};

export type ResolveDeps = {
  store: TaskStore;
  spawnTo: SpawnToFn;
  notify: NotifyFn;
  sync?: SyncFn;
  reregister?: ReregisterFn;
  logger: Logger;
};

export async function resolveConflicts(
  triggerTask: Task,
  conflicts: Conflict[],
  deps: ResolveDeps,
): Promise<void> {
  const { store, spawnTo, notify, sync, reregister, logger } = deps;
  const unresolved: Conflict[] = [];

  for (const conflict of conflicts) {
    const conflictTask = store.getTask(conflict.taskId);
    if (!conflictTask) continue;

    const source = conflictTask.createdBy || triggerTask.createdBy;
    if (!source || source === "用户") {
      unresolved.push(conflict);
      continue;
    }

    try {
      const prompt = `背景：scheduler 是一个运行在本地的 Node.js 定时任务服务（localhost:3500），它通过 shell executor 直接在本机执行脚本，通过 http executor 调用本地/远程 API。你的角色是评审修正方案，不涉及执行。

scheduler 检测到你管理的一个定时任务与另一个任务存在调度冲突，需要你确认修正方案。

冲突详情：
- 新增/修改的任务：${triggerTask.name}（cron: ${triggerTask.cron}，${triggerTask.description}）
- 你管理的任务：${conflictTask.name}（cron: ${conflictTask.cron}，${conflictTask.description}）
- 冲突原因：${conflict.reason}
- 严重程度：${conflict.severity}
- 建议修正：${conflict.proposal}

请评估这个修正方案对你管理的任务是否可行，严格用以下JSON格式回复：
{
  "accept": true/false,
  "action": "accept（接受建议）/ reject（拒绝）/ counter（给出替代方案）",
  "counterProposal": "如果action是counter，写出你的替代方案，否则留空",
  "newCron": "如果同意或有替代方案，给出最终的cron表达式（5字段格式），否则留空"
}`;

      const raw = await spawnTo(source, prompt);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);

      if (!jsonMatch) {
        logger.warn({ source, conflict }, "no JSON in session response, escalating");
        unresolved.push(conflict);
        continue;
      }

      const reply = JSON.parse(jsonMatch[0]) as {
        accept: boolean;
        action: string;
        counterProposal?: string;
        newCron?: string;
      };

      if ((reply.action === "accept" || reply.action === "counter") && reply.newCron) {
        const targetId = conflict.taskId;
        const updated = store.updateTask(targetId, { cron: reply.newCron });
        reregister?.(updated);
        sync?.(updated);
        logger.info(
          { taskId: targetId, taskName: conflictTask.name, oldCron: conflictTask.cron, newCron: reply.newCron, action: reply.action },
          "conflict resolved: cron updated",
        );
      } else {
        unresolved.push(conflict);
      }
    } catch (err) {
      logger.error({ err, source, conflict: conflict.taskName }, "failed to consult session");
      unresolved.push(conflict);
    }
  }

  if (unresolved.length > 0) {
    const lines = unresolved.map(
      (c) => `• [${c.severity}] ${c.taskName} ↔ ${triggerTask.name}\n  原因：${c.reason}\n  建议：${c.proposal}`,
    );
    const text = `[Scheduler] 定时任务冲突未解决，需要人工介入\n\n${lines.join("\n\n")}`;
    try {
      await notify(text);
    } catch (err) {
      logger.error({ err }, "failed to send conflict notification");
    }
  }
}
