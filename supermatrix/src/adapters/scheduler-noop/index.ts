import { UserError } from "../../domain/errors.ts";
import type { NewTaskInput, Scheduler, ScheduledTask } from "../../ports/Scheduler.ts";

export class NoopScheduler implements Scheduler {
  async addTask(_input: NewTaskInput): Promise<ScheduledTask> {
    void _input;
    throw new UserError("scheduler 模块尚未实现");
  }
  async removeTask(_id: string): Promise<void> {
    void _id;
    throw new UserError("scheduler 模块尚未实现");
  }
  async listTasks(): Promise<ScheduledTask[]> {
    return [];
  }
  async pauseTask(_id: string): Promise<void> {
    void _id;
    throw new UserError("scheduler 模块尚未实现");
  }
  async resumeTask(_id: string): Promise<void> {
    void _id;
    throw new UserError("scheduler 模块尚未实现");
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
