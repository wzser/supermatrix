import type { AbsolutePath } from "../../domain/ids.ts";
import { asAbsolutePath } from "../../domain/ids.ts";
import type { BackendKind } from "../../domain/session.ts";
import { UserError } from "../../domain/errors.ts";
import type { CommandHandler } from "../commandRegistry.ts";
import { resolveAndValidateModel } from "./setModel.ts";

export type NewHandlerDeps = {
  lifecycle: {
    create(input: {
      backend: BackendKind;
      name: string;
      purpose: string;
      model?: string;
      workdir?: AbsolutePath;
      chatName?: string;
    }): Promise<{ session: { name: string } }>;
  };
};

export function createNewHandler(deps: NewHandlerDeps): CommandHandler {
  return async ({ args, scope }) => {
    if (scope !== "root") throw new UserError("/new 只能在 root 群使用");
    const backend = args.backend as BackendKind | undefined;
    const name = args.name;
    if (!backend || !name) throw new UserError("用法：/new <claude|codex> <name> [--model <m>] [--workdir <path>] [--chat-name <name>] [purpose...]");
    const model = args.model ? resolveAndValidateModel(args.model, backend) : undefined;
    const workdir = args.workdir ? asAbsolutePath(args.workdir) : undefined;
    const rawChatName = args["chat-name"]?.trim();
    const chatName = rawChatName ? rawChatName : undefined;
    const { session } = await deps.lifecycle.create({
      backend,
      name,
      purpose: args.purpose ?? "",
      ...(model !== undefined ? { model } : {}),
      ...(workdir !== undefined ? { workdir } : {}),
      ...(chatName !== undefined ? { chatName } : {}),
    });
    const suffix = args.workdir ? "（使用已有工作区）" : "";
    return { replyText: `✓ 已创建 session 「${session.name}」，对应飞书群已建好${suffix}` };
  };
}
