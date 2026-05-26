import type { Task } from "../db/taskStore.js";

export type Conflict = {
  taskId: string;
  taskName: string;
  reason: string;
  severity: "high" | "medium" | "low";
  proposal: string;
};

export type AnalysisResult = {
  hasConflicts: boolean;
  conflicts: Conflict[];
};

function formatTask(t: Task): string {
  const cfg = t.config as Record<string, unknown>;
  const timeout = Number(cfg.timeout ?? 0);
  const timeoutMin = Math.round(timeout / 60000);
  let detail = "";
  if (t.executor === "shell") {
    const cmd = String(cfg.command ?? "");
    detail = cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
  } else {
    detail = `${cfg.method ?? "GET"} ${cfg.url ?? ""}`;
  }
  return `- name: ${t.name}\n  cron: ${t.cron}\n  description: ${t.description || "(无)"}\n  executor: ${t.executor} → ${detail}\n  timeout: ${timeoutMin}分钟\n  enabled: ${t.enabled}\n  createdBy: ${t.createdBy || "未知"}`;
}

function buildPrompt(trigger: Task, allTasks: Task[]): string {
  const others = allTasks.filter((t) => t.id !== trigger.id && t.enabled);
  const taskList = others.map(formatTask).join("\n\n");

  return `你是一个定时任务调度冲突分析器。

以下是当前所有已启用的定时任务：
${taskList}

以下是刚刚新增/修改的任务：
${formatTask(trigger)}

请分析这个新任务与现有任务之间是否存在冲突。重点检查：
1. 时间重叠：两个任务的执行窗口（cron时间 + timeout时长）是否重叠？尤其注意 restart/reload 类任务会杀掉正在运行的进程。
2. 资源竞争：是否有任务同时访问同一个数据库、文件、或API？
3. 执行顺序：是否有任务依赖另一个任务的输出，但cron时间安排不当？
4. 长时间任务风险：timeout超长的任务是否可能跨过restart窗口？

请严格用以下JSON格式回复（不要包含其他内容）：
{
  "hasConflicts": true/false,
  "conflicts": [
    {
      "taskId": "冲突任务的id",
      "taskName": "冲突任务的name",
      "reason": "冲突原因（中文，一句话）",
      "severity": "high/medium/low",
      "proposal": "修正建议（中文，具体可执行的方案，比如'将cron从0 3 * * *改为0 5 * * *'）"
    }
  ]
}

如果没有冲突，conflicts数组为空。只报告真实存在的风险，不要过度报告。`;
}

type SpawnFn = (prompt: string) => Promise<string>;

export async function analyzeConflicts(
  trigger: Task,
  allTasks: Task[],
  spawn: SpawnFn,
  logger: { error(obj: unknown, msg: string): void; info(obj: unknown, msg: string): void },
): Promise<AnalysisResult> {
  const enabledOthers = allTasks.filter((t) => t.id !== trigger.id && t.enabled);
  if (enabledOthers.length === 0) {
    return { hasConflicts: false, conflicts: [] };
  }

  const prompt = buildPrompt(trigger, allTasks);

  try {
    const raw = await spawn(prompt);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.error({ raw: raw.slice(0, 500) }, "conflict analysis: no JSON in response");
      return { hasConflicts: false, conflicts: [] };
    }

    const parsed = JSON.parse(jsonMatch[0]) as AnalysisResult;
    if (!Array.isArray(parsed.conflicts)) {
      return { hasConflicts: false, conflicts: [] };
    }

    return {
      hasConflicts: parsed.conflicts.length > 0,
      conflicts: parsed.conflicts,
    };
  } catch (err) {
    logger.error({ err }, "conflict analysis failed");
    return { hasConflicts: false, conflicts: [] };
  }
}
