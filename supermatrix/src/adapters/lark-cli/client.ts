import type { AbsolutePath, CardId, LarkGroupId } from "../../domain/ids.ts";
import type { RunStatus } from "../../ports/BindingStore.ts";

export type LarkSdkIdentity = "bot" | "user";

export type LarkSdkClient = {
  /** identity defaults to "bot" if omitted (historical behavior). */
  sendText(groupId: LarkGroupId, text: string, identity?: LarkSdkIdentity): Promise<void>;
  createGroup(name: string, ownerUserId: string): Promise<LarkGroupId>;
  inviteUser(groupId: LarkGroupId, userId: string): Promise<void>;
  dissolveGroup(groupId: LarkGroupId): Promise<void>;
  renameGroup(groupId: LarkGroupId, name: string): Promise<void>;
  getGroupName(groupId: LarkGroupId): Promise<string>;
  postCard(groupId: LarkGroupId, initialText: string, title: string): Promise<CardId>;
  updateCard(cardId: CardId, text: string, title: string): Promise<void>;
  finalizeCard(
    cardId: CardId,
    text: string,
    title: string,
    processLog?: string,
    runStatus?: RunStatus,
  ): Promise<void>;
  downloadAttachment(opts: {
    messageId: string;
    fileKey: string;
    type: "image" | "file";
    destPath: AbsolutePath;
  }): Promise<void>;
  subscribeInbound(cb: (raw: LarkRawMessage) => void): () => void;
};

export type LarkRawMessage = {
  messageId: string;
  groupId: string;
  userId: string;
  text: string;
  mentionedBot?: boolean;
  attachments: Array<{
    kind: "image" | "file";
    remoteKey: string;
    originalName: string;
    mimeType?: string;
  }>;
  timestampMs: number;
  chatType?: string;
};
