import type { AbsolutePath, CardId, LarkGroupId } from "../../domain/ids.ts";
import type { RunStatus } from "../../ports/BindingStore.ts";
import type {
  CardHeaderTemplate,
  DriveCommentContext,
  DriveCommentCreateInput,
  DriveCommentReplyInput,
  DriveCommentSource,
  ReferencedMessage,
} from "../../ports/LarkGateway.ts";

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
    completedTemplate?: CardHeaderTemplate,
  ): Promise<void>;
  downloadAttachment(opts: {
    messageId: string;
    fileKey: string;
    type: "image" | "file";
    destPath: AbsolutePath;
  }): Promise<void>;
  getDriveCommentContext(source: DriveCommentSource): Promise<DriveCommentContext>;
  replyToDriveComment(input: DriveCommentReplyInput): Promise<void>;
  createDriveComment(input: DriveCommentCreateInput): Promise<void>;
  subscribeInbound(cb: (raw: LarkRawInbound) => void): () => void | Promise<void>;
};

export type LarkRawMessage = {
  messageId: string;
  groupId: string;
  userId: string;
  text: string;
  mentionedBot?: boolean;
  referencedMessage?: ReferencedMessage;
  attachments: Array<{
    kind: "image" | "file";
    remoteKey: string;
    originalName: string;
    mimeType?: string;
  }>;
  timestampMs: number;
  chatType?: string;
};

export type LarkRawDriveComment = {
  kind: "drive_comment";
  source: DriveCommentSource;
};

export type LarkRawInbound = LarkRawMessage | LarkRawDriveComment;
