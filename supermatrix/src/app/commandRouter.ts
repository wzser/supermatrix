import { DomainError, SystemError, UserError } from "../domain/errors.ts";
import { parseCommand } from "../domain/parseCommand.ts";
import type { Scope } from "../domain/scope.ts";
import type { InboundMessage } from "../ports/LarkGateway.ts";
import type {
  CommandRegistry,
  CommandResult,
} from "./commandRegistry.ts";

export type RouteInput = {
  scope: Scope;
  msg: InboundMessage;
};

export function createCommandRouter(registry: CommandRegistry) {
  const commandsForParser = Object.fromEntries(
    Object.entries(registry).map(([name, entry]) => [name, entry.command])
  );

  async function route(input: RouteInput): Promise<CommandResult> {
    const parsed = parseCommand(input.msg.text, commandsForParser, input.scope);
    if (parsed.kind === "error") {
      return { replyText: `❌ ${parsed.message}，使用 /help 查看可用命令` };
    }
    const entry = registry[parsed.name];
    if (!entry) return { replyText: `❌ 未知命令：${parsed.name}` };
    if (!entry.command.scope.includes(input.scope)) {
      return { replyText: `❌ 命令 /${parsed.name} 不可在${input.scope === "root" ? "root" : "此"}群使用` };
    }
    try {
      return await entry.handler({ args: parsed.args, scope: input.scope, msg: input.msg });
    } catch (err) {
      if (err instanceof UserError) return { replyText: `❌ ${err.message}` };
      if (err instanceof SystemError) return { replyText: "❌ 内部错误，请查看 console 日志" };
      if (err instanceof DomainError) return { replyText: `❌ ${err.message}` };
      return { replyText: "❌ 未知错误，请查看 console 日志" };
    }
  }

  return { route };
}
