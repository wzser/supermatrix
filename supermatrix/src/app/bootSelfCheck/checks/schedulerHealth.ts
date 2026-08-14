import type { BootCheck } from "../types.ts";
import { errorMessage } from "../../errorMessage.ts";

export const schedulerHealthCheck: BootCheck = {
  name: "scheduler-health",
  phases: ["pre-wiring", "runtime"],
  async run() {
    const url = process.env["SM_SCHEDULER_HEALTH_URL"];
    if (!url) {
      return { name: "scheduler-health", status: "ok", detail: { skipped: "SM_SCHEDULER_HEALTH_URL not set" } };
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) {
        return { name: "scheduler-health", status: "warn", message: `scheduler /health 返回 HTTP ${res.status}` };
      }
      const body = (await res.json()) as { status?: string; tasks?: number };
      if (body.status !== "ok") {
        return { name: "scheduler-health", status: "warn", message: `scheduler 状态=${body.status}` };
      }
      return { name: "scheduler-health", status: "ok", detail: { tasks: body.tasks ?? null } };
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      const suffix = ` (${url})`;
      if (name === "TimeoutError") {
        return { name: "scheduler-health", status: "warn", message: `scheduler /health 2 秒超时${suffix}` };
      }
      return { name: "scheduler-health", status: "warn", message: `scheduler 不可达：${errorMessage(err)}${suffix}` };
    }
  },
};
