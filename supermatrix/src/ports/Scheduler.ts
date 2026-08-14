import type { Timestamp } from "../domain/ids.ts";

export type ScheduledTask = {
  id: string;
  cronExpression: string;
  sessionName: string;
  prompt: string;
  enabled: boolean;
  createdAt: Timestamp;
  lastRunAt?: Timestamp | undefined;
  nextRunAt?: Timestamp | undefined;
};

export type NewTaskInput = Omit<ScheduledTask, "id" | "createdAt" | "lastRunAt" | "nextRunAt">;

export type Scheduler = {
  addTask(input: NewTaskInput): Promise<ScheduledTask>;
  removeTask(id: string): Promise<void>;
  listTasks(): Promise<ScheduledTask[]>;
  pauseTask(id: string): Promise<void>;
  resumeTask(id: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
