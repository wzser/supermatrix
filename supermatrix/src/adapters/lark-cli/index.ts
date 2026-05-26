import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AbsolutePath, CardId, LarkGroupId } from "../../domain/ids.ts";
import { asLarkGroupId } from "../../domain/ids.ts";
import type { RunStatus } from "../../ports/BindingStore.ts";
import type {
  CreateGroupInput,
  InboundAttachment,
  InboundHandler,
  InboundMessage,
  LarkGateway,
  LarkPostIdentity,
} from "../../ports/LarkGateway.ts";
import type { Logger } from "../../ports/Logger.ts";
import type { LarkRawMessage, LarkSdkClient } from "./client.ts";

export type LarkCliGatewayDeps = {
  client: LarkSdkClient;
  attachmentDir: (groupId: LarkGroupId, nowIso: string) => AbsolutePath;
  logger: Logger;
};

export class LarkCliGateway implements LarkGateway {
  private unsubscribe?: () => void;
  private inflight = new Set<Promise<void>>();

  constructor(private readonly deps: LarkCliGatewayDeps) {}

  async start(handler: InboundHandler): Promise<void> {
    this.unsubscribe = this.deps.client.subscribeInbound((raw) => {
      const p = this.handleRaw(raw, handler).catch(() => {});
      this.inflight.add(p);
      p.then(() => this.inflight.delete(p));
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    await Promise.all(this.inflight);
  }

  private async handleRaw(raw: LarkRawMessage, handler: InboundHandler): Promise<void> {
    if (raw.chatType === "p2p") {
      this.deps.logger.info("ignored p2p message", { userId: raw.userId });
      await this.deps.client.sendText(
        asLarkGroupId(raw.groupId),
        "⚠️ 私聊不可用，请在对应的群组中使用命令",
      );
      return;
    }

    const groupId = asLarkGroupId(raw.groupId);
    const dateIso = new Date(raw.timestampMs).toISOString().slice(0, 10);
    const dir = this.deps.attachmentDir(groupId, dateIso);

    const attachments: InboundAttachment[] = raw.attachments.map((att) => ({
      kind: att.kind,
      originalName: att.originalName,
      ...(att.mimeType ? { mimeType: att.mimeType } : {}),
      fetch: async () => {
        await mkdir(dir, { recursive: true });
        const safeName = `${raw.messageId}_${att.originalName.replace(/[^\w.\-]/gu, "_")}`;
        const localPath = join(dir, safeName) as AbsolutePath;
        await this.deps.client.downloadAttachment({
          messageId: raw.messageId,
          fileKey: att.remoteKey,
          type: att.kind,
          destPath: localPath,
        });
        return { localPath };
      },
    }));

    const msg: InboundMessage = {
      groupId,
      messageId: raw.messageId,
      userId: raw.userId,
      text: raw.text,
      ...(raw.mentionedBot !== undefined ? { mentionedBot: raw.mentionedBot } : {}),
      attachments,
      receivedAtMs: raw.timestampMs,
    };
    try {
      await handler(msg);
    } catch (err) {
      this.deps.logger.error("inbound handler threw", { err });
    }
  }

  async sendMessage(groupId: LarkGroupId, text: string, identity?: LarkPostIdentity): Promise<void> {
    await this.deps.client.sendText(groupId, text, identity);
  }

  async postCard(groupId: LarkGroupId, initialText: string, title: string): Promise<CardId> {
    return this.deps.client.postCard(groupId, initialText, title);
  }

  async updateCard(cardId: CardId, text: string, title: string): Promise<void> {
    await this.deps.client.updateCard(cardId, text, title);
  }

  async finalizeCard(
    cardId: CardId,
    text: string,
    title: string,
    processLog?: string,
    runStatus?: RunStatus,
  ): Promise<void> {
    await this.deps.client.finalizeCard(cardId, text, title, processLog, runStatus);
  }

  async createGroup(input: CreateGroupInput): Promise<LarkGroupId> {
    return this.deps.client.createGroup(input.name, input.ownerUserId);
  }

  async inviteUser(groupId: LarkGroupId, userId: string): Promise<void> {
    await this.deps.client.inviteUser(groupId, userId);
  }

  async dissolveGroup(groupId: LarkGroupId): Promise<void> {
    await this.deps.client.dissolveGroup(groupId);
  }

  async renameGroup(groupId: LarkGroupId, name: string): Promise<void> {
    await this.deps.client.renameGroup(groupId, name);
  }

  async getGroupName(groupId: LarkGroupId): Promise<string> {
    return this.deps.client.getGroupName(groupId);
  }
}
