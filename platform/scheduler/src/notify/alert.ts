import type { Task, ScriptConfig, SessionConfig } from "../types.js";

export type FetchImpl = typeof fetch;

// Four trigger paths in v2, each with a different "what does 'failed' mean":
//  - script-wait     : type=script + config.timeout set → triggerShell waits for
//                      exit. failure = exit ≠0 or timeout. error column has the
//                      child's stderr tail (script ran, then crashed).
//  - script-fnf      : type=script + no timeout → fire-and-forget. failure =
//                      spawn never got a PID (rare; usually only bad cwd).
//  - session-async   : type=session + closure.target.type=todo_pool → spawn2.0
//                      returns switched_async ref. failure = spawn endpoint
//                      didn't return ok=true (spawn never started).
//  - session-sync    : type=session + closure.target.type=inline|topic|session
//                      → spawn2.0 sync-waits for the child. failure = fetch
//                      aborted at config.timeout or non-2xx; the child MAY still
//                      be running on the owner side (see memory
//                      project_topic_closure_sync_inline).
export type TriggerMode = "script-wait" | "script-fnf" | "session-async" | "session-sync";

export function deriveTriggerMode(task: Task): TriggerMode {
  if (task.type === "script") {
    const cfg = task.config as ScriptConfig;
    return cfg.timeout !== undefined ? "script-wait" : "script-fnf";
  }
  const cfg = task.config as SessionConfig;
  const closureType =
    (cfg.body as { closure?: { target?: { type?: string } } } | undefined)
      ?.closure?.target?.type;
  return closureType === "todo_pool" ? "session-async" : "session-sync";
}

function failureMeaning(mode: TriggerMode): string {
  switch (mode) {
    case "script-wait":
      return '"失败"=脚本退出非 0 或超时（triggerShell wait-for-exit 模式）。error 字段含 stderr 尾部，先看那里再判断 owner 侧 / 上游 / 脚本本身。';
    case "script-fnf":
      return '"失败"=spawn 没拿到 PID（fire-and-forget），多半是 cwd 不存在或 fork 失败。';
    case "session-async":
      return '"失败"=spawn2.0 没回 ok（spawn 真的没起来），子 session 没被点起来。';
    case "session-sync":
      return '"失败"=scheduler 等子 session 同步回复超时被 AbortController 掐了；子 session 仍在 owner 侧跑，可能后续会写产物 / 回投。fetch 失败 ≠ 业务失败。';
  }
}

export function createAlertSender(opts: {
  smApiUrl?: string;
  fetchImpl?: FetchImpl;
}) {
  const smApiUrl = opts.smApiUrl ?? "http://127.0.0.1:3501";
  const fetchFn: FetchImpl = opts.fetchImpl ?? fetch;

  return async function sendAlert(task: Task, consecutiveFailures: number): Promise<void> {
    const channel = task.alertChannel;
    if (channel === "none") return;

    const triggerMode = deriveTriggerMode(task);

    const payload: {
      source: string;
      title: string;
      body: string;
      level: "error";
      targetChatId?: string;
      metadata: Record<string, string | number>;
    } = {
      source: "scheduler",
      title: `[scheduler-v2] 任务连续失败告警 — ${task.name}`,
      body:
        `owner: ${task.owner}\n` +
        `type: ${task.type}  triggerMode: ${triggerMode}\n` +
        `连续失败: ${consecutiveFailures} 次（阈值 ${task.alertThreshold}）\n` +
        `注意：${failureMeaning(triggerMode)}`,
      level: "error",
      metadata: {
        taskId: task.id,
        taskName: task.name,
        owner: task.owner,
        taskType: task.type,
        triggerMode,
        alertChannel: channel,
        consecutiveFailures,
        alertThreshold: task.alertThreshold,
      },
    };
    if (channel.startsWith("oc_")) {
      payload.targetChatId = channel;
    }

    try {
      await fetchFn(`${smApiUrl}/api/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // best-effort: a failed alert send must never break the tick.
    }
  };
}
