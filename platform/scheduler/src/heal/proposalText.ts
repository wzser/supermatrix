import type { Idempotency } from "../classes/types.js";

type Params = {
  taskName: string;
  runId: string;
  reason: string;
  triggeredAt: number;
  evidence: Record<string, unknown>;
  idempotency: Idempotency;
};

export function renderProposalText(p: Params): string {
  const defaultAction = p.idempotency === "pure" ? "RETRY" : "SKIP";
  const triggeredIso = new Date(p.triggeredAt).toISOString();
  return [
    "【scheduler heal proposal】",
    "",
    `task: ${p.taskName}`,
    `run_id: ${p.runId}`,
    `anomaly: ${p.reason}`,
    "",
    "状况:",
    `  triggered_at: ${triggeredIso}`,
    `  evidence: ${JSON.stringify(p.evidence)}`,
    "",
    "动作（回复格式：ACTION: <name>）:",
    "  RETRY     现在补跑一次",
    "  SKIP      记作已知失败，等下一轮 cron",
    "  DISABLE   停掉这个 task（enabled=false）",
    "  ADJUST    改 expectedDuration / 改 receiptProof / 改 overrides",
    "",
    "ADJUST 自动 apply 模式（推荐）：在回复里附 PATCH 块（JSON），scheduler 会直接 PATCH 任务并重验一次：",
    "  ACTION: ADJUST",
    "  PATCH: { \"expectedDurationMs\": 3600000, \"overrides\": { \"receiptProof\": { \"kind\": \"exit_zero\" } } }",
    "  允许字段：expectedDurationMs / overrides / cron。其它字段（如 enabled / class）不在 PATCH 内，请用对应 ACTION。",
    "  没附 PATCH 也可以——若你已经自己 PATCH 过 task，scheduler 检测到 task.updated_at > 本提案 spawned_at 就不再打扰你；否则会通知用户协调。",
    "",
    `默认 24h 无回复 → ${defaultAction}（此 task idempotency=${p.idempotency}）`,
  ].join("\n");
}
