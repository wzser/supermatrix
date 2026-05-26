import { execFile } from "node:child_process";
import type { Task, TaskRun } from "../db/taskStore.js";

export type BitableSyncConfig = {
  larkCliPath: string;
  baseToken: string;
  tableId: string;
};

export type BitableSync = {
  syncTask(task: Task, latestRun?: TaskRun): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
};

function configSummary(task: Task): string {
  const cfg = task.config as Record<string, unknown>;
  if (task.executor === "shell") {
    const cmd = String(cfg.command ?? "");
    const short = cmd.length > 40 ? cmd.slice(0, 37) + "..." : cmd;
    return `shell: ${short} @ ${cfg.cwd ?? "?"} (${Number(cfg.timeout ?? 0) / 1000}s)`;
  }
  const method = String(cfg.method ?? "GET");
  const url = String(cfg.url ?? "");
  const short = url.length > 50 ? url.slice(0, 47) + "..." : url;
  return `http: ${method} ${short} (${Number(cfg.timeout ?? 0) / 1000}s)`;
}

function overridesSummary(overrides: Record<string, unknown> | null): string {
  if (!overrides) return "";
  try {
    return JSON.stringify(overrides);
  } catch {
    return "[unserializable]";
  }
}

export function taskToFields(task: Task, latestRun?: TaskRun): Record<string, unknown> {
  const classDisplay = task.class ?? "未迁移";
  const expectedMinutes =
    task.expectedDurationMs !== null ? Math.floor(task.expectedDurationMs / 60_000) : null;
  return {
    "任务ID": task.id,
    "任务名": task.name,
    "任务描述": task.description,
    "Cron": task.cron,
    "执行器": task.executor,
    "状态": task.enabled ? "启用" : "停用",
    "单次任务": task.oneshot ? "是" : "否",
    "失败通知": task.notifyOnFailure ? "开启" : "关闭",
    "配置摘要": configSummary(task),
    "预计下次执行": task.nextRunAt,
    "上次成功执行": task.lastSuccessAt,
    "创建来源": task.createdBy || "未知",
    "创建时间": task.createdAt,
    "更新时间": task.updatedAt,
    "任务分类": classDisplay,
    "业务分类": task.category ?? "未标",
    "预期时长(分钟)": expectedMinutes,
    "Owner session": task.ownerSession ?? "",
    "并发策略": task.overlapPolicy ?? "",
    "覆盖配置": overridesSummary(task.overrides),
    "迁移阶段": task.migrationEscalationStage,
    "最近触发状态": latestRun ? latestRun.triggerStatus : "无",
    "最近验证状态": latestRun ? latestRun.verifyStatus : "无",
    "最近运行状态": latestRun ? latestRun.finalStatus : "无",
    "最近触发时间": latestRun?.triggeredAt ?? null,
  };
}

function runLarkCli(cliPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cliPath, args, { timeout: 15_000, maxBuffer: 512 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

async function findRecordId(
  cliPath: string,
  baseToken: string,
  tableId: string,
  taskId: string,
): Promise<string | null> {
  const json = JSON.stringify({ keyword: taskId, search_fields: ["任务ID"] });
  const stdout = await runLarkCli(cliPath, [
    "base", "+record-search",
    "--base-token", baseToken,
    "--table-id", tableId,
    "--json", json,
    "-q", ".data.record_id_list",
  ]);
  const ids = JSON.parse(stdout) as string[];
  return ids.length > 0 ? ids[0] : null;
}

export function createBitableSync(
  config: BitableSyncConfig,
  logger: { error(obj: unknown, msg: string): void; info(obj: unknown, msg: string): void },
): BitableSync {
  const { larkCliPath, baseToken, tableId } = config;

  return {
    async syncTask(task, latestRun) {
      try {
        const recordId = await findRecordId(larkCliPath, baseToken, tableId, task.id);
        const fields = taskToFields(task, latestRun);
        const json = JSON.stringify(fields);

        if (recordId) {
          await runLarkCli(larkCliPath, [
            "base", "+record-upsert",
            "--base-token", baseToken,
            "--table-id", tableId,
            "--record-id", recordId,
            "--json", json,
          ]);
        } else {
          await runLarkCli(larkCliPath, [
            "base", "+record-upsert",
            "--base-token", baseToken,
            "--table-id", tableId,
            "--json", json,
          ]);
        }
        logger.info({ taskId: task.id, taskName: task.name }, "bitable synced");
      } catch (err) {
        logger.error({ err, taskId: task.id }, "bitable sync failed");
      }
    },

    async deleteTask(taskId) {
      const recordId = await findRecordId(larkCliPath, baseToken, tableId, taskId);
      if (!recordId) return;
      await runLarkCli(larkCliPath, [
        "base", "+record-delete",
        "--base-token", baseToken,
        "--table-id", tableId,
        "--record-id", recordId,
        "--yes",
      ]);
      logger.info({ taskId }, "bitable record deleted");
    },
  };
}
