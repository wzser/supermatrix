import type { NotifyContext } from "../types.js";
import type { RunCliFn } from "./userDM.js";

export function createCustomChat(opts: {
  larkCliPath: string;
  runCli: RunCliFn;
}) {
  return async function sendCustomChat(ctx: NotifyContext, chatId: string): Promise<void> {
    const header = eventToHeader(ctx.event);
    const text = `${header} [${ctx.taskName}]\n\nowner: ${ctx.ownerSession}\nrun: ${ctx.runId}\n\n${ctx.message}`;
    await opts.runCli(opts.larkCliPath, [
      "im",
      "+messages-send",
      "--chat-id",
      chatId,
      "--as",
      "bot",
      "--text",
      text,
    ]);
  };
}

function eventToHeader(event: NotifyContext["event"]): string {
  if (event === "trigger_failed") return "[scheduler] trigger failed:";
  if (event === "receipt_missing") return "[scheduler] receipt missing:";
  return "[scheduler] succeeded:";
}
