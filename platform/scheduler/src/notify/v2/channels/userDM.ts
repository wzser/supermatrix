import type { NotifyContext } from "../types.js";

export type RunCliFn = (
  cmd: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

export function createUserDM(opts: {
  larkCliPath: string;
  userOpenId: string;
  runCli: RunCliFn;
}) {
  return async function sendUserDM(ctx: NotifyContext): Promise<void> {
    const header = eventToHeader(ctx.event);
    const text = `${header} [${ctx.taskName}]\n\nowner: ${ctx.ownerSession}\nrun: ${ctx.runId}\n\n${ctx.message}`;
    await opts.runCli(opts.larkCliPath, [
      "im",
      "+messages-send",
      "--user-id",
      opts.userOpenId,
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
