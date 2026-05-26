import type { Task } from "../db/taskStore.js";
import type { ExecutorResult } from "../executors/types.js";

export type ResolveDeps = {
  spawnCall: (target: string, prompt: string) => Promise<string>;
  executeByTask: (task: Task) => Promise<ExecutorResult>;
  notifier: {
    notifyFailure: (taskName: string, error: string, metadata?: Record<string, unknown>) => Promise<void>;
  };
  store: {
    createRun: (taskId: string) => { id: string };
    completeRun: (runId: string, status: "success" | "failed", output: string | null, error: string | null) => void;
    updateLastSuccess: (taskId: string) => void;
    refreshNextRun: (taskId: string) => void;
  };
  logger: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
};

function buildPrompt(task: Task, result: ExecutorResult): string {
  const output = (result.output ?? "").slice(0, 2000);
  return [
    "你创建的定时任务执行失败，请协助修复。",
    "",
    `任务: ${task.name} (${task.id})`,
    `Executor: ${task.executor}`,
    `Config: ${JSON.stringify(task.config)}`,
    `失败时间: ${new Date().toISOString()}`,
    `错误: ${result.error ?? "unknown"}`,
    `输出: ${output}`,
    "",
    "请按以下步骤：",
    "1. 定位问题并修复代码/配置",
    `2. 【重要】不要调 POST http://localhost:3500/tasks/${task.id}/run，也不要手动执行命令做验证 — 修复完成后由我（scheduler）重跑验证`,
    "3. 如果调试时必须跑一次脚本，请在回复里说明",
    "",
    "请以 JSON 回复：",
    '{',
    '  "status": "fixed" | "cant_fix",',
    '  "summary": "修复内容或无法修复的原因",',
    '  "manualRun": true | false',
    '}',
  ].join("\n");
}

export async function resolveFailure(
  task: Task,
  originalResult: ExecutorResult,
  originalRunId: string,
  deps: ResolveDeps,
): Promise<void> {
  deps.logger.info({ taskId: task.id, taskName: task.name, createdBy: task.createdBy }, "failure resolve start");

  const prompt = buildPrompt(task, originalResult);

  let reply: string;
  try {
    reply = await deps.spawnCall(task.createdBy, prompt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.error({ taskId: task.id, err }, "failure resolve spawn error");
    await escalate(task, originalResult, originalRunId, `[协商失败] ${msg}`, deps);
    return;
  }

  let parsed: { status?: string; summary?: string } | null = null;
  try {
    parsed = JSON.parse(reply);
  } catch {
    deps.logger.warn({ taskId: task.id }, "failure resolve reply unparseable");
  }

  const status = parsed?.status;
  deps.logger.info({ taskId: task.id, status }, "failure resolve reply");

  if (status === "fixed") {
    const run = deps.store.createRun(task.id);
    const verify = await deps.executeByTask(task);
    deps.store.completeRun(run.id, verify.success ? "success" : "failed", verify.output, verify.error);
    deps.logger.info({ taskId: task.id, success: verify.success }, "failure resolve verify done");
    if (verify.success) {
      deps.store.updateLastSuccess(task.id);
      deps.store.refreshNextRun(task.id);
      return;
    }
    deps.store.refreshNextRun(task.id);
    const summary = parsed?.summary ?? "(no summary)";
    await escalate(task, originalResult, originalRunId, `[修复后重跑仍失败] ${task.createdBy} 回复: ${summary}`, deps);
    return;
  }

  if (status === "cant_fix") {
    const summary = parsed?.summary ?? "(no summary)";
    await escalate(task, originalResult, originalRunId, `[无法自动修复] ${task.createdBy} 回复: ${summary}`, deps);
    return;
  }

  const snippet = reply.slice(0, 200);
  await escalate(task, originalResult, originalRunId, `[协商失败] 无法解析 session 回复: ${snippet}`, deps);
}

async function escalate(
  task: Task,
  originalResult: ExecutorResult,
  originalRunId: string,
  suffix: string,
  deps: ResolveDeps,
): Promise<void> {
  deps.logger.warn({ taskId: task.id, suffix }, "failure resolve escalated");
  await deps.notifier.notifyFailure(task.name, `${originalResult.error ?? ""}\n\n${suffix}`, {
    taskId: task.id,
    runId: originalRunId,
  });
}
