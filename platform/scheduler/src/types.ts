export type TaskType = "script" | "session";

export type ScriptConfig = { command: string; cwd: string; timeout?: number; catchUpOnBoot?: boolean };
export type SessionConfig = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
  timeout: number;
  catchUpOnBoot?: boolean;
};

export type Task = {
  id: string;
  name: string;
  description: string;
  owner: string;
  createdBy: string;
  type: TaskType;
  config: ScriptConfig | SessionConfig;
  cron: string;
  enabled: boolean;
  oneshot: boolean;
  category: string | null;
  retryEnabled: boolean;
  // Omitted keeps the legacy retryEnabled behavior; an explicit list scopes
  // retries to matching script exit codes.
  retryExitCodes?: number[];
  retryMax: number;
  retryDelayMs: number;
  alertThreshold: number;
  alertChannel: string;      // 'owner_dm' | 'none' | oc_<chatId>
  lastSuccessAt: number | null;
  createdAt: number;
  updatedAt: number;
};

// `expired` is scheduler availability evidence: the slot was never dispatched
// because it was already outside the boot catch-up window.
export type RunOutcome = "success" | "failed" | "expired";

export type TaskRun = {
  id: string;
  taskId: string;
  scheduledAt: number | null;
  triggeredAt: number;
  finishedAt: number | null;
  outcome: RunOutcome;
  attempts: number;
  error: string | null;
  pid: number | null;
  childSessionId: string | null;
};

export type TriggerResult =
  | { ok: true; pid?: number; childSessionId?: string }
  | { ok: false; error: string; exitCode?: number };
