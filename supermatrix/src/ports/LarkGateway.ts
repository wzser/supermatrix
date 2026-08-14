import type { AbsolutePath, CardId, LarkGroupId } from "../domain/ids.ts";
import type { RunStatus } from "./BindingStore.ts";

export type InboundMessageOrigin = "lark_user" | "framework_synthetic";

export type InboundMessage = {
  groupId: LarkGroupId;
  messageId: string;
  userId: string;
  text: string;
  origin?: InboundMessageOrigin;
  mentionedBot?: boolean;
  referencedMessage?: ReferencedMessage;
  attachments: InboundAttachment[];
  receivedAtMs: number;
};

export type ReferencedMessage = {
  messageId: string;
  text?: string;
  senderId?: string;
  senderName?: string;
  timestampMs?: number;
  fetchError?: string;
  parseError?: string;
};

export type InboundAttachment = {
  kind: "image" | "file";
  originalName: string;
  mimeType?: string | undefined;
  fetch(): Promise<{ localPath: AbsolutePath }>;
};

export type InboundHandler = (msg: InboundMessage) => Promise<void>;

/**
 * Feishu card header templates the gateway may render. `violet` exists so
 * non-conversation cards (e.g. kimi autonomous turns) can recolor their
 * completed state away from the ordinary conversation green.
 */
export type CardHeaderTemplate = "blue" | "green" | "red" | "grey" | "violet";

export type DriveCommentFileType = "doc" | "docx" | "sheet" | "file" | "slides" | "bitable";

export type DriveCommentSource = {
  kind: "drive_comment";
  eventId: string;
  fileToken: string;
  fileType: DriveCommentFileType;
  tableId?: string;
  recordId?: string;
  commentId: string;
  replyId?: string;
  fromUserId?: string;
  url?: string;
};

export type DriveCommentContext = {
  text: string;
  quote?: string;
  threadReplies: string[];
  bitableRecord?: {
    tableId?: string;
    recordId?: string;
    fields: Record<string, unknown>;
  };
};

export type DriveCommentReplyInput = {
  source: DriveCommentSource;
  text: string;
};

export type DriveCommentCreateInput = {
  source: DriveCommentSource;
  text: string;
  mentionUserId?: string;
};

export type DriveCommentHandler = (source: DriveCommentSource) => Promise<void>;

export type CreateGroupInput = {
  name: string;
  ownerUserId: string;
};

/** Whose identity Lark should attribute the outbound message to. */
export type LarkPostIdentity = "bot" | "user";

export type LarkGateway = {
  start(handler: InboundHandler): Promise<void>;
  stop(): Promise<void>;
  /**
   * Post a plain text message to `groupId`. When `identity` is omitted the
   * message is sent as the bot (historical behavior). `user` identity routes
   * through the user-scoped lark-cli path and makes the message appear as
   * if the human operator posted it — used by the `user_voice_reporter`
   * child type to drive follow-up actions from a human perspective.
  */
  sendMessage(groupId: LarkGroupId, text: string, identity?: LarkPostIdentity): Promise<void>;
  postCard(groupId: LarkGroupId, initialText: string, title: string): Promise<CardId>;
  updateCard(cardId: CardId, text: string, title: string): Promise<void>;
  /**
   * `processLog`, when provided, is rendered inside a collapsed panel below
   * the main text so the streaming trace stays accessible after the card
   * turns green/red. Pass `undefined` to finalize without the panel.
   *
   * `runStatus` — when provided — is the authoritative signal for card
   * header template (completed → green, timeout/failed → red, cancelled →
   * grey). Without it, the adapter falls back to sniffing the text for a
   * leading ❌, which misreports a run whose final body *starts with* a
   * non-error character but whose terminal status is timeout/cancelled.
   *
   * `completedTemplate` — when provided — replaces only the green
   * "completed" header; failure/cancelled colors are never overridden so an
   * unsuccessful run stays visually loud.
   */
  finalizeCard(
    cardId: CardId,
    text: string,
    title: string,
    processLog?: string,
    runStatus?: RunStatus,
    completedTemplate?: CardHeaderTemplate,
  ): Promise<void>;
  createGroup(input: CreateGroupInput): Promise<LarkGroupId>;
  inviteUser(groupId: LarkGroupId, userId: string): Promise<void>;
  dissolveGroup(groupId: LarkGroupId): Promise<void>;
  renameGroup(groupId: LarkGroupId, name: string): Promise<void>;
  getGroupName(groupId: LarkGroupId): Promise<string>;
  getDriveCommentContext(source: DriveCommentSource): Promise<DriveCommentContext>;
  replyToDriveComment(input: DriveCommentReplyInput): Promise<void>;
  createDriveComment(input: DriveCommentCreateInput): Promise<void>;
};
