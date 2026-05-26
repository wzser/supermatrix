import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LarkGroupId } from "../domain/ids.ts";
import { extractStaWritebackCommandText } from "../domain/staWritebackCommand.ts";
import type { BindingStore } from "../ports/BindingStore.ts";
import type { InboundMessage } from "../ports/LarkGateway.ts";
import type { Logger } from "../ports/Logger.ts";
import type { CommandResult } from "./commandRegistry.ts";
import { errorMessage } from "./errorMessage.ts";

const execFileP = promisify(execFile);
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_PAGE_SIZE = 10;
const DEFAULT_TARGET_SESSION_NAMES = ["huojian-king"];
const MAX_SEEN_MESSAGE_IDS = 500;

type StaWritebackPollerStore = Pick<BindingStore, "findSessionByName" | "findBySession">;

type StaWritebackListedMessage = {
  chat_id?: string;
  content?: string;
  message_id?: string;
  msg_type?: string;
  sender?: {
    id?: string;
    sender_type?: string;
  };
};

type LarkMessageListEnvelope = {
  ok: boolean;
  data?: {
    messages?: StaWritebackListedMessage[];
  };
  error?: {
    type?: string;
    message?: string;
  };
};

export type StaWritebackPollerDeps = {
  larkCliPath: string;
  botAppId: string;
  store: StaWritebackPollerStore;
  router: {
    route(input: { scope: "user"; msg: InboundMessage }): Promise<CommandResult>;
  };
  lark: {
    sendMessage(groupId: LarkGroupId, text: string): Promise<void>;
    postCard(groupId: LarkGroupId, initialText: string, title: string): Promise<unknown>;
  };
  logger: Pick<Logger, "debug" | "info" | "warn" | "error">;
  targetSessionNames?: string[];
  intervalMs?: number;
  pageSize?: number;
  listMessages?: (groupId: LarkGroupId) => Promise<StaWritebackListedMessage[]>;
};

export type StaWritebackPoller = {
  start(): () => void;
  pollOnce(opts?: { seedOnly?: boolean }): Promise<void>;
};

export function createStaWritebackPoller(deps: StaWritebackPollerDeps): StaWritebackPoller {
  const seenMessageIds: string[] = [];
  const seenMessageIdSet = new Set<string>();
  const targetSessionNames = deps.targetSessionNames ?? DEFAULT_TARGET_SESSION_NAMES;
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  let running = false;

  const remember = (messageId: string): void => {
    if (seenMessageIdSet.has(messageId)) return;
    seenMessageIdSet.add(messageId);
    seenMessageIds.push(messageId);
    while (seenMessageIds.length > MAX_SEEN_MESSAGE_IDS) {
      const removed = seenMessageIds.shift();
      if (removed) seenMessageIdSet.delete(removed);
    }
  };

  const listMessages = deps.listMessages ?? (async (groupId: LarkGroupId) => {
    const result = await execFileP(deps.larkCliPath, [
      "im",
      "+chat-messages-list",
      "--as",
      "bot",
      "--chat-id",
      groupId,
      "--page-size",
      String(pageSize),
      "--sort",
      "desc",
      "--format",
      "json",
    ], {
      env: { ...process.env, LARK_CLI_NO_PROXY: "1" },
      maxBuffer: 10 * 1024 * 1024,
    });
    const parsed = JSON.parse(result.stdout) as LarkMessageListEnvelope;
    if (parsed.ok === false) {
      throw new Error(
        `lark-cli im +chat-messages-list error [${parsed.error?.type ?? "unknown"}]: ${
          parsed.error?.message ?? "unknown"
        }`,
      );
    }
    return parsed.data?.messages ?? [];
  });

  async function pollGroup(groupId: LarkGroupId, seedOnly: boolean): Promise<void> {
    const messages = await listMessages(groupId);
    for (const message of [...messages].reverse()) {
      const messageId = typeof message.message_id === "string" ? message.message_id : "";
      if (!messageId || seenMessageIdSet.has(messageId)) continue;

      const content = typeof message.content === "string" ? message.content : "";
      const commandText = extractStaWritebackCommandText(content);
      const senderId = typeof message.sender?.id === "string" ? message.sender.id : "";
      const senderType = message.sender?.sender_type;
      if (!commandText || senderType !== "app" || senderId === deps.botAppId) {
        remember(messageId);
        continue;
      }

      remember(messageId);
      if (seedOnly) {
        deps.logger.info("seeded existing sta-writeback app message without executing", {
          groupId,
          messageId,
        });
        continue;
      }

      deps.logger.info("sta-writeback app message detected by polling fallback", {
        groupId,
        messageId,
        senderId,
      });
      const result = await deps.router.route({
        scope: "user",
        msg: {
          groupId,
          messageId,
          userId: senderId,
          text: commandText,
          mentionedBot: false,
          attachments: [],
          receivedAtMs: Date.now(),
        },
      });
      if ("replyText" in result) {
        await deps.lark.sendMessage(groupId, result.replyText);
      } else if ("replyCard" in result) {
        await deps.lark.postCard(groupId, result.replyCard.body, result.replyCard.title);
      }
    }
  }

  async function pollOnce(opts: { seedOnly?: boolean } = {}): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (const sessionName of targetSessionNames) {
        const session = await deps.store.findSessionByName(sessionName);
        if (!session || session.status === "deleted") continue;
        const binding = await deps.store.findBySession(session.id);
        if (!binding) continue;
        await pollGroup(binding.groupId, opts.seedOnly === true);
      }
    } finally {
      running = false;
    }
  }

  function start(): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const run = (seedOnly: boolean) => {
      if (stopped) return;
      void pollOnce({ seedOnly }).catch((err) => {
        deps.logger.warn("sta-writeback polling fallback failed", { err: errorMessage(err) });
      });
    };

    run(true);
    timer = setInterval(() => run(false), deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    deps.logger.info("sta-writeback polling fallback started", {
      targetSessionNames,
      intervalMs: deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    });
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    };
  }

  return { start, pollOnce };
}
