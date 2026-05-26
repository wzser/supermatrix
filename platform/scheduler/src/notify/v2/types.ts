import type { NotifyEvent } from "../../classes/types.js";

export type NotifyContext = {
  event: NotifyEvent;
  taskId: string;
  runId: string;
  taskName: string;
  ownerSession: string;
  message: string;
  metadata?: Record<string, unknown>;
};

export type ChannelImpls = {
  ownerDM: (ctx: NotifyContext) => Promise<void>;
  userDM: (ctx: NotifyContext) => Promise<void>;
  customChat: (ctx: NotifyContext, target: string) => Promise<void>;
};
