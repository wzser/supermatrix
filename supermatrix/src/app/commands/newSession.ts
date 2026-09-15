import type { AbsolutePath, LarkGroupId } from "../../domain/ids.ts";
import { asAbsolutePath } from "../../domain/ids.ts";
import type {
  BackendKind,
  EffortLevel,
  Session,
  SessionCategory,
} from "../../domain/session.ts";
import { UserError } from "../../domain/errors.ts";
import type { CommandHandler } from "../commandRegistry.ts";
import { resolveAndValidateModel } from "./setModel.ts";
import type { CodexModelAvailability } from "../../ports/CodexModelAvailability.ts";
import { resolveBackendAlias } from "./backendAliases.ts";

export type NewHandlerDeps = {
  store: {
    findSessionByName(name: string): Promise<Pick<
      Session,
      | "id"
      | "workdir"
      | "purpose"
      | "category"
      | "thinking"
      | "inactivityTimeoutS"
      | "maxRuntimeS"
    > | null>;
    getSessionHeartbeatEnabled(id: Session["id"]): Promise<boolean>;
  };
  lifecycle: {
    create(input: {
      backend: BackendKind;
      name: string;
      purpose: string;
      model?: string;
      effort?: EffortLevel | null;
      workdir?: AbsolutePath;
      chatName?: string;
      category?: SessionCategory;
      thinking?: boolean;
      inactivityTimeoutS?: number | null;
      maxRuntimeS?: number | null;
      heartbeatEnabled?: boolean;
      affiliatedTo?: string | null;
    }): Promise<{ session: { name: string } }>;
  };
  availability?: CodexModelAvailability;
};

export type CloneHandlerDeps = NewHandlerDeps & {
  resolveUserGroupSession(
    groupId: LarkGroupId,
  ): Promise<{ name: string; id: string } | null>;
};

const NEW_USAGE =
  "用法：/new <claude|codex|kimi> <name> [--model <m>] [--workdir <path>] [--chat-name <name>] [purpose...]\n" +
  "Clone：/new clone <来源session> <claude|codex|kimi> <新session名> [--model <m>] [--chat-name <name>] [purpose...]";

function parseCloneTail(raw: string | undefined): {
  backend: BackendKind;
  name: string;
  purpose: string;
} {
  const [backendToken, name, ...purposeParts] = raw?.trim().split(/\s+/u) ?? [];
  if (!backendToken || !name) throw new UserError(NEW_USAGE);
  const backend = resolveBackendAlias(backendToken);
  if (!backend) {
    throw new UserError("Clone backend 必须是以下之一：claude|codex|kimi");
  }
  return { backend, name, purpose: purposeParts.join(" ") };
}

async function cloneSession(
  deps: NewHandlerDeps,
  input: {
    sourceName: string;
    backend: BackendKind;
    name: string;
    purpose?: string;
    model?: string;
    chatName?: string;
  },
): Promise<{ replyText: string }> {
  const source = await deps.store.findSessionByName(input.sourceName);
  if (!source) throw new UserError(`来源 session 不存在：${input.sourceName}`);
  const heartbeatEnabled = await deps.store.getSessionHeartbeatEnabled(source.id);
  const model = input.model
    ? resolveAndValidateModel(input.model, input.backend)
    : undefined;
  const { session } = await deps.lifecycle.create({
    backend: input.backend,
    name: input.name,
    purpose: input.purpose || source.purpose,
    effort: null,
    workdir: source.workdir,
    category: source.category,
    thinking: source.thinking,
    inactivityTimeoutS: source.inactivityTimeoutS,
    maxRuntimeS: source.maxRuntimeS,
    heartbeatEnabled,
    affiliatedTo: input.sourceName,
    ...(model !== undefined ? { model } : {}),
    ...(input.chatName !== undefined ? { chatName: input.chatName } : {}),
  });
  return {
    replyText: `✓ 已基于 session 「${input.sourceName}」的配置创建 session 「${session.name}」（backend=${input.backend}）`,
  };
}

export function createCloneHandler(deps: CloneHandlerDeps): CommandHandler {
  return async ({ args, scope, msg }) => {
    if (scope !== "user") throw new UserError("/clone 只能在 session 群使用");
    const backendToken = args.backend;
    const name = args.name;
    if (!backendToken || !name) {
      throw new UserError("用法：/clone <claude|codex|kimi> <新session名>");
    }
    const backend = resolveBackendAlias(backendToken);
    if (!backend) {
      throw new UserError("Clone backend 必须是以下之一：claude|codex|kimi");
    }
    const source = await deps.resolveUserGroupSession(msg.groupId);
    if (!source) throw new UserError("当前群未绑定 session");
    return cloneSession(deps, {
      sourceName: source.name,
      backend,
      name,
    });
  };
}

export function createNewHandler(deps: NewHandlerDeps): CommandHandler {
  return async ({ args, scope }) => {
    if (scope !== "root") throw new UserError("/new 只能在 root 群使用");
    const selector = args.backend;
    const sourceOrName = args.name;
    if (!selector || !sourceOrName) throw new UserError(NEW_USAGE);

    if (selector === "clone") {
      if (args.workdir) throw new UserError("/new clone 不能同时指定 --workdir");
      const clone = parseCloneTail(args.purpose);
      const rawChatName = args["chat-name"]?.trim();
      return cloneSession(deps, {
        sourceName: sourceOrName,
        backend: clone.backend,
        name: clone.name,
        purpose: clone.purpose,
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(rawChatName ? { chatName: rawChatName } : {}),
      });
    }

    const backend = selector as BackendKind;
    const name = sourceOrName;
    const purpose = args.purpose ?? "";
    const workdir = args.workdir ? asAbsolutePath(args.workdir) : undefined;

    // Catalog-valid model only — no generative Codex availability probe on this
    // synchronous creation path. The first real Codex execution stays
    // authoritative. The `availability` seam is retained so tests can prove
    // this path never probes.
    const model = args.model ? resolveAndValidateModel(args.model, backend) : undefined;
    const rawChatName = args["chat-name"]?.trim();
    const chatName = rawChatName ? rawChatName : undefined;
    const { session } = await deps.lifecycle.create({
      backend,
      name,
      purpose,
      effort: null,
      ...(model !== undefined ? { model } : {}),
      ...(workdir !== undefined ? { workdir } : {}),
      ...(chatName !== undefined ? { chatName } : {}),
    });
    const suffix = args.workdir ? "（使用已有工作区）" : "";
    return { replyText: `✓ 已创建 session 「${session.name}」，对应飞书群已建好${suffix}` };
  };
}
